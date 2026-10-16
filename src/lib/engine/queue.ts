import "server-only";

import type { AgentCyclePayload, Job, JobKind } from "@/lib/types";

import { claimDueJobs, insertJob, updateJob } from "@/lib/lab/store";

/**
 * Durable job queue.
 *
 * Jobs live in SQLite (`jobs` table) so a delayed retry survives a process
 * restart: the scheduler re-arms anything left `RUNNING` on boot. The surface
 * here is intentionally the same shape as a Redis/BullMQ queue so the driver
 * can be swapped without touching the engine.
 */
export interface EnqueueOptions {
  kind: JobKind;
  roomId: string;
  agentId: string | null;
  /** Milliseconds from now. 0 means "as soon as the scheduler ticks". */
  delayMs?: number;
  maxAttempts?: number;
  priority?: number;
  payload?: AgentCyclePayload | Record<string, unknown>;
}

export interface JobQueue {
  enqueue(options: EnqueueOptions): Job;
  claim(limit: number): Job[];
  succeed(jobId: string): void;
  retry(jobId: string, delayMs: number, error: string, attempts: number): void;
  fail(jobId: string, error: string, attempts: number): void;
}

export function makeJobId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `job_${Date.now().toString(36)}_${rand}`;
}

export const durableQueue: JobQueue = {
  enqueue(options) {
    return insertJob({
      id: makeJobId(),
      kind: options.kind,
      roomId: options.roomId,
      agentId: options.agentId,
      runAt: new Date(Date.now() + Math.max(0, options.delayMs ?? 0)),
      maxAttempts: options.maxAttempts ?? 3,
      priority: options.priority ?? 0,
      payload: options.payload ?? {},
    });
  },

  claim(limit) {
    return claimDueJobs(new Date(), limit);
  },

  succeed(jobId) {
    updateJob(jobId, { status: "DONE", lastError: null });
  },

  retry(jobId, delayMs, error, attempts) {
    updateJob(jobId, {
      status: "QUEUED",
      attempts,
      runAt: new Date(Date.now() + delayMs),
      lastError: error.slice(0, 500),
    });
  },

  fail(jobId, error, attempts) {
    updateJob(jobId, { status: "FAILED", attempts, lastError: error.slice(0, 500) });
  },
};
