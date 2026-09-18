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
  notes               TEXT,
  telegram_message_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_listings_phase ON listings(phase);
CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_key);

CREATE TABLE IF NOT EXISTS phase_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_id      TEXT NOT NULL REFERENCES listings(fb_id),
  from_phase TEXT,
  to_phase   TEXT NOT NULL,
  note       TEXT,
  actor      TEXT NOT NULL DEFAULT 'system',
  at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_fb ON phase_history(fb_id);

-- Searches the user has paused (e.g. "acquired it, stop searching"). Checked
-- by the poll loop alongside searches.yaml's \`enabled\` flag — no file edit
-- needed to react to that outcome. searches.yaml stays the source of truth for
-- which searches *exist*; this is only an on/off override at runtime.
CREATE TABLE IF NOT EXISTS search_status (
  search_key TEXT PRIMARY KEY,
  paused_at  TEXT NOT NULL,
  reason     TEXT
);
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
    telegram_message_id: "INTEGER",
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

  const haveHistory = new Set(
    (db.prepare("PRAGMA table_info(phase_history)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!haveHistory.has("actor")) {
    try {
      db.exec(
        "ALTER TABLE phase_history ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'",
      );
    } catch (err) {
      if (!/duplicate column name/i.test((err as Error).message)) throw err;
    }
    // Backfill: the two system-generated notes get their real actor; every
    // other pre-existing entry was a manual `move`/`setPhase` call, i.e. a user.
    db.exec(`UPDATE phase_history SET actor = 'evaluator' WHERE note = 'evaluator'`);
    db.exec(
      `UPDATE phase_history SET actor = 'system' WHERE note = 're-eval after change'`,
    );
    db.exec(
      `UPDATE phase_history SET actor = 'user' WHERE note NOT IN ('evaluator', 're-eval after change') OR note IS NULL`,
    );
  }

  retireRentalPhases(db);
}

/**
 * One-time migration off the old rental-specific phase set
 * (contacted/visit_scheduled/visited/declined, and the old terminal meaning of
 * `accepted`) onto the general acquisition workflow. Gated on `user_version`
 * (SQLite's built-in schema-version counter) so it runs exactly once, even
 * though the phase values it looks for could theoretically recur under new
 * meanings later.
 */
function retireRentalPhases(db: DB): void {
  if (Number(db.pragma("user_version", { simple: true })) >= 1) return;
  const ts = nowIso();
  // Snapshot rows in the OLD `accepted` (terminal, "fully acquired") phase
  // before contacted/visit_scheduled/visited get remapped onto `accepted`
  // below — otherwise those would be caught by this remap too and wrongly
  // land on acquired_continue instead of staying "in progress".
  const oldAccepted = new Set(
    (
      db.prepare("SELECT fb_id FROM listings WHERE phase = 'accepted'").all() as {
        fb_id: string;
      }[]
    ).map((r) => r.fb_id),
  );
  const remap: [string, string][] = [
    ["contacted", "accepted"],
    ["visit_scheduled", "accepted"],
    ["visited", "accepted"],
    ["declined", "acquisition_rejected"],
  ];
  let migrated = 0;
  const tx = db.transaction(() => {
    for (const [from, to] of remap) {
      const rows = db
        .prepare("SELECT fb_id FROM listings WHERE phase = ?")
        .all(from) as { fb_id: string }[];
      if (rows.length === 0) continue;
      db.prepare(
        "UPDATE listings SET phase = ?, phase_updated_at = ? WHERE phase = ?",
      ).run(to, ts, from);
      const insertHistory = db.prepare(
        `INSERT INTO phase_history (fb_id, from_phase, to_phase, note, actor, at)
         VALUES (?, ?, ?, ?, 'system', ?)`,
      );
      for (const r of rows) {
        insertHistory.run(
          r.fb_id,
          from,
          to,
          "migrated: rental-specific phase retired",
          ts,
        );
      }
      migrated += rows.length;
    }
    // Old terminal meaning of `accepted` ("fully acquired, done") is now
    // ambiguous under the new one ("pursuing, not yet resolved"). Default to
    // "acquired, continue searching" — the safer of the two guesses — and
    // flag it below so the user can review and correct if they meant "stop".
    if (oldAccepted.size > 0) {
      const insertHistory = db.prepare(
        `INSERT INTO phase_history (fb_id, from_phase, to_phase, note, actor, at)
         VALUES (?, 'accepted', 'acquired_continue', ?, 'system', ?)`,
      );
      for (const fbId of oldAccepted) {
        db.prepare(
          "UPDATE listings SET phase = 'acquired_continue', phase_updated_at = ? WHERE fb_id = ?",
        ).run(ts, fbId);
        insertHistory.run(fbId, "migrated: rental-specific phase retired", ts);
      }
      migrated += oldAccepted.size;
    }
    db.pragma("user_version = 1");
  });
  tx();
  if (migrated > 0) {
    console.warn(
      `[famabot] migrated ${migrated} listing(s) off the retired rental-specific phases. ` +
        `Old "accepted" (meaning: fully acquired) rows were mapped to "acquired_continue" ` +
        `by default — review with \`famabot list --phase acquired_continue\` and correct any ` +
        `that should instead be "acquired_stop".`,
    );
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
