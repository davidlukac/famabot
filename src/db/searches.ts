import type { DB } from "./index.js";
import { nowIso } from "./index.js";

export interface SearchStatusRow {
  search_key: string;
  paused_at: string;
  reason: string | null;
}

/**
 * Pause polling for a search — e.g. the "acquired it, stop searching" outcome
 * of a candidate action. Checked by `pipeline/poll.ts` alongside `searches.yaml`'s
 * `enabled` flag, so the effect is immediate without editing that file.
 * Upserts: re-pausing an already-paused search just updates the reason/timestamp.
 */
export function pauseSearch(db: DB, searchKey: string, reason: string | null): void {
  db.prepare(
    `INSERT INTO search_status (search_key, paused_at, reason) VALUES (?, ?, ?)
     ON CONFLICT(search_key) DO UPDATE SET paused_at = excluded.paused_at, reason = excluded.reason`,
  ).run(searchKey, nowIso(), reason);
}

export function resumeSearch(db: DB, searchKey: string): void {
  db.prepare("DELETE FROM search_status WHERE search_key = ?").run(searchKey);
}

export function isPaused(db: DB, searchKey: string): boolean {
  return (
    db.prepare("SELECT 1 FROM search_status WHERE search_key = ?").get(searchKey) !=
    null
  );
}

export function pausedSearches(db: DB): SearchStatusRow[] {
  return db
    .prepare("SELECT * FROM search_status ORDER BY paused_at DESC")
    .all() as SearchStatusRow[];
}
