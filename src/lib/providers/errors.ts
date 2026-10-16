import { scrubSecrets } from "@/lib/crypto";
import type { ProviderId, RateLimitPolicy } from "@/lib/types";

/** Any non-2xx provider response that is not a throttle. */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status: number;
  readonly retryable: boolean;
  readonly body: string;

  constructor(args: {
    provider: ProviderId;
    status: number;
    message: string;
    retryable?: boolean;
    body?: string;
  }) {
    super(scrubSecrets(args.message));
    this.name = "ProviderError";
    this.provider = args.provider;
    this.status = args.status;
    this.retryable = args.retryable ?? args.status >= 500;
    this.body = scrubSecrets(args.body ?? "").slice(0, 2000);
  }
}

/**
 * Thrown when a provider throttles us. Carries the exact wait the provider
 * asked for (if it said anything) plus the policy we apply on top.
 */
export class RateLimitError extends ProviderError {
  readonly retryAfterMs: number | null;
  readonly policy: RateLimitPolicy;
  readonly source: "status" | "header" | "body" | "network";

  constructor(args: {
    provider: ProviderId;
    message: string;
    retryAfterMs?: number | null;
    policy: RateLimitPolicy;
    status?: number;
    source?: RateLimitError["source"];
    body?: string;
  }) {
    super({
      provider: args.provider,
      status: args.status ?? 429,
      message: args.message,
      retryable: true,
      body: args.body,
    });
    this.name = "RateLimitError";
    this.retryAfterMs = args.retryAfterMs ?? null;
    this.policy = args.policy;
    this.source = args.source ?? "status";
  }
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Human-readable, secret-free description for the UI. */
export function describeError(error: unknown): string {
  if (error instanceof RateLimitError) {
    const wait = error.retryAfterMs ? ` (retry-after ${Math.round(error.retryAfterMs / 1000)}s)` : "";
    return `Rate limited by ${error.provider}${wait}: ${error.message}`;
  }
  if (error instanceof ProviderError) {
    return `${error.provider} error ${error.status}: ${error.message}`;
  }
  if (error instanceof Error) return scrubSecrets(error.message);
  return "Unknown error";
}
