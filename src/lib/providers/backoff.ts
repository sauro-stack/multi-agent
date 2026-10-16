import { clamp } from "@/lib/utils";
import type { RateLimitPolicy } from "@/lib/types";

/**
 * `retry-after` may be a delta in seconds or an absolute HTTP date.
 * Returns milliseconds, or null when the header is absent/unparseable.
 */
export function parseRetryAfter(headers: Headers, headerNames: string[]): number | null {
  for (const name of headerNames) {
    const raw = headers.get(name);
    if (!raw) continue;
    const parsed = parseRetryValue(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function parseRetryValue(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;

  // Plain seconds: "12", "12.5"
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);

  // Go-style durations used by Gemini/Anthropic resets: "1m30s", "950ms", "45s"
  const duration = parseGoDuration(value);
  if (duration !== null) return duration;

  // HTTP-date: "Wed, 21 Oct 2026 07:28:00 GMT"
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());

  return null;
}

/** Parses `1h2m3.5s`, `500ms`, `12s` into milliseconds. */
export function parseGoDuration(value: string): number | null {
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  if (!h && !m && !s && !ms) return null;
  return (
    Number(h ?? 0) * 3_600_000 +
    Number(m ?? 0) * 60_000 +
    Number(s ?? 0) * 1000 +
    Number(ms ?? 0)
  );
}

/**
 * Exponential backoff with full jitter, clamped to the policy ceiling.
 *
 * When the provider told us exactly how long to wait we still add a small
 * safety margin, because `retry-after` is routinely rounded down.
 */
export function computeBackoff(args: {
  attempt: number;
  policy: RateLimitPolicy;
  retryAfterMs?: number | null;
  random?: () => number;
}): number {
  const { attempt, policy } = args;
  const random = args.random ?? Math.random;
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));

  if (args.retryAfterMs && args.retryAfterMs > 0) {
    const margin = args.retryAfterMs * 0.1 + 250;
    return Math.round(clamp(args.retryAfterMs + margin, 250, policy.maxDelayMs));
  }

  const jitter = 1 + (random() * 2 - 1) * policy.jitterRatio;
  return Math.round(clamp(exponential * jitter, 250, policy.maxDelayMs));
}
