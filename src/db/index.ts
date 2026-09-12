import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS listings (
  fb_id               TEXT PRIMARY KEY,
  search_key          TEXT NOT NULL,
  url                 TEXT NOT NULL,
  title               TEXT,
  price               INTEGER,
  currency            TEXT,
  location            TEXT,
  image_url           TEXT,
  description         TEXT,
  raw_json            TEXT,
  posted_at           TEXT,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  last_changed_at     TEXT,
  availability        TEXT NOT NULL DEFAULT 'active',
  notified_at         TEXT,
  drive_km            REAL,
  drive_min           REAL,
  phase               TEXT NOT NULL DEFAULT 'new',
  eval_verdict        TEXT,
  eval_score          REAL,
  eval_reasoning      TEXT,
  eval_extracted_json TEXT,
  eval_model          TEXT,
  eval_tokens_in      INTEGER,
  eval_tokens_out     INTEGER,
  eval_tokens_cached  INTEGER,
  eval_cost_usd       REAL,
  evaluated_at        TEXT,
  phase_updated_at    TEXT,
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_phase ON listings(phase);
CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_key);

CREATE TABLE IF NOT EXISTS phase_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_id      TEXT NOT NULL REFERENCES listings(fb_id),
  from_phase TEXT,
  to_phase   TEXT NOT NULL,
  note       TEXT,
  at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_fb ON phase_history(fb_id);
`;

export type DB = Database.Database;

let handle: DB | null = null;

export function openDb(path: string): DB {
  if (handle) return handle;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  handle = db;
  return db;
}

/** Add columns introduced after a DB was first created. */
function migrate(db: DB): void {
  const have = new Set(
    (db.prepare("PRAGMA table_info(listings)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const cols: Record<string, string> = {
    posted_at: "TEXT",
    last_changed_at: "TEXT",
    availability: "TEXT NOT NULL DEFAULT 'active'",
    notified_at: "TEXT",
    drive_km: "REAL",
    drive_min: "REAL",
    eval_tokens_in: "INTEGER",
    eval_tokens_out: "INTEGER",
    eval_tokens_cached: "INTEGER",
    eval_cost_usd: "REAL",
  };
  for (const [name, decl] of Object.entries(cols)) {
    if (have.has(name)) continue;
    try {
      db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${decl}`);
    } catch (err) {
      // Another process may have added it between the PRAGMA read and here.
      if (!/duplicate column name/i.test((err as Error).message)) throw err;
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
