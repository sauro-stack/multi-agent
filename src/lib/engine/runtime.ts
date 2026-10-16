import "server-only";

import { scrubSecrets } from "@/lib/crypto";
import {
  countQueuedJobs,
  hasPendingJob,
  listAgents,
  listAgentsNeedingResume,
  listRooms,
  requeueStaleJobs,
  touchRoom,
} from "@/lib/lab/store";
import type { AgentCyclePayload, Job } from "@/lib/types";
import { formatDuration } from "@/lib/utils";

import { resumeAgent, runAgentCycle, type CycleReason } from "./agent-loop";
import { durableQueue } from "./queue";

/**
 * The scheduler.
 *
 * `LAB_RUNTIME=inline` (default): an in-process tick loop drives the queue,
 * which is what a long-lived Node/Next server wants.
 * `LAB_RUNTIME=external`: nothing runs on its own; a cron/worker calls
 * `POST /api/tick` instead — the serverless deployment shape.
 */

const TICK_INTERVAL_MS = 1000;
const CLAIM_BATCH = 8;
const MAX_CONCURRENT_CYCLES = Number(process.env.LAB_MAX_CONCURRENCY ?? 4);

export interface RuntimeStatus {
  runtime: "inline" | "external";
  booted: boolean;
  bootedAt: string | null;
  ticks: number;
  lastTickAt: string | null;
  inflight: number;
  queuedJobs: number;
  lastError: string | null;
}

interface RuntimeState {
  booted: boolean;
  bootedAt: number | null;
  ticks: number;
  lastTickAt: number | null;
  timer: NodeJS.Timeout | null;
  inflight: Map<string, Promise<void>>;
  busyAgents: Set<string>;
  lastError: string | null;
  ticking: boolean;
}

const globalRef = globalThis as unknown as { __arlRuntime?: RuntimeState };

function state(): RuntimeState {
  if (!globalRef.__arlRuntime) {
    globalRef.__arlRuntime = {
      booted: false,
      bootedAt: null,
      ticks: 0,
      lastTickAt: null,
      timer: null,
      inflight: new Map(),
      busyAgents: new Set(),
      lastError: null,
      ticking: false,
    };
  }
  return globalRef.__arlRuntime;
}

function runtimeMode(): "inline" | "external" {
  return process.env.LAB_RUNTIME === "external" ? "external" : "inline";
}

function payloadReason(job: Job): CycleReason {
  const payload = job.payload as Partial<AgentCyclePayload>;
  const reason = payload?.reason;
  return reason === "join" || reason === "resume" || reason === "manual" || reason === "schedule"
    ? reason
    : "schedule";
}

/* -------------------------------------------------------------------------- */
/* Job dispatch                                                               */
/* -------------------------------------------------------------------------- */

async function handleJob(job: Job): Promise<void> {
  const rt = state();

  switch (job.kind) {
    case "agent.resume": {
      // A skipped resume is routine (the agent was already picked up by the
      // sweep, or a human resumed it) — not a runtime error.
      resumeAgent(job.agentId ?? "");
      durableQueue.succeed(job.id);
      return;
    }
    case "room.fanout": {
      fanOutRoom(job.roomId);
      durableQueue.succeed(job.id);
      return;
    }
    case "agent.cycle": {
      if (!job.agentId) {
        durableQueue.fail(job.id, "agent.cycle job without agentId", job.attempts);
        return;
      }
      if (rt.busyAgents.has(job.agentId)) {
        // Someone else is already running this agent; come back shortly.
        durableQueue.retry(job.id, 2000, "agent busy", job.attempts);
        return;
      }

      rt.busyAgents.add(job.agentId);
      try {
        const outcome = await runAgentCycle(job.agentId, payloadReason(job));

        if (outcome.ok || outcome.throttled) {
          // A throttle is a handled state, not a job failure: the resume job
          // was already scheduled by the loop.
          durableQueue.succeed(job.id);
        } else if (
          outcome.error?.includes("already completed") ||
          outcome.error?.includes("Room is") ||
          outcome.error?.includes("not found")
        ) {
          durableQueue.succeed(job.id);
        } else if (job.attempts + 1 < job.maxAttempts) {
          durableQueue.retry(job.id, 15_000, outcome.error ?? "cycle failed", job.attempts + 1);
        } else {
          durableQueue.fail(job.id, outcome.error ?? "cycle failed", job.attempts + 1);
        }
      } catch (error) {
        const message = scrubSecrets(error instanceof Error ? error.message : String(error));
        rt.lastError = message;
        if (job.attempts + 1 < job.maxAttempts) {
          durableQueue.retry(job.id, 20_000, message, job.attempts + 1);
        } else {
          durableQueue.fail(job.id, message, job.attempts + 1);
        }
      } finally {
        rt.busyAgents.delete(job.agentId);
      }
      return;
    }
    default:
      durableQueue.fail(job.id, `Unknown job kind: ${job.kind}`, job.attempts);
  }
}

/** Enqueues one cycle for every agent that is currently idle. */
export function fanOutRoom(roomId: string): number {
  let count = 0;
  for (const agent of listAgents(roomId)) {
    if (agent.status !== "IDLE") continue;
    durableQueue.enqueue({
      kind: "agent.cycle",
      roomId,
      agentId: agent.id,
      delayMs: 0,
      maxAttempts: 3,
      payload: { reason: "schedule" },
    });
    count += 1;
  }
  if (count) touchRoom(roomId);
  return count;
}

/* -------------------------------------------------------------------------- */
/* Tick loop                                                                  */
/* -------------------------------------------------------------------------- */

export interface TickSummary {
  claimed: number;
  dispatched: number;
  skipped: number;
  queuedAfter: number;
  durationMs: number;
  resumedAgents: number;
}

/**
 * Claims and (optionally) awaits the due jobs. Calling this repeatedly is what
 * drives the lab in `external` mode, and it is also what the inline timer does.
 */
export async function tickOnce(options: { awaitJobs?: boolean; limit?: number } = {}): Promise<TickSummary> {
  const rt = state();
  const started = Date.now();
  const awaitJobs = options.awaitJobs ?? false;

  // Safety net: recover jobs orphaned by a crash or a redeploy.
  requeueStaleJobs(new Date());

  // Safety net for parked agents whose scheduled resume never fired (crash,
  // redeploy). Skip anyone who already has a resume job queued, so a slow tick
  // cannot pile up duplicates.
  const dueNow = listAgentsNeedingResume();
  let enqueued = 0;
  for (const agent of dueNow) {
    if (hasPendingJob(agent.id, "agent.resume")) continue;
    durableQueue.enqueue({
      kind: "agent.resume",
      roomId: agent.roomId,
      agentId: agent.id,
      delayMs: 0,
      maxAttempts: 1,
      priority: 1,
      payload: { reason: "resume" },
    });
    enqueued += 1;
  }

  const capacity = Math.max(0, MAX_CONCURRENT_CYCLES - rt.inflight.size);
  const claimed = capacity > 0 ? durableQueue.claim(Math.min(options.limit ?? CLAIM_BATCH, capacity)) : [];
  let dispatched = 0;

  const pending: Promise<void>[] = [];
  for (const job of claimed) {
    const promise = handleJob(job)
      .catch((error) => {
        rt.lastError = scrubSecrets(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        rt.inflight.delete(job.id);
      });
    rt.inflight.set(job.id, promise);
    pending.push(promise);
    dispatched += 1;
  }

  if (awaitJobs && pending.length) await Promise.allSettled(pending);

  rt.ticks += 1;
  rt.lastTickAt = Date.now();

  return {
    claimed: claimed.length,
    dispatched,
    skipped: claimed.length - dispatched,
    queuedAfter: countQueuedJobs(),
    durationMs: Date.now() - started,
    resumedAgents: enqueued,
  };
}

/** Idempotent boot: safe to call from every route handler. */
export function ensureRuntime(): RuntimeStatus {
  const rt = state();
  if (!rt.booted) {
    rt.booted = true;
    rt.bootedAt = Date.now();
    const rearmed = requeueStaleJobs(new Date());
    if (rearmed > 0) rt.lastError = `re-armed ${rearmed} stale job(s) after restart`;
  }

  if (runtimeMode() === "inline" && !rt.timer) {
    rt.timer = setInterval(() => {
      if (rt.ticking) return;
      rt.ticking = true;
      void tickOnce()
        .catch((error) => {
          rt.lastError = scrubSecrets(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          rt.ticking = false;
        });
    }, TICK_INTERVAL_MS);
    // Never hold the event loop open just for the lab.
    rt.timer.unref?.();
  }

  return runtimeStatus();
}

export function runtimeStatus(): RuntimeStatus {
  const rt = state();
  return {
    runtime: runtimeMode(),
    booted: rt.booted,
    bootedAt: rt.bootedAt ? new Date(rt.bootedAt).toISOString() : null,
    ticks: rt.ticks,
    lastTickAt: rt.lastTickAt ? new Date(rt.lastTickAt).toISOString() : null,
    inflight: rt.inflight.size,
    queuedJobs: countQueuedJobs(),
    lastError: rt.lastError,
  };
}

/** Human-readable summary used by `GET /api/health`. */
export function describeRuntime(): string {
  const status = runtimeStatus();
  return `${status.runtime} runtime · ${status.ticks} ticks · ${status.inflight} in flight · ${status.queuedJobs} queued${
    status.lastError ? ` · last error: ${status.lastError}` : ""
  } · booted ${status.bootedAt ? formatDuration(Date.now() - Date.parse(status.bootedAt)) : "never"} ago`;
}

/** Walks every active room and keeps the swarm moving. Used by `POST /api/tick`. */
export function fanOutAllRooms(): number {
  let total = 0;
  for (const room of listRooms(100)) {
    if (room.status !== "ACTIVE") continue;
    total += fanOutRoom(room.id);
  }
  return total;
}
