#!/usr/bin/env node
/**
 * Local OpenAI-compatible mock endpoint.
 *
 * Exists so the rate-limit path can be verified against a **real** HTTP 429 and
 * a real `retry-after` header, through the unmodified provider client, without
 * touching a paid provider. Point a session at it:
 *
 *   POST /api/session { provider: "openai", baseUrl: "http://127.0.0.1:4599/v1", ... }
 *
 *   MOCK_THROTTLE_FIRST=1   # 429 for the first N calls, then 200
 *   MOCK_RETRY_AFTER=2      # value of the retry-after header
 *   MOCK_PORT=4599
 */

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4599);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";
const THROTTLE_FIRST = Number(process.env.MOCK_THROTTLE_FIRST ?? 1);
// Empty string omits every retry hint, which forces the exponential-backoff
// branch instead of the provider-supplied delay.
const RETRY_AFTER = process.env.MOCK_RETRY_AFTER ?? "2";
const SEND_RETRY_HINTS = RETRY_AFTER.trim().length > 0;

let calls = 0;
/**
 * Throttle counters are scoped per room (the ROOM_TOPIC in the prompt) so the
 * harness is repeatable: every run creates a fresh room with a unique topic and
 * therefore gets its own deterministic 429. Set MOCK_THROTTLE_SCOPE=process to
 * fall back to a single global counter.
 */
const counters = new Map();
const SCOPE = process.env.MOCK_THROTTLE_SCOPE ?? "room";

function cyclePayload(topic) {
  return JSON.stringify(
    {
      thought_process: `Cycle on "${topic}". Reading the shared log; the previous entry is the only signal so far, so I will try to falsify it rather than extend it.`,
      experiment_run: {
        title: "Mock ablation against the room baseline",
        method: "Matched-compute ablation with paired bootstrap over 8 seeds.",
        code: 'def probe(x):\n    """mock experiment"""\n    return x.mean() > 0\n',
        language: "python",
        result: "Effect present on 7/8 seeds; confidence interval excludes zero.",
        outcome: "confirmed",
      },
      key_discovery: {
        title: "Mock discovery confirmed by an independent seed block",
        summary: "The effect reproduces under a held-out seed block, so it is promoted from hypothesis to finding.",
        confidence: 0.78,
        evidence: "8-seed paired bootstrap",
      },
      next_steps: ["Widen the seed block", "Ask another agent to replicate"],
    },
    null,
    2,
  );
}

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    calls += 1;

    if (!request.url?.includes("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    // Parse the JSON envelope first: the prompt's newlines are escaped in the
    // wire format, so matching the raw body would swallow the whole request and
    // make every call look like a different scope.
    let prompt = body;
    try {
      const payload = JSON.parse(body);
      if (Array.isArray(payload?.messages)) {
        prompt = payload.messages.map((message) => message.content ?? "").join("\n");
      }
    } catch {
      /* fall back to the raw body */
    }

    const topic = prompt.match(/^\s*ROOM_TOPIC:\s*(.+)$/m)?.[1]?.trim() ?? "unknown-room";
    const scopeKey = SCOPE === "process" ? "__process__" : topic;
    const scopedCalls = (counters.get(scopeKey) ?? 0) + 1;
    counters.set(scopeKey, scopedCalls);

    if (scopedCalls <= THROTTLE_FIRST) {
      response.writeHead(429, {
        "content-type": "application/json",
        "x-ratelimit-remaining-requests": "0",
        ...(SEND_RETRY_HINTS
          ? { "retry-after": RETRY_AFTER, "x-ratelimit-reset-requests": `${RETRY_AFTER}s` }
          : {}),
      });
      response.end(
        JSON.stringify({
          error: {
            message:
              "Rate limit reached for gpt-4o-mini in organization org-mock on requests per min (RPM): Limit 500, Used 500.",
            type: "requests",
            code: "rate_limit_exceeded",
          },
        }),
      );
      console.log(
        `[mock] call ${calls} -> 429 (${SEND_RETRY_HINTS ? `retry-after: ${RETRY_AFTER}` : "no retry hints — exponential fallback"}) [scope: ${scopeKey.slice(0, 40)}]`,
      );
      return;
    }

    response.writeHead(200, {
      "content-type": "application/json",
      "x-ratelimit-remaining-requests": "499",
    });
    response.end(
      JSON.stringify({
        id: `chatcmpl-mock-${calls}`,
        object: "chat.completion",
        model: "gpt-4o-mini",
        choices: [
          { index: 0, message: { role: "assistant", content: cyclePayload(topic) }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1180, completion_tokens: 296 },
      }),
    );
    console.log(`[mock] call ${calls} -> 200 [scope: ${scopeKey.slice(0, 40)}]`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `[mock] openai-compatible endpoint on http://${HOST}:${PORT}/v1  ` +
      `(429 for first ${THROTTLE_FIRST} call(s) per ${SCOPE}, ${SEND_RETRY_HINTS ? `retry-after ${RETRY_AFTER}` : "no retry hints"})`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[mock] ${signal} received after ${calls} call(s), shutting down`);
    server.close(() => process.exit(0));
  });
}
