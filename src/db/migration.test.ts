import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "./index.js";

/**
 * Simulates a pre-upgrade DB (old rental-specific phases, no `actor` column)
 * on disk, then runs it through `openDb`'s migration and checks the remap.
 * A fresh :memory: DB never exercises this path (its schema is already
 * current), so this needs a real file we build by hand first.
 */
function makeLegacyDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE listings (
      fb_id TEXT PRIMARY KEY, search_key TEXT NOT NULL, url TEXT NOT NULL,
      title TEXT, price INTEGER, currency TEXT, location TEXT, image_url TEXT,
      description TEXT, raw_json TEXT, posted_at TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_changed_at TEXT,
      availability TEXT NOT NULL DEFAULT 'active', notified_at TEXT,
      drive_km REAL, drive_min REAL, phase TEXT NOT NULL DEFAULT 'new',
      eval_verdict TEXT, eval_score REAL, eval_reasoning TEXT,
      eval_extracted_json TEXT, eval_model TEXT, eval_tokens_in INTEGER,
      eval_tokens_out INTEGER, eval_tokens_cached INTEGER, eval_cost_usd REAL,
      evaluated_at TEXT, phase_updated_at TEXT, notes TEXT
    );
    CREATE TABLE phase_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fb_id TEXT NOT NULL,
      from_phase TEXT, to_phase TEXT NOT NULL, note TEXT, at TEXT NOT NULL
    );
  `);
  const ins = db.prepare(
    `INSERT INTO listings (fb_id, search_key, url, first_seen_at, last_seen_at, phase)
     VALUES (?, 'test', 'https://example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
  );
  ins.run("contacted-1", "contacted");
  ins.run("visit-1", "visit_scheduled");
  ins.run("visited-1", "visited");
  ins.run("declined-1", "declined");
  ins.run("old-accepted-1", "accepted");
  ins.run("candidate-1", "candidate"); // untouched control row
  db.close();
}

// `openDb` caches its DB handle process-wide (see db/index.ts), so a second
// call anywhere else in this process would silently return this same handle
// instead of opening a different file — keep this file to exactly one
// `openDb` call and fold every assertion about the migration into it.
test("openDb migration: retires rental-specific phases and gates on user_version", () => {
  const dir = mkdtempSync(join(tmpdir(), "famabot-migration-"));
  const path = join(dir, "legacy.db");
  try {
    makeLegacyDb(path);
    const db = openDb(path);
    const phaseOf = (fbId: string) =>
      (
        db.prepare("SELECT phase FROM listings WHERE fb_id = ?").get(fbId) as {
          phase: string;
        }
      ).phase;

    assert.equal(phaseOf("contacted-1"), "accepted");
    assert.equal(phaseOf("visit-1"), "accepted");
    assert.equal(phaseOf("visited-1"), "accepted");
    assert.equal(phaseOf("declined-1"), "acquisition_rejected");
    // The OLD accepted (terminal) meaning defaults to acquired_continue, and
    // must NOT be confused with the newly-remapped contacted/visited rows.
    assert.equal(phaseOf("old-accepted-1"), "acquired_continue");
    assert.equal(phaseOf("candidate-1"), "candidate");

    const hist = db
      .prepare("SELECT from_phase, to_phase, actor FROM phase_history WHERE fb_id = ?")
      .all("old-accepted-1") as {
      from_phase: string;
      to_phase: string;
      actor: string;
    }[];
    assert.equal(hist.length, 1);
    assert.equal(hist[0]!.from_phase, "accepted");
    assert.equal(hist[0]!.to_phase, "acquired_continue");
    assert.equal(hist[0]!.actor, "system");

    // Gated so a later process opening the same file never re-touches a row
    // someone has since legitimately moved to a name that collides with a
    // retired phase.
    assert.equal(db.pragma("user_version", { simple: true }), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
