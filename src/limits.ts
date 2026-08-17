/**
 * Limits and validators shared by the web client and the worker. The worker
 * imports across the boundary (same pattern as src/puzzle.ts) so the two can
 * never drift.
 */

/** Max feedback message length: client textarea maxLength + worker reject threshold. */
export const FEEDBACK_MAX_CHARS = 1000;

/**
 * Visitor ids are crypto.randomUUID() output — RFC 4122 v4, case-insensitive.
 * Used by /visit, /player/sync, and the ?soi= domain handoff.
 */
export const VISITOR_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isVisitorId(s: string): boolean {
  return VISITOR_ID_RE.test(s);
}

/**
 * Wire format version for /player/sync. Independent of storage.ts's
 * SCHEMA_VERSION, which is local-only and never sent.
 */
export const PLAYER_SYNC_VERSION = 1;

/** Reject bodies larger than this before parsing (measured on the raw text). */
export const PLAYER_SYNC_MAX_BODY_BYTES = 384 * 1024;

/**
 * Max history records kept per bucket. Sized so truncation is unreachable for a
 * real player: >3 years of daily play, and above the 718-item endless pool.
 */
export const PLAYER_SYNC_MAX_HISTORY = 1200;

/** Sanity ceiling on puzzle/round numbers; anything above is junk. */
export const PLAYER_SYNC_MAX_PUZZLE_NUMBER = 100_000;

/**
 * Max stored players per PlayerStore shard. Rows are cumulative visitor ids
 * (every private-mode browser mints one), not active players, so this is an
 * admission cap against unbounded UUID minting — existing rows keep syncing.
 */
export const PLAYER_STORE_MAX_ROWS = 20_000;
