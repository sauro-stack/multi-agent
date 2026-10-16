import "server-only";

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { BOOTSTRAP_SQL } from "./bootstrap";
import * as schema from "./schema";

export type LabDatabase = BetterSQLite3Database<typeof schema>;

interface GlobalWithDb {
  __arlDb?: LabDatabase;
  __arlSqlite?: Database.Database;
}

const globalRef = globalThis as unknown as GlobalWithDb;

function databaseFile(): string {
  const configured = process.env.LAB_DATABASE_PATH;
  if (configured) return configured;
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "lab.db");
}

function create(): { db: LabDatabase; sqlite: Database.Database } {
  const file = databaseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.exec(BOOTSTRAP_SQL);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function get(): { db: LabDatabase; sqlite: Database.Database } {
  if (!globalRef.__arlDb) {
    const created = create();
    globalRef.__arlDb = created.db;
    globalRef.__arlSqlite = created.sqlite;
  }
  return { db: globalRef.__arlDb, sqlite: globalRef.__arlSqlite as Database.Database };
}

/** Lazily-initialised singleton (survives Next.js dev HMR via globalThis). */
export function getDb(): LabDatabase {
  return get().db;
}

export function getSqlite(): Database.Database {
  return get().sqlite;
}

export { schema };
