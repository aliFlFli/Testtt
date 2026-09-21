import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Db = Database.Database;

/** Opens (and migrates) the SQLite database. Schema version is tracked with user_version. */
export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "bot.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

const MIGRATIONS: string[] = [
  // v0 -> v1: base schema
  `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    lang          TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    count         INTEGER NOT NULL DEFAULT 0,
    total_bytes   INTEGER NOT NULL DEFAULT 0,
    daily_bytes   INTEGER NOT NULL DEFAULT 0,
    daily_date    TEXT,
    premium_tier  TEXT,
    premium_until INTEGER,
    premium_limit INTEGER,
    referred_by   TEXT,
    first_seen    TEXT,
    last_seen     TEXT
  );
  CREATE TABLE IF NOT EXISTS banned (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(user_id, name)
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    category_id INTEGER,
    original_name TEXT NOT NULL,
    new_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS referrals (
    referrer_id TEXT NOT NULL,
    referred_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (referrer_id, referred_id)
  );
  CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, category_id);
  CREATE INDEX IF NOT EXISTS idx_refs_referrer ON referrals(referrer_id);
  `,
];

function migrate(db: Db): void {
  const current = (db.pragma("user_version", { simple: true }) as number) || 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]!);
    db.pragma(`user_version = ${v + 1}`);
  }
}
