import "server-only";

import { scrubSecrets } from "@/lib/crypto";
import { resolveCredential } from "@/lib/lab/sessions";
import {
  getAgent,
  getRoom,
  insertLogEntry,
  latestLogEntries,
  touchRoom,
  updateAgent,
  type AgentPatch,
} from "@/lib/lab/store";
import { computeBackoff } from "@/lib/providers/backoff";
import { callProvider } from "@/lib/providers/call";
import { providerConfig } from "@/lib/providers/config";
import { describeError, isRateLimitError, ProviderError } from "@/lib/providers/errors";
import type {
  Agent,
  AgentCyclePayload,
  LogEntry,
  LogEntryKind,
  ProviderId,
  ResearchRoom,
} from "@/lib/types";
import { formatDuration } from "@/lib/utils";

import { publish } from "./bus";
import { logId } from "./ids";
import { buildCycleMessages, cycleToEntries, normaliseCycleOutput, type CycleContext } from "./prompt";
import { durableQueue } from "./queue";

/**
 * The engine.
 *
 * One `runAgentCycle` call performs exactly one autonomous cycle for one agent
 * and always resolves — it never rejects because of a provider failure. That
 * property is what keeps sibling agents running when one of them is throttled.
 */

export type CycleReason = AgentCyclePayload["reason"];

export interface CycleOutcome {
  agentId: string;
  roomId: string;
  ok: boolean;
  throttled: boolean;
  entries: LogEntry[];
  error?: string;
  retryAfterMs?: number;
  costMs: number;
}

/* -------------------------------------------------------------------------- */
/* Context selection                                                          */
/* -------------------------------------------------------------------------- */

function selectContext(room: ResearchRoom, agent: Agent): CycleContext {
  const recent = latestLogEntries(room.id, 12);
  const fromOthers = recent.filter((entry) => entry.agentId !== agent.id && entry.agentId !== null);

  const reversed = [...fromOthers].reverse();
  const parent =
    reversed.find((entry) => entry.kind === "key_discovery") ??
    reversed.find((entry) => entry.kind === "experiment_run") ??
    (fromOthers.length ? fromOthers[fromOthers.length - 1] : null);

  return { room, agent, recent, parent, cycleIntervalMs: room.cycleIntervalMs };
}

/* -------------------------------------------------------------------------- */
/* Publishing helpers                                                         */
/* -------------------------------------------------------------------------- */

function emitAgent(agent: Agent | null): void {
  if (!agent) return;
  publish(agent.roomId, { type: "agent_updated", agent });
}

function persistEntry(input: Parameters<typeof insertLogEntry>[0]): LogEntry {
  const entry = insertLogEntry(input, logId());
  publish(entry.roomId, { type: "log_entry", entry });
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Room announcements                                                         */
/* -------------------------------------------------------------------------- */

/** Publishes a system entry (join/milestone/reset) to the room feed. */
export function announce(input: {
  roomId: string;
  agentId: string | null;
  agentName: string;
  provider: ProviderId | null;
  kind?: LogEntryKind;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}): LogEntry {
  const entry = persistEntry({
    roomId: input.roomId,
    agentId: input.agentId,
    agentName: input.agentName,
    provider: input.provider,
    kind: input.kind ?? "system",
    title: input.title,
    content: input.content,
    metadata: input.metadata ?? {},
  });
  touchRoom(input.roomId);
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Rate-limit parking                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Parks a single agent, logs the event to the room feed and schedules a resume
 * job. Nothing here throws: a throttled agent is a normal, expected state.
 */
export function parkAgentForRateLimit(args: {
  agent: Agent;
  room: ResearchRoom;
  retryAfterMs: number | null;
  detail: string;
  source: string;
}): { agent: Agent | null; backoffMs: number; exhausted: boolean } {
  const { agent, room } = args;
  const config = providerConfig(agent.provider);
  const attempt = agent.throttleStreak + 1;

  const backoffMs = computeBackoff({
    attempt,
    policy: config.rateLimit,
    retryAfterMs: args.retryAfterMs,
  });

  // Once the policy's attempts are spent we stop scheduling resumes. Keeping
  // `resumeAt` null is what tells the scheduler (and the UI) that this park is
  // deliberate rather than a timed retry.
  const exhausted = attempt >= config.rateLimit.maxAttempts;
  const resumeAt = exhausted ? null : new Date(Date.now() + backoffMs);

  const updated = updateAgent(agent.id, {
    status: "PAUSED_RATE_LIMIT",
    resumeAt,
    backoffMs,
    throttleStreak: attempt,
    throttleTotal: agent.throttleTotal + 1,
    lastError: scrubSecrets(args.detail).slice(0, 500),
  });

  const message = `**${agent.name} hit rate limit. Pausing for ${formatDuration(backoffMs)}…**`;

  persistEntry({
    roomId: room.id,
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.provider,
    kind: "rate_limit",
    title: `${agent.name} → PAUSED_RATE_LIMIT (${formatDuration(backoffMs)})`,
    content: [
      message,
      "",
      `- **Provider:** ${config.label} \`${agent.model}\``,
      `- **Detected via:** ${args.source}${args.retryAfterMs ? ` · provider asked for ${formatDuration(args.retryAfterMs)}` : ""}`,
      `- **Consecutive throttles:** ${attempt}`,
      `- **Backoff applied:** ${formatDuration(backoffMs)} (attempt ${attempt}, ceiling ${formatDuration(config.rateLimit.maxDelayMs)})`,
      exhausted
        ? `- **Resume:** not scheduled — ${attempt}/${config.rateLimit.maxAttempts} attempts spent. Resume manually from the agent grid.`
        : `- **Resume scheduled:** ${resumeAt?.toISOString()}`,
      `- **Detail:** ${scrubSecrets(args.detail).slice(0, 400)}`,
      "",
      "Other agents in this room are unaffected and keep iterating.",
    ].join("\n"),
    latencyMs: 0,
    metadata: {
      retryAfterMs: args.retryAfterMs,
      backoffMs,
      attempt,
      source: args.source,
      provider: agent.provider,
      exhausted,
    },
  });

  if (updated) {
    publish(room.id, {
      type: "rate_limit",
      agent: updated,
      retryAfterMs: backoffMs,
      message: `[${agent.name}] hit rate limit. Pausing for ${formatDuration(backoffMs)}...`,
      streak: attempt,
    });
    emitAgent(updated);
  }

  if (!exhausted) {
    durableQueue.enqueue({
      kind: "agent.resume",
      roomId: room.id,
      agentId: agent.id,
      delayMs: backoffMs,
      maxAttempts: 1,
      priority: 1,
      payload: { reason: "resume", throttleStreak: attempt },
    });
  } else {
    // The provider is clearly not going to let us through. Park deliberately
    // and leave a marker in the feed instead of looping forever.
    persistEntry({
      roomId: room.id,
      agentId: agent.id,
      agentName: agent.name,
      provider: agent.provider,
      kind: "system",
      title: `${agent.name} backoff ceiling reached`,
      content: `Gave up after ${attempt} consecutive throttles from ${config.label}. No further resume jobs will be scheduled; the agent stays parked until a human resumes it from the agent grid.`,
      metadata: { kind: "backoff_exhausted", attempt, backoffMs },
    });
  }

  return { agent: updated, backoffMs, exhausted };
}

/* -------------------------------------------------------------------------- */
/* Cycle                                                                      */
/* -------------------------------------------------------------------------- */

export async function runAgentCycle(agentId: string, reason: CycleReason): Promise<CycleOutcome> {
  const started = Date.now();
  const agent = getAgent(agentId);
  if (!agent) {
    return { agentId, roomId: "unknown", ok: false, throttled: false, entries: [], error: "Agent not found", costMs: 0 };
  }

  const room = getRoom(agent.roomId);
  if (!room) {
    return { agentId, roomId: agent.roomId, ok: false, throttled: false, entries: [], error: "Room not found", costMs: 0 };
  }

  if (room.status !== "ACTIVE") {
    return { agentId, roomId: room.id, ok: false, throttled: false, entries: [], error: `Room is ${room.status}`, costMs: 0 };
  }

  if (agent.status === "COMPLETED") {
    return { agentId, roomId: room.id, ok: false, throttled: false, entries: [], error: "Agent already completed its budget", costMs: 0 };
  }

  // Guard against a duplicate job racing an in-flight cycle.
  if (agent.status === "RESEARCHING") {
    return { agentId, roomId: room.id, ok: false, throttled: false, entries: [], error: "Cycle already in flight", costMs: 0 };
  }

  const config = providerConfig(agent.provider);
  const researching = updateAgent(agent.id, { status: "RESEARCHING" });
  emitAgent(researching);

  const working = researching ?? agent;
  const ctx = selectContext(room, working);
  const messages = buildCycleMessages(ctx);

  let credential: ReturnType<typeof resolveCredential>;
  try {
    credential = resolveCredential(working);
  } catch (error) {
    const message = describeError(error);
    updateAgent(working.id, { status: "ERROR", lastError: message });
    persistEntry({
      roomId: room.id,
      agentId: working.id,
      agentName: working.name,
      provider: working.provider,
      kind: "error",
      title: `${working.name} cannot start: credential problem`,
      content: message,
      metadata: { phase: "resolve_credential" },
    });
    emitAgent(getAgent(working.id));
    return { agentId, roomId: room.id, ok: false, throttled: false, entries: [], error: message, costMs: Date.now() - started };
  }

  // Retryable transport/5xx failures are retried in-cycle; throttles are not.
  let attempt = 0;
  let result: Awaited<ReturnType<typeof callProvider>> | null = null;
  let lastError: unknown = null;

  while (attempt < 3 && !result) {
    attempt += 1;
    try {
      result = await callProvider(working.provider, {
        apiKey: credential.apiKey,
        model: credential.model,
        baseUrl: credential.baseUrl ?? undefined,
        messages,
        temperature: 0.6,
        maxTokens: 2400,
        json: true,
      });
    } catch (error) {
      lastError = error;

      if (isRateLimitError(error)) {
        const parked = parkAgentForRateLimit({
          agent: working,
          room,
          retryAfterMs: error.retryAfterMs,
          detail: error.message,
          source: error.source,
        });
        return {
          agentId,
          roomId: room.id,
          ok: false,
          throttled: true,
          entries: [],
          error: describeError(error),
          retryAfterMs: parked.backoffMs,
          costMs: Date.now() - started,
        };
      }

      const retryable = error instanceof ProviderError ? error.retryable : true;
      if (!retryable || attempt >= 3) break;

      const wait = Math.min(config.rateLimit.baseDelayMs * 2 ** (attempt - 1), 15_000);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  if (!result) {
    const message = describeError(lastError);
    const retryable = lastError instanceof ProviderError ? lastError.retryable : true;
    updateAgent(working.id, { status: "ERROR", lastError: message });
    persistEntry({
      roomId: room.id,
      agentId: working.id,
      agentName: working.name,
      provider: working.provider,
      kind: "error",
      title: `${working.name} cycle failed`,
      content: [`${message}`, "", retryable ? `Retried ${attempt - 1}× in-cycle before giving up.` : "Non-retryable — check the credential and model name."].join("\n"),
      metadata: { attempts: attempt, retryable, phase: "provider_call" },
    });
    emitAgent(getAgent(working.id));

    // A retryable failure gets one delayed job; the agent will pick itself back up.
    if (retryable) {
      durableQueue.enqueue({
        kind: "agent.cycle",
        roomId: room.id,
        agentId: working.id,
        delayMs: 20_000,
        maxAttempts: 2,
        payload: { reason: "schedule" },
      });
    }

    return { agentId, roomId: room.id, ok: false, throttled: false, entries: [], error: message, costMs: Date.now() - started };
  }

  /* ----- success path ---------------------------------------------------- */

  const output = normaliseCycleOutput(result.text);
  const pending = cycleToEntries(output, ctx);
  const idBySlot = new Map<string, string>();
  const contextEntryIds = ctx.recent.slice(-4).map((entry) => entry.id);

  const persisted: LogEntry[] = [];
  for (const item of pending) {
    let parentId: string | null = null;
    if (item.parentSlot) {
      parentId = item.parentSlot.startsWith("ext:")
        ? item.parentSlot.slice(4)
        : (idBySlot.get(item.parentSlot) ?? ctx.parent?.id ?? null);
    }

    const entry = persistEntry({
      roomId: room.id,
      agentId: working.id,
      agentName: working.name,
      provider: working.provider,
      kind: item.kind,
      title: item.title,
      content: item.content,
      code: item.code ?? null,
      codeLanguage: item.codeLanguage ?? null,
      iteration: working.iteration + 1,
      parentId,
      confidence: item.confidence ?? null,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      latencyMs: result.latencyMs,
      metadata: {
        cycleReason: reason,
        outcome: item.outcome ?? null,
        model: result.model,
        provider: result.provider,
        credentialSource: credential.source,
        contextEntryIds,
        rateLimitHeaders: result.rateLimitHeaders,
      },
    });

    idBySlot.set(item.slot, entry.id);
    persisted.push(entry);
  }

  const nextIteration = working.iteration + 1;
  const finished = nextIteration >= room.iterationBudget;

  const patch: AgentPatch = {
    status: finished ? "COMPLETED" : "IDLE",
    contributions: working.contributions + persisted.length,
    iteration: nextIteration,
    throttleStreak: 0,
    backoffMs: 0,
    resumeAt: null,
    lastError: null,
  };

  const updated = updateAgent(working.id, patch);
  touchRoom(room.id);
  emitAgent(updated);

  if (updated && !finished) {
    durableQueue.enqueue({
      kind: "agent.cycle",
      roomId: room.id,
      agentId: updated.id,
      delayMs: cycleDelayMs(room.cycleIntervalMs),
      maxAttempts: 3,
      payload: { reason: "schedule" },
    });
  }

  if (updated && finished) {
    persistEntry({
      roomId: room.id,
      agentId: updated.id,
      agentName: updated.name,
      provider: updated.provider,
      kind: "system",
      title: `${updated.name} completed its iteration budget`,
      content: `Reached ${nextIteration}/${room.iterationBudget} autonomous cycles with ${updated.contributions} contributions. The agent is now COMPLETED.`,
      metadata: { kind: "budget_exhausted", iteration: nextIteration },
    });
  }

  return {
    agentId,
    roomId: room.id,
    ok: true,
    throttled: false,
    entries: persisted,
    costMs: Date.now() - started,
  };
}

/**
 * Resumes an agent parked by a throttle.
 *
 * `manual` is set when a human clicks resume: that clears the consecutive
 * throttle streak so the agent gets a fresh set of backoff attempts. The
 * scheduled resume job deliberately keeps the streak, which is what makes the
 * backoff escalate towards the policy ceiling.
 */
export function resumeAgent(agentId: string, options: { manual?: boolean } = {}): {
  resumed: boolean;
  reason: string;
} {
  const agent = getAgent(agentId);
  if (!agent) return { resumed: false, reason: "Agent not found" };
  if (agent.status !== "PAUSED_RATE_LIMIT") {
    return { resumed: false, reason: `Agent is ${agent.status}, nothing to resume` };
  }

  const updated = updateAgent(agentId, {
    status: "IDLE",
    resumeAt: null,
    backoffMs: 0,
    ...(options.manual ? { throttleStreak: 0, lastError: null } : {}),
  });
  emitAgent(updated);

  durableQueue.enqueue({
    kind: "agent.cycle",
    roomId: agent.roomId,
    agentId,
    delayMs: 0,
    maxAttempts: 3,
    priority: 2,
    payload: { reason: "resume" },
  });

  return { resumed: true, reason: "Resume job enqueued" };
}

/**
 * Kicks off the first cycle for a freshly joined agent.
 *
 * The small random start delay desynchronises agents that join together. In
 * lockstep they all reach a provider's per-minute bucket at the same moment
 * and get throttled as one, which is exactly the thundering-herd behaviour a
 * swarm should avoid.
 */
export function startAgent(agentId: string): void {
  const agent = getAgent(agentId);
  if (!agent) return;
  durableQueue.enqueue({
    kind: "agent.cycle",
    roomId: agent.roomId,
    agentId,
    delayMs: Math.round(Math.random() * 2000),
    maxAttempts: 3,
    priority: 1,
    payload: { reason: "join" },
  });
}

/** Spreads scheduled cycles so the swarm does not move in lockstep. */
export function cycleDelayMs(intervalMs: number): number {
  const jitter = 1 + (Math.random() * 2 - 1) * 0.15;
  return Math.max(1000, Math.round(intervalMs * jitter));
}

export function pauseAgent(agent: { id: string; roomId: string; provider: ProviderId }): Agent | null {
  // `resumeAt: null` marks this park as deliberate, so the scheduler's resume
  // sweep will leave the agent alone until a human resumes it.
  const updated = updateAgent(agent.id, {
    status: "PAUSED_RATE_LIMIT",
    resumeAt: null,
    backoffMs: 0,
    lastError: "Manually paused",
  });
  emitAgent(updated);
  return updated;
}
