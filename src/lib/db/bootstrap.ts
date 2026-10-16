import "server-only";

/**
 * Hand-written DDL that mirrors `schema.ts`.
 *
 * Running this on boot means a fresh clone has a working database with no
 * migration CLI step. Statements are idempotent.
 */
export const BOOTSTRAP_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  encrypted_key TEXT,
  key_hint      TEXT,
  key_source    TEXT NOT NULL DEFAULT 'session',
  base_url      TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL,
  topic             TEXT NOT NULL,
  objective         TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by        TEXT NOT NULL,
  max_agents        INTEGER NOT NULL DEFAULT 6,
  iteration_budget  INTEGER NOT NULL DEFAULT 12,
  cycle_interval_ms INTEGER NOT NULL DEFAULT 8000,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_slug_uq ON rooms (slug);
CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms (status, updated_at);

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id      TEXT,
  name            TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'IDLE',
  contributions   INTEGER NOT NULL DEFAULT 0,
  iteration       INTEGER NOT NULL DEFAULT 0,
  throttle_streak INTEGER NOT NULL DEFAULT 0,
  throttle_total  INTEGER NOT NULL DEFAULT 0,
  backoff_ms      INTEGER NOT NULL DEFAULT 0,
  resume_at       INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_room_idx ON agents (room_id, status);
CREATE INDEX IF NOT EXISTS agents_resume_idx ON agents (status, resume_at);

CREATE TABLE IF NOT EXISTS log_entries (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id      TEXT,
  agent_name    TEXT NOT NULL,
  provider      TEXT,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  code          TEXT,
  code_language TEXT,
  iteration     INTEGER NOT NULL DEFAULT 0,
  parent_id     TEXT,
  confidence    REAL,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS log_id_uq ON log_entries (id);
CREATE INDEX IF NOT EXISTS log_room_seq_idx ON log_entries (room_id, seq);
CREATE INDEX IF NOT EXISTS log_room_kind_idx ON log_entries (room_id, kind, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  room_id      TEXT NOT NULL,
  agent_id     TEXT,
  run_at       INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status       TEXT NOT NULL DEFAULT 'QUEUED',
  priority     INTEGER NOT NULL DEFAULT 0,
  payload      TEXT NOT NULL DEFAULT '{}',
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (status, run_at, priority);
`;
