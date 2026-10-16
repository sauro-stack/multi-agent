import type { ProviderConfig, ProviderId, RateLimitPolicy } from "@/lib/types";

/**
 * Static capability + rate-limit metadata for every supported provider.
 *
 * The `rateLimit` block is the single place that encodes how each vendor
 * signals throttling, so the engine never has provider-specific branches.
 */

const DEFAULT_POLICY: RateLimitPolicy = {
  statusCodes: [429],
  retryAfterHeaders: ["retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"],
  errorPatterns: ["rate limit", "too many requests", "quota exceeded", "overloaded"],
  parkAfter: 1,
  baseDelayMs: 4000,
  maxDelayMs: 5 * 60_000,
  maxAttempts: 4,
  jitterRatio: 0.25,
};

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    path: "/chat/completions",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o4-mini", "gpt-5-mini"],
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
    apiKeyEnvVar: "OPENAI_API_KEY",
    rateLimit: {
      ...DEFAULT_POLICY,
      retryAfterHeaders: [
        "retry-after",
        "x-ratelimit-reset-requests",
        "x-ratelimit-reset-tokens",
        "x-ratelimit-reset-request",
      ],
      errorPatterns: [
        "rate limit",
        "too many requests",
        "insufficient_quota",
        "tokens per min",
        "requests per min",
      ],
    },
    supportsJsonMode: true,
    requiresKey: true,
    maxContextTokens: 128_000,
    accent: "emerald",
    note: "Chat Completions. Uses response_format=json_object for structured cycles.",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    path: "/v1/messages",
    defaultModel: "claude-sonnet-4-20250514",
    models: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-3-5-haiku-20241022",
      "claude-3-7-sonnet-20250219",
    ],
    docsUrl: "https://docs.anthropic.com/en/api/messages",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    rateLimit: {
      ...DEFAULT_POLICY,
      retryAfterHeaders: [
        "retry-after",
        "anthropic-ratelimit-requests-reset",
        "anthropic-ratelimit-tokens-reset",
        "anthropic-ratelimit-input-tokens-reset",
      ],
      errorPatterns: ["rate limit", "overloaded_error", "too many requests"],
    },
    supportsJsonMode: false,
    requiresKey: true,
    maxContextTokens: 200_000,
    accent: "violet",
    note: "Messages API. System prompt is passed out-of-band; JSON enforced via prompt.",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    path: "/v1beta/models/{model}:generateContent",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-flash"],
    docsUrl: "https://ai.google.dev/api/generate-content",
    apiKeyEnvVar: "GEMINI_API_KEY",
    rateLimit: {
      ...DEFAULT_POLICY,
      errorPatterns: ["resource_exhausted", "quota", "rate limit", "too many requests"],
    },
    supportsJsonMode: true,
    requiresKey: true,
    maxContextTokens: 1_000_000,
    accent: "cyan",
    note: "generateContent. Key is sent as a query param; RetryInfo gives exact delays.",
  },
  groq: {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    path: "/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "moonshotai/kimi-k2-instruct",
      "deepseek-r1-distill-llama-70b",
    ],
    docsUrl: "https://console.groq.com/docs/api-reference",
    apiKeyEnvVar: "GROQ_API_KEY",
    rateLimit: {
      ...DEFAULT_POLICY,
      retryAfterHeaders: ["retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"],
      errorPatterns: ["rate limit", "too many requests", "tokens per minute"],
    },
    supportsJsonMode: true,
    requiresKey: true,
    maxContextTokens: 128_000,
    accent: "amber",
    note: "OpenAI-compatible surface. Very aggressive per-minute buckets.",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    path: "/chat/completions",
    defaultModel: "anthropic/claude-3.5-sonnet",
    models: [
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o-mini",
      "google/gemini-flash-1.5",
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-chat",
    ],
    docsUrl: "https://openrouter.ai/docs/api-reference/overview",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    rateLimit: {
      ...DEFAULT_POLICY,
      errorPatterns: ["rate limit", "too many requests", "quota", "insufficient credits"],
    },
    supportsJsonMode: true,
    requiresKey: true,
    maxContextTokens: 200_000,
    accent: "rose",
    note: "Aggregator. Upstream 429s are proxied through verbatim.",
  },
  simulated: {
    id: "simulated",
    label: "Lab Simulator",
    baseUrl: "local://simulator",
    path: "/generate",
    defaultModel: "lab-sim-1",
    models: ["lab-sim-1", "lab-sim-1-fast"],
    docsUrl: "https://github.com/",
    apiKeyEnvVar: "LAB_SIMULATED_KEY",
    rateLimit: {
      ...DEFAULT_POLICY,
      // The simulator deliberately emits real 429 semantics so the pause/resume
      // path can be exercised without burning provider quota.
      baseDelayMs: 8000,
      maxDelayMs: 60_000,
      parkAfter: 1,
      maxAttempts: 6,
    },
    supportsJsonMode: true,
    requiresKey: false,
    maxContextTokens: 32_000,
    accent: "slate",
    note: "Deterministic offline model. Replays the full agent loop and injects 429s.",
  },
};

export const SELECTABLE_PROVIDERS: ProviderId[] = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "openrouter",
  "simulated",
];

export function providerConfig(id: string): ProviderConfig {
  return PROVIDERS[id as ProviderId] ?? PROVIDERS.openai;
}

export function isProviderId(value: string): value is ProviderId {
  return value in PROVIDERS;
}
