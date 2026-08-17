/**
 * Player state: the shapes, the aggregate fold, and the merge.
 *
 * Imported by BOTH the web client (src/storage.ts, src/playerSync.ts) and the
 * worker (worker/src/player.ts), same as src/puzzle.ts and src/limits.ts, so the
 * two can never drift. `foldStats` calls the very same `pushResult` that
 * `recordResult` uses locally — anti-drift is structural, not aspirational.
 *
 * Keep this module DOM-free and side-effect-free: no localStorage, no crypto,
 * no document. Pure functions over plain data.
 *
 * The merge is the load-bearing idea. It is commutative, associative and
 * idempotent, and it is ADDITIVE — it never drops what the other side already
 * knows. That is what makes it safe for the client to push a freshly-wiped
 * (empty) localStorage at the server: the server keeps everything and hands the
 * history back. See src/storage.ts ensureSchema().
 */

import {
  PLAYER_SYNC_MAX_HISTORY,
  PLAYER_SYNC_MAX_PUZZLE_NUMBER,
  PLAYER_SYNC_VERSION,
} from "./limits.ts";

export type ResultRecord = {
  puzzleNumber: number;
  won: boolean;
  hintsUsed: number; // hint count when guessed correctly (or 7 if lost)
  guesses: number;
  finishedAt: number;
  activeSeconds: number; // wall-clock time spent with the tab open and game in progress
};

export type Stats = {
  played: number;
  won: number;
  currentStreak: number;
  bestStreak: number;
  history: ResultRecord[];
};

/** Everything that syncs. `endless.history` holds ROUND numbers, not puzzles. */
export type PlayerState = {
  daily: Stats;
  endless: Stats;
  endlessNextRound: number;
};

/**
 * A factory, not a shared constant: two callers must never end up holding the
 * same `history` array, or pushes leak between the daily and endless buckets.
 */
export function emptyStats(): Stats {
  return { played: 0, won: 0, currentStreak: 0, bestStreak: 0, history: [] };
}

export function emptyPlayerState(): PlayerState {
  return { daily: emptyStats(), endless: emptyStats(), endlessNextRound: 1 };
}

/**
 * Fold a result into a Stats aggregate in place. Returns false (and leaves
 * stats untouched) if this puzzle/round was already recorded.
 */
export function pushResult(stats: Stats, record: ResultRecord): boolean {
  // Prevent double-counting if the same puzzle is finished twice.
  if (stats.history.some((h) => h.puzzleNumber === record.puzzleNumber)) return false;
  stats.played += 1;
  if (record.won) stats.won += 1;

  // Streak: increments only if previous record was the immediately prior puzzle and won.
  const previous = stats.history[stats.history.length - 1];
  if (record.won && previous && previous.won && previous.puzzleNumber === record.puzzleNumber - 1) {
    stats.currentStreak += 1;
  } else if (record.won) {
    stats.currentStreak = 1;
  } else {
    stats.currentStreak = 0;
  }
  stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak);
  stats.history.push(record);
  return true;
}

/**
 * Total order on two records claiming the same puzzleNumber. Must be
 * deterministic and antisymmetric — if it isn't, merge stops being commutative
 * and two devices oscillate forever, each "fixing" the other.
 */
function pickRecord(a: ResultRecord, b: ResultRecord): ResultRecord {
  if (a.won !== b.won) return a.won ? a : b; // a win always beats a loss
  if (a.finishedAt !== b.finishedAt) return a.finishedAt < b.finishedAt ? a : b; // first genuine finish
  if (a.hintsUsed !== b.hintsUsed) return a.hintsUsed < b.hintsUsed ? a : b;
  if (a.guesses !== b.guesses) return a.guesses < b.guesses ? a : b;
  if (a.activeSeconds !== b.activeSeconds) return a.activeSeconds < b.activeSeconds ? a : b;
  return a; // fully identical
}

/** Union by puzzleNumber, conflicts resolved by pickRecord, sorted ascending. */
function mergeHistories(a: ResultRecord[], b: ResultRecord[]): ResultRecord[] {
  const byPuzzle = new Map<number, ResultRecord>();
  for (const r of a) byPuzzle.set(r.puzzleNumber, r);
  for (const r of b) {
    const prev = byPuzzle.get(r.puzzleNumber);
    byPuzzle.set(r.puzzleNumber, prev ? pickRecord(prev, r) : r);
  }
  return [...byPuzzle.values()].sort((x, y) => x.puzzleNumber - y.puzzleNumber);
}

/**
 * Rebuild the aggregate by replaying pushResult over a sorted history.
 * NEVER sum counters: pushResult's streak rule reads history[length - 1], so it
 * is only correct over a replay in puzzleNumber order.
 */
function foldStats(sortedHistory: ResultRecord[]): Stats {
  const stats = emptyStats();
  for (const r of sortedHistory) pushResult(stats, r);
  return stats;
}

export function mergeStats(a: Stats, b: Stats): Stats {
  const out = foldStats(mergeHistories(a.history, b.history));
  // bestStreak is monotone: a truncated or reordered history must never cost a
  // player their record. currentStreak deliberately is not — streaks must break.
  out.bestStreak = Math.max(out.bestStreak, a.bestStreak, b.bestStreak);
  return out;
}

export function mergePlayerState(a: PlayerState, b: PlayerState): PlayerState {
  const endless = mergeStats(a.endless, b.endless);
  // nextRound only ever grows (storage.ts markEndlessRoundComplete), so max is
  // right. The lastRound + 1 term repairs a stale client value from the history.
  const lastRound = endless.history.length
    ? endless.history[endless.history.length - 1].puzzleNumber
    : 0;
  return {
    daily: mergeStats(a.daily, b.daily),
    endless,
    endlessNextRound: Math.max(a.endlessNextRound, b.endlessNextRound, lastRound + 1, 1),
  };
}

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Validate one untrusted record.
 *
 * Reject on identity and logic fields, clamp on display-only ones. A bad clock
 * or a corrupt activeSeconds must not cost a player their record, but a garbage
 * puzzleNumber corrupts the fold and a far-future finishedAt permanently
 * poisons the pickRecord tie-break.
 */
export function sanitizeRecord(value: unknown, now: number = Date.now()): ResultRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;

  const puzzleNumber = r.puzzleNumber;
  if (
    !Number.isInteger(puzzleNumber) ||
    (puzzleNumber as number) < 1 ||
    (puzzleNumber as number) > PLAYER_SYNC_MAX_PUZZLE_NUMBER
  ) {
    return null;
  }
  if (typeof r.won !== "boolean") return null;
  if (!Number.isInteger(r.hintsUsed) || (r.hintsUsed as number) < 0 || (r.hintsUsed as number) > 7) {
    return null;
  }
  // One day of slack absorbs honest clock skew; beyond that the value would win
  // every pickRecord tie-break forever.
  if (
    !Number.isInteger(r.finishedAt) ||
    (r.finishedAt as number) <= 0 ||
    (r.finishedAt as number) > now + 86_400_000
  ) {
    return null;
  }

  return {
    puzzleNumber: puzzleNumber as number,
    won: r.won,
    hintsUsed: r.hintsUsed as number,
    guesses: clampInt(r.guesses, 0, 1000, 0),
    finishedAt: r.finishedAt as number,
    activeSeconds: clampInt(r.activeSeconds, 0, 604_800, 0),
  };
}

/**
 * Validate an untrusted Stats blob. Counters are never trusted — they are
 * recomputed from the surviving history — so a client cannot inflate them.
 */
export function sanitizeStats(value: unknown, now: number = Date.now()): Stats {
  if (typeof value !== "object" || value === null) return emptyStats();
  const s = value as Record<string, unknown>;
  const rawHistory = Array.isArray(s.history) ? s.history : [];

  const records: ResultRecord[] = [];
  for (const raw of rawHistory) {
    const rec = sanitizeRecord(raw, now);
    if (rec) records.push(rec);
  }

  // Dedupe + sort through the same path a merge would take.
  let history = mergeHistories(records, []);
  // Keep the HIGHEST puzzle numbers: the tail drives streaks, and dropping the
  // head only understates `played`.
  if (history.length > PLAYER_SYNC_MAX_HISTORY) {
    history = history.slice(-PLAYER_SYNC_MAX_HISTORY);
  }

  const out = foldStats(history);
  const claimedBest = clampInt(s.bestStreak, 0, history.length, 0);
  out.bestStreak = Math.max(out.bestStreak, claimedBest);
  return out;
}

export function sanitizePlayerState(value: unknown, now: number = Date.now()): PlayerState {
  if (typeof value !== "object" || value === null) return emptyPlayerState();
  const v = value as Record<string, unknown>;
  const endless = sanitizeStats(v.endless, now);
  const lastRound = endless.history.length
    ? endless.history[endless.history.length - 1].puzzleNumber
    : 0;
  return {
    daily: sanitizeStats(v.daily, now),
    endless,
    endlessNextRound: Math.max(
      clampInt(v.endlessNextRound, 1, PLAYER_SYNC_MAX_PUZZLE_NUMBER, 1),
      lastRound + 1,
    ),
  };
}

/**
 * Canonical JSON. Built field by field in a fixed order so string equality is a
 * valid "did anything change?" test — that comparison is what keeps the worker
 * at ~1 storage write per player per day. Never JSON.stringify untrusted input
 * directly: key order would follow whatever the client sent.
 */
function canonicalStats(x: Stats): unknown {
  return {
    played: x.played,
    won: x.won,
    currentStreak: x.currentStreak,
    bestStreak: x.bestStreak,
    history: x.history.map((r) => ({
      puzzleNumber: r.puzzleNumber,
      won: r.won,
      hintsUsed: r.hintsUsed,
      guesses: r.guesses,
      finishedAt: r.finishedAt,
      activeSeconds: r.activeSeconds,
    })),
  };
}

export function serializePlayerState(state: PlayerState): string {
  return JSON.stringify({
    v: PLAYER_SYNC_VERSION,
    daily: canonicalStats(state.daily),
    endless: canonicalStats(state.endless),
    endlessNextRound: state.endlessNextRound,
  });
}

/** Used client-side to skip a localStorage write when the merge changed nothing. */
export function statsEqual(a: Stats, b: Stats): boolean {
  return JSON.stringify(canonicalStats(a)) === JSON.stringify(canonicalStats(b));
}
