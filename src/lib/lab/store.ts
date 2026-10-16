import "server-only";

import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

import { getDb, schema } from "@/lib/db/client";
import type {
  Agent,
  AgentCyclePayload,
  AgentStatus,
  Job,
  JobKind,
  LogEntry,
  LogEntryKind,
  ProviderId,
  ResearchRoom,
  RoomStatus,
  RoomSummary,
} from "@/lib/types";
import { slugify } from "@/lib/utils";

import type { AgentRow, JobRow, LogEntryRow, RoomRow } from "@/lib/db/schema";

/* -------------------------------------------------------------------------- */
/* Mappers                                                                    */
/* -------------------------------------------------------------------------- */

export function mapRoom(row: RoomRow): ResearchRoom {
  return {
    id: row.id,
    slug: row.slug,
    topic: row.topic,
    objective: row.objective,
    status: row.status as RoomStatus,
    createdBy: row.createdBy,
    maxAgents: row.maxAgents,
    iterationBudget: row.iterationBudget,
    cycleIntervalMs: row.cycleIntervalMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    roomId: row.roomId,
    sessionId: row.sessionId,
    name: row.name,
    provider: row.provider as ProviderId,
    model: row.model,
    status: row.status as AgentStatus,
    contributions: row.contributions,
    iteration: row.iteration,
    throttleStreak: row.throttleStreak,
    throttleTotal: row.throttleTotal,
    backoffMs: row.backoffMs,
    resumeAt: row.resumeAt ? row.resumeAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mapLogEntry(row: LogEntryRow): LogEntry {
  return {
    id: row.id,
    seq: row.seq,
    roomId: row.roomId,
    agentId: row.agentId,
    agentName: row.agentName,
    provider: (row.provider as ProviderId | null) ?? null,
    kind: row.kind as LogEntryKind,
    title: row.title,
    content: row.content,
    code: row.code,
    codeLanguage: row.codeLanguage,
    iteration: row.iteration,
    parentId: row.parentId,
    confidence: row.confidence,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    latencyMs: row.latencyMs,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapJob(row: JobRow): Job {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    kind: row.kind as JobKind,
    roomId: row.roomId,
    agentId: row.agentId,
    runAt: row.runAt.toISOString(),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    status: row.status as Job["status"],
    priority: row.priority,
    payload,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Rooms                                                                      */
/* -------------------------------------------------------------------------- */

export function listRooms(limit = 50): RoomSummary[] {
  const db = getDb();
  const rooms = db.select().from(schema.rooms).orderBy(desc(schema.rooms.updatedAt)).limit(limit).all();
  if (!rooms.length) return [];

  const ids = rooms.map((r) => r.id);

  const agentStats = db
    .select({
      roomId: schema.agents.roomId,
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when status in ('RESEARCHING','IDLE') then 1 else 0 end)`,
    })
    .from(schema.agents)
    .where(inArray(schema.agents.roomId, ids))
    .groupBy(schema.agents.roomId)
    .all();

  const logStats = db
    .select({
      roomId: schema.logEntries.roomId,
      total: sql<number>`count(*)`,
      discoveries: sql<number>`sum(case when kind = 'key_discovery' then 1 else 0 end)`,
      lastAt: sql<number | null>`max(created_at)`,
    })
    .from(schema.logEntries)
    .where(inArray(schema.logEntries.roomId, ids))
    .groupBy(schema.logEntries.roomId)
    .all();

  const agentMap = new Map(agentStats.map((s) => [s.roomId, s]));
  const logMap = new Map(logStats.map((s) => [s.roomId, s]));

  return rooms.map((room) => {
    const agents = agentMap.get(room.id);
    const logs = logMap.get(room.id);
    const lastAt = logs?.lastAt ? new Date(Number(logs.lastAt)).toISOString() : null;
    return {
      ...mapRoom(room),
      agentCount: Number(agents?.total ?? 0),
      activeAgentCount: Number(agents?.active ?? 0),
      entryCount: Number(logs?.total ?? 0),
      discoveryCount: Number(logs?.discoveries ?? 0),
      lastActivityAt: lastAt,
    };
  });
}

export function getRoom(id: string): ResearchRoom | null {
  const row = getDb().select().from(schema.rooms).where(eq(schema.rooms.id, id)).get();
  return row ? mapRoom(row) : null;
}

export function getRoomBySlug(slug: string): ResearchRoom | null {
  const row = getDb().select().from(schema.rooms).where(eq(schema.rooms.slug, slug)).get();
  return row ? mapRoom(row) : null;
}

export function createRoom(input: {
  id: string;
  topic: string;
  objective: string;
  createdBy: string;
  maxAgents?: number;
  iterationBudget?: number;
  cycleIntervalMs?: number;
}): ResearchRoom {
  const db = getDb();
  const now = new Date();
  let slug = slugify(input.topic) || `room-${input.id.slice(0, 6)}`;
  if (getRoomBySlug(slug)) slug = `${slug}-${input.id.slice(0, 4)}`;

  db.insert(schema.rooms)
    .values({
      id: input.id,
      slug,
      topic: input.topic,
      objective: input.objective,
      status: "ACTIVE",
      createdBy: input.createdBy,
      maxAgents: input.maxAgents ?? 6,
      iterationBudget: input.iterationBudget ?? 12,
      cycleIntervalMs: input.cycleIntervalMs ?? 8000,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const created = getRoom(input.id);
  if (!created) throw new Error("Room insert failed");
  return created;
}

export function updateRoom(id: string, patch: Partial<Pick<ResearchRoom, "status" | "objective">>): ResearchRoom | null {
  const db = getDb();
  db.update(schema.rooms)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.rooms.id, id))
    .run();
  return getRoom(id);
}

export function touchRoom(id: string): void {
  getDb()
    .update(schema.rooms)
    .set({ updatedAt: new Date() })
    .where(eq(schema.rooms.id, id))
    .run();
}

/* -------------------------------------------------------------------------- */
/* Agents                                                                     */
/* -------------------------------------------------------------------------- */

export function listAgents(roomId: string): Agent[] {
  return getDb()
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.roomId, roomId))
    .orderBy(schema.agents.createdAt)
    .all()
    .map(mapAgent);
}

export function getAgent(id: string): Agent | null {
  const row = getDb().select().from(schema.agents).where(eq(schema.agents.id, id)).get();
  return row ? mapAgent(row) : null;
}

/**
 * Parked agents whose scheduled resume is due.
 *
 * `resumeAt === null` means the park is deliberate and must not be undone by
 * the scheduler: either a human paused the agent, or it exhausted its backoff
 * attempts on a provider that is clearly not letting us through.
 */
export function listAgentsNeedingResume(now = new Date()): Agent[] {
  return getDb()
    .select()
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.status, "PAUSED_RATE_LIMIT"),
        isNotNull(schema.agents.resumeAt),
        sql`${schema.agents.resumeAt} <= ${now.getTime()}`,
      ),
    )
    .all()
    .map(mapAgent);
}

export function countAgentsInRoom(roomId: string): number {
  const row = getDb()
    .select({ total: sql<number>`count(*)` })
    .from(schema.agents)
    .where(eq(schema.agents.roomId, roomId))
    .get();
  return Number(row?.total ?? 0);
}

export function createAgent(input: {
  id: string;
  roomId: string;
  sessionId: string | null;
  name: string;
  provider: ProviderId;
  model: string;
}): Agent {
  const db = getDb();
  const now = new Date();
  db.insert(schema.agents)
    .values({
      id: input.id,
      roomId: input.roomId,
      sessionId: input.sessionId,
      name: input.name,
      provider: input.provider,
      model: input.model,
      status: "IDLE",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const created = getAgent(input.id);
  if (!created) throw new Error("Agent insert failed");
  return created;
}

export interface AgentPatch {
  status?: AgentStatus;
  contributions?: number;
  iteration?: number;
  throttleStreak?: number;
  throttleTotal?: number;
  backoffMs?: number;
  resumeAt?: Date | null;
  lastError?: string | null;
}

export function updateAgent(id: string, patch: AgentPatch): Agent | null {
  const db = getDb();
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.contributions !== undefined) values.contributions = patch.contributions;
  if (patch.iteration !== undefined) values.iteration = patch.iteration;
  if (patch.throttleStreak !== undefined) values.throttleStreak = patch.throttleStreak;
  if (patch.throttleTotal !== undefined) values.throttleTotal = patch.throttleTotal;
  if (patch.backoffMs !== undefined) values.backoffMs = patch.backoffMs;
  if (patch.resumeAt !== undefined) values.resumeAt = patch.resumeAt;
  if (patch.lastError !== undefined) values.lastError = patch.lastError;

  db.update(schema.agents).set(values).where(eq(schema.agents.id, id)).run();
  return getAgent(id);
}

export function removeAgent(id: string): void {
  getDb().delete(schema.agents).where(eq(schema.agents.id, id)).run();
}

/* -------------------------------------------------------------------------- */
/* Log entries                                                                */
/* -------------------------------------------------------------------------- */

export interface LogEntryInput {
  roomId: string;
  agentId: string | null;
  agentName: string;
  provider: ProviderId | null;
  kind: LogEntryKind;
  title: string;
  content: string;
  code?: string | null;
  codeLanguage?: string | null;
  iteration?: number;
  parentId?: string | null;
  confidence?: number | null;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

export function insertLogEntry(input: LogEntryInput, id: string): LogEntry {
  const db = getDb();
  const createdAt = new Date();
  db.insert(schema.logEntries)
    .values({
      id,
      roomId: input.roomId,
      agentId: input.agentId,
      agentName: input.agentName,
      provider: input.provider,
      kind: input.kind,
      title: input.title,
      content: input.content,
      code: input.code ?? null,
      codeLanguage: input.codeLanguage ?? null,
      iteration: input.iteration ?? 0,
      parentId: input.parentId ?? null,
      confidence: input.confidence ?? null,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      latencyMs: input.latencyMs ?? 0,
      metadata: JSON.stringify(input.metadata ?? {}),
      createdAt,
    })
    .run();

  const row = db.select().from(schema.logEntries).where(eq(schema.logEntries.id, id)).get();
  if (!row) throw new Error("Log entry insert failed");
  return mapLogEntry(row);
}

/** Entries after `sinceSeq`, oldest-first — the SSE replay contract. */
export function listLogEntries(
  roomId: string,
  opts: { sinceSeq?: number; limit?: number; kinds?: LogEntryKind[] } = {},
): LogEntry[] {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 200, 1000);
  const filters = [eq(schema.logEntries.roomId, roomId)];
  if (opts.sinceSeq && opts.sinceSeq > 0) filters.push(gt(schema.logEntries.seq, opts.sinceSeq));
  if (opts.kinds?.length) filters.push(inArray(schema.logEntries.kind, opts.kinds));

  return db
    .select()
    .from(schema.logEntries)
    .where(and(...filters))
    .orderBy(desc(schema.logEntries.seq))
    .limit(limit)
    .all()
    .map(mapLogEntry)
    .reverse();
}

export function latestLogEntries(roomId: string, limit = 12): LogEntry[] {
  return listLogEntries(roomId, { limit });
}

export function getLogEntry(id: string): LogEntry | null {
  const row = getDb().select().from(schema.logEntries).where(eq(schema.logEntries.id, id)).get();
  return row ? mapLogEntry(row) : null;
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

export function insertJob(input: {
  id: string;
  kind: JobKind;
  roomId: string;
  agentId: string | null;
  runAt: Date;
  maxAttempts: number;
  priority?: number;
  payload: AgentCyclePayload | Record<string, unknown>;
}): Job {
  const db = getDb();
  db.insert(schema.jobs)
    .values({
      id: input.id,
      kind: input.kind,
      roomId: input.roomId,
      agentId: input.agentId,
      runAt: input.runAt,
      maxAttempts: input.maxAttempts,
      priority: input.priority ?? 0,
      status: "QUEUED",
      payload: JSON.stringify(input.payload),
      createdAt: new Date(),
    })
    .run();
  const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, input.id)).get();
  if (!row) throw new Error("Job insert failed");
  return mapJob(row);
}

export function updateJob(
  id: string,
  patch: { status?: Job["status"]; attempts?: number; runAt?: Date; lastError?: string | null },
): void {
  const values: Record<string, unknown> = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.attempts !== undefined) values.attempts = patch.attempts;
  if (patch.runAt !== undefined) values.runAt = patch.runAt;
  if (patch.lastError !== undefined) values.lastError = patch.lastError;
  if (!Object.keys(values).length) return;
  getDb().update(schema.jobs).set(values).where(eq(schema.jobs.id, id)).run();
}

export function claimDueJobs(now: Date, limit: number): Job[] {
  const db = getDb();
  const due = db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, "QUEUED"), sql`${schema.jobs.runAt} <= ${now.getTime()}`))
    .orderBy(schema.jobs.priority, schema.jobs.runAt)
    .limit(limit)
    .all();

  if (!due.length) return [];

  // Mark as RUNNING so a second tick (or a restarted process) cannot double-run.
  db.update(schema.jobs)
    .set({ status: "RUNNING" })
    .where(inArray(schema.jobs.id, due.map((j) => j.id)))
    .run();

  return due.map(mapJob);
}

export function requeueStaleJobs(now: Date): number {
  // Jobs left RUNNING by a crash are re-armed.
  const result = getDb()
    .update(schema.jobs)
    .set({ status: "QUEUED", runAt: now })
    .where(eq(schema.jobs.status, "RUNNING"))
    .run();
  return Number(result.changes ?? 0);
}

/** True when this agent already has a queued or in-flight job of that kind. */
export function hasPendingJob(agentId: string, kind: JobKind): boolean {
  const row = getDb()
    .select({ total: sql<number>`count(*)` })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.agentId, agentId),
        eq(schema.jobs.kind, kind),
        inArray(schema.jobs.status, ["QUEUED", "RUNNING"]),
      ),
    )
    .get();
  return Number(row?.total ?? 0) > 0;
}

export function countQueuedJobs(): number {
  const row = getDb()
    .select({ total: sql<number>`count(*)` })
    .from(schema.jobs)
    .where(eq(schema.jobs.status, "QUEUED"))
    .get();
  return Number(row?.total ?? 0);
}

export function listJobsForAgent(agentId: string, limit = 10): Job[] {
  return getDb()
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.agentId, agentId))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit)
    .all()
    .map(mapJob);
}

export function purgeFinishedJobs(olderThan: Date): number {
  const result = getDb()
    .delete(schema.jobs)
    .where(
      and(
        inArray(schema.jobs.status, ["DONE", "FAILED"]),
        sql`${schema.jobs.runAt} < ${olderThan.getTime()}`,
      ),
    )
    .run();
  return Number(result.changes ?? 0);
}
