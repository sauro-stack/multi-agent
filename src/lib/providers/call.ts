import "server-only";

import type {
  ProviderCallOptions,
  ProviderCallResult,
  ProviderConfig,
  ProviderId,
} from "@/lib/types";

import { parseGoDuration, parseRetryAfter } from "./backoff";
import { providerConfig } from "./config";
import { ProviderError, RateLimitError } from "./errors";
import { callSimulated } from "./simulated";

/**
 * One function to call any supported provider.
 *
 * Responsibilities kept deliberately narrow so the engine stays provider
 * agnostic:
 *  - shape the request for the vendor's REST surface,
 *  - normalise the response into `ProviderCallResult`,
 *  - translate throttling into a typed `RateLimitError` carrying the exact
 *    wait the provider requested.
 */

const RATE_LIMIT_HEADER_NAMES = [
  "retry-after",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-reset",
];

function captureHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

function extractMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed?.error as Record<string, unknown> | string | undefined;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && typeof error.message === "string") return error.message;
    if (typeof parsed?.message === "string") return parsed.message;
    if (typeof parsed?.detail === "string") return parsed.detail;
  } catch {
    /* not JSON */
  }
  const flat = body.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 300) : null;
}

/** Gemini surfaces the wait inside the body: `"retryDelay": "12s"`. */
function retryDelayFromBody(body: string): number | null {
  const match = body.match(/"retryDelay"\s*:\s*"([^"]+)"/);
  if (match) return parseGoDuration(match[1]);
  const reset = body.match(/"retry_after"\s*:\s*"?(\d+)/);
  if (reset) return Number(reset[1]) * 1000;
  return null;
}

interface ThrottleInput {
  provider: ProviderId;
  status: number;
  headers: Headers;
  body: string;
  policy: ProviderConfig["rateLimit"];
}

function detectThrottle(input: ThrottleInput): RateLimitError | null {
  const { provider, status, headers, body, policy } = input;
  const lowered = body.toLowerCase();
  const matchedPattern = policy.errorPatterns.find((p) => lowered.includes(p.toLowerCase()));

  const isStatusThrottle = policy.statusCodes.includes(status);
  const isQuotaThrottle =
    (status === 402 || status === 403 || status === 400) && Boolean(matchedPattern);

  if (!isStatusThrottle && !isQuotaThrottle) return null;

  const fromHeader = parseRetryAfter(headers, policy.retryAfterHeaders);
  const fromBody = fromHeader ?? retryDelayFromBody(body);
  const retryAfterMs = fromBody ?? null;

  return new RateLimitError({
    provider,
    status,
    message: extractMessage(body) ?? `HTTP ${status} from ${provider}`,
    retryAfterMs,
    policy,
    source: fromHeader ? "header" : fromBody ? "body" : "status",
    body,
  });
}

function assertOk(
  provider: ProviderId,
  res: Response,
  body: string,
  policy: ProviderConfig["rateLimit"],
): void {
  if (res.ok) return;

  const throttle = detectThrottle({ provider, status: res.status, headers: res.headers, body, policy });
  if (throttle) throw throttle;

  throw new ProviderError({
    provider,
    status: res.status,
    message: extractMessage(body) ?? `HTTP ${res.status}`,
    body,
  });
}

async function safeFetch(
  provider: ProviderId,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    // Network/DNS/abort problems are retryable transport failures, not 429s.
    const message = error instanceof Error ? error.message : "network failure";
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError({ provider, status: 499, message: "Request aborted", retryable: true });
    }
    throw new ProviderError({
      provider,
      status: 0,
      message: `Transport error: ${message}`,
      retryable: true,
    });
  }
}

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/* -------------------------------------------------------------------------- */
/* OpenAI-compatible surface: OpenAI, Groq, OpenRouter                        */
/* -------------------------------------------------------------------------- */

async function callOpenAICompatible(
  config: ProviderConfig,
  options: ProviderCallOptions,
): Promise<ProviderCallResult> {
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const started = Date.now();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
  };
  if (config.id === "openrouter") {
    headers["http-referer"] = process.env.LAB_PUBLIC_ORIGIN ?? "https://autonomous-research-lab.local";
    headers["x-title"] = "Autonomous Research Lab";
  }

  const payload: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.7,
  };
  if (options.maxTokens) payload.max_tokens = options.maxTokens;
  if (options.json && config.supportsJsonMode) payload.response_format = { type: "json_object" };

  const res = await safeFetch(config.id, joinBaseUrl(baseUrl, config.path), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  const body = await res.text();
  assertOk(config.id, res, body, config.rateLimit);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new ProviderError({
      provider: config.id,
      status: res.status,
      message: "Provider returned a non-JSON response",
      retryable: true,
      body,
    });
  }

  const choices = (parsed.choices as Array<Record<string, unknown>> | undefined) ?? [];
  const first = choices[0] ?? {};
  const message = (first.message as Record<string, unknown> | undefined) ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const usage = (parsed.usage as Record<string, unknown> | undefined) ?? {};

  if (!text) {
    throw new ProviderError({
      provider: config.id,
      status: res.status,
      message: "Empty completion returned",
      retryable: true,
      body,
    });
  }

  return {
    text,
    model: typeof parsed.model === "string" ? parsed.model : options.model,
    provider: config.id,
    usage: {
      inputTokens: Number(usage.prompt_tokens ?? 0),
      outputTokens: Number(usage.completion_tokens ?? 0),
    },
    latencyMs: Date.now() - started,
    rateLimitHeaders: captureHeaders(res.headers),
    finishReason: typeof first.finish_reason === "string" ? first.finish_reason : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

async function callAnthropic(
  config: ProviderConfig,
  options: ProviderCallOptions,
): Promise<ProviderCallResult> {
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const started = Date.now();
  const system = options.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = options.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await safeFetch(config.id, joinBaseUrl(baseUrl, config.path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages: turns.length ? turns : [{ role: "user", content: "Continue the research cycle." }],
    }),
    signal: options.signal,
  });

  const body = await res.text();
  assertOk(config.id, res, body, config.rateLimit);

  const parsed = JSON.parse(body) as Record<string, unknown>;
  const content = (parsed.content as Array<Record<string, unknown>> | undefined) ?? [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("")
    .trim();

  const usage = (parsed.usage as Record<string, unknown> | undefined) ?? {};
  if (!text) {
    throw new ProviderError({
      provider: config.id,
      status: res.status,
      message: "Empty completion returned",
      retryable: true,
      body,
    });
  }

  return {
    text,
    model: typeof parsed.model === "string" ? parsed.model : options.model,
    provider: config.id,
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
    },
    latencyMs: Date.now() - started,
    rateLimitHeaders: captureHeaders(res.headers),
    finishReason: typeof parsed.stop_reason === "string" ? parsed.stop_reason : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Gemini                                                                     */
/* -------------------------------------------------------------------------- */

async function callGemini(
  config: ProviderConfig,
  options: ProviderCallOptions,
): Promise<ProviderCallResult> {
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const started = Date.now();
  const path = config.path.replace("{model}", encodeURIComponent(options.model));
  const url = `${joinBaseUrl(baseUrl, path)}?key=${encodeURIComponent(options.apiKey)}`;

  const system = options.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = options.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  const res = await safeFetch(config.id, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: contents.length ? contents : [{ role: "user", parts: [{ text: "Continue." }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 2048,
        ...(options.json && config.supportsJsonMode ? { responseMimeType: "application/json" } : {}),
      },
    }),
    signal: options.signal,
  });

  const body = await res.text();
  assertOk(config.id, res, body, config.rateLimit);

  const parsed = JSON.parse(body) as Record<string, unknown>;
  const candidates = (parsed.candidates as Array<Record<string, unknown>> | undefined) ?? [];
  const parts =
    ((candidates[0]?.content as Record<string, unknown> | undefined)?.parts as
      | Array<Record<string, unknown>>
      | undefined) ?? [];
  const text = parts.map((p) => String(p.text ?? "")).join("").trim();
  const usage = (parsed.usageMetadata as Record<string, unknown> | undefined) ?? {};

  if (!text) {
    throw new ProviderError({
      provider: config.id,
      status: res.status,
      message: "Empty completion returned",
      retryable: true,
      body,
    });
  }

  return {
    text,
    model: options.model,
    provider: config.id,
    usage: {
      inputTokens: Number(usage.promptTokenCount ?? 0),
      outputTokens: Number(usage.candidatesTokenCount ?? 0),
    },
    latencyMs: Date.now() - started,
    rateLimitHeaders: captureHeaders(res.headers),
    finishReason: typeof candidates[0]?.finishReason === "string" ? String(candidates[0].finishReason) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export async function callProvider(
  provider: ProviderId,
  options: ProviderCallOptions,
): Promise<ProviderCallResult> {
  const config = providerConfig(provider);

  if (!config.requiresKey && !options.apiKey) {
    return callSimulated(config, options);
  }

  if (!options.apiKey) {
    throw new ProviderError({
      provider,
      status: 401,
      message: `No API key available for ${config.label}. Add one in the session setup, or set ${config.apiKeyEnvVar} on the server.`,
      retryable: false,
    });
  }

  switch (provider) {
    case "simulated":
      return callSimulated(config, options);
    case "anthropic":
      return callAnthropic(config, options);
    case "gemini":
      return callGemini(config, options);
    case "openai":
    case "groq":
    case "openrouter":
      return callOpenAICompatible(config, options);
    default:
      throw new ProviderError({
        provider,
        status: 400,
        message: `Unsupported provider: ${provider}`,
        retryable: false,
      });
  }
}
