/**
 * Core domain model for the Autonomous Research Lab.
 *
 * This module is deliberately dependency-free so it can be imported from the
 * browser bundle, server routes and the background engine alike.
 */

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "openrouter",
  "simulated",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** How a provider surfaces throttling, and the policy we apply when it does. */
export interface RateLimitPolicy {
  /** HTTP status codes that mean "you are being throttled". */
  statusCodes: number[];
  /** Response headers we read to recover the exact wait time. */
  retryAfterHeaders: string[];
  /** Provider error codes/messages that also mean "throttled" (quota, overloaded). */
  errorPatterns: string[];
  /** Consecutive throttles before an agent is parked in PAUSED_RATE_LIMIT. */
  parkAfter: number;
  /** Exponential backoff base. */
  baseDelayMs: number;
  /** Backoff ceiling. */
  maxDelayMs: number;
  /** Attempts before the cycle is abandoned as failed. */
  maxAttempts: number;
  /** Randomised jitter ratio applied to computed delays (0.25 = ±25%). */
  jitterRatio: number;
}

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** Root of the REST API, overridable per-agent for proxies/gateways. */
  baseUrl: string;
  /** Chat/messages endpoint path relative to `baseUrl`. */
  path: string;
  defaultModel: string;
  models: string[];
  docsUrl: string;
  /** Server-side environment variable consulted when no session key is set. */
  apiKeyEnvVar: string;
  rateLimit: RateLimitPolicy;
  supportsJsonMode: boolean;
  requiresKey: boolean;
  /** Rough ceiling used to trim the room context we send each cycle. */
  maxContextTokens: number;
  /** Tint used by the UI badges. */
  accent: "emerald" | "violet" | "cyan" | "amber" | "rose" | "slate";
  note: string;
}

/* -------------------------------------------------------------------------- */
/* Rooms                                                                      */
/* -------------------------------------------------------------------------- */

export type RoomStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

export interface ResearchRoom {
  id: string;
  slug: string;
  topic: string;
  objective: string;
  status: RoomStatus;
  createdBy: string;
  maxAgents: number;
  /** Max autonomous cycles per agent before it self-terminates. */
  iterationBudget: number;
  /** Milliseconds each agent sleeps between cycles. */
  cycleIntervalMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoomSummary extends ResearchRoom {
  agentCount: number;
  activeAgentCount: number;
  entryCount: number;
  discoveryCount: number;
  lastActivityAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Agents                                                                     */
/* -------------------------------------------------------------------------- */

export type AgentStatus =
  | "IDLE"
  | "RESEARCHING"
  | "PAUSED_RATE_LIMIT"
  | "COMPLETED"
  | "ERROR";

export interface Agent {
  id: string;
  roomId: string;
  sessionId: string | null;
  name: string;
  provider: ProviderId;
  model: string;
  status: AgentStatus;
  /** Total published log entries. */
  contributions: number;
  /** Autonomous cycles completed. */
  iteration: number;
  /** Consecutive rate-limit hits; resets on a successful cycle. */
  throttleStreak: number;
  /** Total 429s observed for this agent. */
  throttleTotal: number;
  /** Last computed backoff in ms (shown in the UI countdown). */
  backoffMs: number;
  /** ISO timestamp the agent is allowed to resume at, if parked. */
  resumeAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Log entries                                                                */
/* -------------------------------------------------------------------------- */

export const LOG_KINDS = [
  "thought_process",
  "experiment_run",
  "key_discovery",
  "next_steps",
  "system",
  "rate_limit",
  "error",
] as const;

export type LogEntryKind = (typeof LOG_KINDS)[number];

/** Kinds that participate in the global discovery graph. */
export const GRAPH_KINDS: LogEntryKind[] = [
  "thought_process",
  "experiment_run",
  "key_discovery",
  "next_steps",
];

export interface LogEntry {
  id: string;
  /** Monotonic per-database sequence — also the SSE Last-Event-ID. */
  seq: number;
  roomId: string;
  agentId: string | null;
  agentName: string;
  provider: ProviderId | null;
  kind: LogEntryKind;
  title: string;
  /** Markdown body. */
  content: string;
  /** Optional fenced code payload rendered as a code block. */
  code: string | null;
  codeLanguage: string | null;
  iteration: number;
  /** Graph parent — the entry this one builds on. */
  parentId: string | null;
  /** 0..1 self-reported confidence, only meaningful for key_discovery. */
  confidence: number | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Jobs / queue                                                               */
/* -------------------------------------------------------------------------- */

export type JobKind = "agent.cycle" | "agent.resume" | "room.fanout";

export type JobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export interface Job<T = Record<string, unknown>> {
  id: string;
  kind: JobKind;
  roomId: string;
  agentId: string | null;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  status: JobStatus;
  priority: number;
  payload: T;
  lastError: string | null;
  createdAt: string;
}

export interface AgentCyclePayload {
  /** Why this cycle was triggered. */
  reason: "schedule" | "join" | "resume" | "manual";
  /** Number of consecutive 429s when the job was scheduled. */
  throttleStreak?: number;
}

/* -------------------------------------------------------------------------- */
/* Provider call layer                                                        */
/* -------------------------------------------------------------------------- */

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderCallOptions {
  apiKey: string;
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a strict JSON object when supported. */
  json?: boolean;
  signal?: AbortSignal;
  /** Override for self-hosted gateways and tests. */
  baseUrl?: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderCallResult {
  text: string;
  model: string;
  provider: ProviderId;
  usage: ProviderUsage;
  latencyMs: number;
  /** Present when the provider reported a rate-limit budget. */
  rateLimitHeaders: Record<string, string>;
  finishReason: string | null;
}

/** Structured shape every agent cycle is asked to produce. */
export interface AgentCycleOutput {
  thought_process: string;
  experiment_run?: {
    title: string;
    method: string;
    code?: string;
    language?: string;
    result: string;
    outcome: "confirmed" | "refuted" | "inconclusive";
  };
  key_discovery?: {
    title: string;
    summary: string;
    confidence: number;
    evidence?: string;
  };
  next_steps: string[];
}

/* -------------------------------------------------------------------------- */
/* SSE stream contract                                                        */
/* -------------------------------------------------------------------------- */

export type StreamEvent =
  | {
      type: "hello";
      roomId: string;
      cursor: number;
      agents: Agent[];
      room: ResearchRoom;
    }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "agent_updated"; agent: Agent }
  | { type: "room_updated"; room: ResearchRoom }
  | { type: "rate_limit"; agent: Agent; retryAfterMs: number; message: string; streak: number }
  | { type: "error"; agentId: string | null; message: string }
  | { type: "heartbeat"; at: string };

export type StreamEventType = StreamEvent["type"];

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProviderCredentialInput {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/** What the browser is ever allowed to know about the key vault. */
export interface SessionPublic {
  id: string;
  agentName: string;
  provider: ProviderId;
  model: string;
  hasKey: boolean;
  /** e.g. `sk-…9f2c` — enough to recognise, useless to abuse. */
  keyHint: string | null;
  keySource: "session" | "server-env" | "simulated";
  createdAt: string;
  expiresAt: string;
}

/* -------------------------------------------------------------------------- */
/* Discovery graph                                                            */
/* -------------------------------------------------------------------------- */

export type DiscoveryNodeStage = "hypothesis" | "experiment" | "discovery" | "next";

export interface DiscoveryNode {
  id: string;
  stage: DiscoveryNodeStage;
  label: string;
  agentId: string | null;
  agentName: string;
  provider: ProviderId | null;
  confidence: number | null;
  iteration: number;
  createdAt: string;
  entry: LogEntry;
}

export interface DiscoveryEdge {
  id: string;
  from: string;
  to: string;
  kind: "spawned" | "verified" | "contradicted" | "continued";
}

export interface DiscoveryGraph {
  nodes: DiscoveryNode[];
  edges: DiscoveryEdge[];
  stats: {
    hypotheses: number;
    experiments: number;
    discoveries: number;
    verified: number;
    refuted: number;
  };
}

/** Badge colour tokens shared by the UI components. */
export type Tone =
  | "default"
  | "active"
  | "warn"
  | "error"
  | "idle"
  | "done"
  | "violet"
  | "cyan"
  | "emerald"
  | "amber"
  | "rose"
  | "slate";

export const AGENT_STATUS_META: Record<
  AgentStatus,
  { label: string; tone: "active" | "warn" | "error" | "idle" | "done"; description: string }
> = {
  IDLE: { label: "idle", tone: "idle", description: "Waiting for the next scheduled cycle" },
  RESEARCHING: { label: "active", tone: "active", description: "Executing an autonomous cycle" },
  PAUSED_RATE_LIMIT: {
    label: "rate-limited",
    tone: "warn",
    description: "Provider throttled — resume job scheduled",
  },
  COMPLETED: { label: "completed", tone: "done", description: "Iteration budget exhausted" },
  ERROR: { label: "error", tone: "error", description: "Last cycle failed" },
};
