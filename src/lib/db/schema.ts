import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persistence schema (SQLite via Drizzle ORM).
 *
 * The DDL is mirrored in `src/lib/db/bootstrap.ts` so a fresh checkout comes up
 * with zero CLI steps. Both files must be changed together.
 */

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  /** AES-256-GCM payload: v1:iv:tag:ciphertext (all base64). Never logged. */
  encryptedKey: text("encrypted_key"),
  /** Masked tail of the key, safe to render in the UI. */
  keyHint: text("key_hint"),
  keySource: text("key_source").notNull().default("session"),
  baseUrl: text("base_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
});

export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    topic: text("topic").notNull(),
    objective: text("objective").notNull().default(""),
    status: text("status").notNull().default("ACTIVE"),
    createdBy: text("created_by").notNull(),
    maxAgents: integer("max_agents").notNull().default(6),
    iterationBudget: integer("iteration_budget").notNull().default(12),
    cycleIntervalMs: integer("cycle_interval_ms").notNull().default(8000),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("rooms_status_idx").on(table.status, table.updatedAt)],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    sessionId: text("session_id"),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull().default("IDLE"),
    contributions: integer("contributions").notNull().default(0),
    iteration: integer("iteration").notNull().default(0),
    throttleStreak: integer("throttle_streak").notNull().default(0),
    throttleTotal: integer("throttle_total").notNull().default(0),
    backoffMs: integer("backoff_ms").notNull().default(0),
    resumeAt: integer("resume_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("agents_room_idx").on(table.roomId, table.status),
    index("agents_resume_idx").on(table.status, table.resumeAt),
  ],
);

export const logEntries = sqliteTable(
  "log_entries",
  {
    /** Monotonic cursor: doubles as the SSE `Last-Event-ID`. */
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    roomId: text("room_id").notNull(),
    agentId: text("agent_id"),
    agentName: text("agent_name").notNull(),
    provider: text("provider"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    code: text("code"),
    codeLanguage: text("code_language"),
    iteration: integer("iteration").notNull().default(0),
    parentId: text("parent_id"),
    confidence: real("confidence"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("log_room_seq_idx").on(table.roomId, table.seq),
    index("log_room_kind_idx").on(table.roomId, table.kind, table.createdAt),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    roomId: text("room_id").notNull(),
    agentId: text("agent_id"),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    status: text("status").notNull().default("QUEUED"),
    priority: integer("priority").notNull().default(0),
    payload: text("payload").notNull().default("{}"),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("jobs_due_idx").on(table.status, table.runAt, table.priority)],
);

export type SessionRow = typeof sessions.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type LogEntryRow = typeof logEntries.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
