/**
 * Typed LocalStorage wrapper with schema versioning.
 *
 * - Per-puzzle progress stored under the puzzleNumber key.
 * - Aggregate streak/history stored under STATS_KEY.
 * - Schema version bump strategy: read SCHEMA_KEY first; if it's behind
 *   what we ship, run migrations or clear (current MVP: clear if out
 *   of date, accept the streak loss).
 *
 * The Stats/ResultRecord shapes and the pushResult fold live in
 * src/playerState.ts, because the worker imports them too — see that file.
 */

import {
  emptyStats,
  pushResult,
  type ResultRecord,
  type Stats,
} from "./playerState.ts";

// Re-exported so importers (src/main.ts) don't need to know these moved.
export type { ResultRecord, Stats } from "./playerState.ts";

const SCHEMA_KEY = "idg:schema";
const STATS_KEY = "idg:stats";
const ENDLESS_KEY = "idg:endless";
const ENDLESS_STATS_KEY = "idg:endless-stats";
const PROGRESS_PREFIX = "idg:p:";
/**
 * Local only — never sent to the server, and deliberately independent of the
 * /player/sync wire version (PLAYER_SYNC_VERSION in limits.ts).
 *
 * Bumping this wipes every idg:* key below. That is only survivable because the
 * server holds a copy and the sync merge is additive: wipe → push empty →
 * server keeps everything → response rehydrates local. Do not bump it until
 * /player/sync has real coverage, and verify a wipe-then-restore cycle first.
 */
const SCHEMA_VERSION = 4;

export type Progress = {
  puzzleNumber: number;
  guessIds: number[];
  hintsRevealed: number; // 1..6; we always show at least the first hint
  finished: boolean;
  won: boolean;
  /** True once the player has been forced into the multiple-choice round. */
  usedFinalChoice: boolean;
  firstSeenAt: number; // unix ms — used for clock-manipulation guard
  finishedAt?: number;
  activeSeconds: number; // wall-clock time spent with the tab open and game in progress
};

export type EndlessProgress = {
  /** Round to serve when re-entering endless mode. */
  nextRound: number;
};

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled — fail soft.
  }
}

function ensureSchema() {
  const v = Number(localStorage.getItem(SCHEMA_KEY) ?? 0);
  if (v !== SCHEMA_VERSION) {
    // MVP: nuke previous version and start fresh.
    for (const key of Object.keys(localStorage)) {
      if (key === SCHEMA_KEY) continue;
      if (key.startsWith("idg:")) localStorage.removeItem(key);
    }
    localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
  }
}

export function loadProgress(puzzleNumber: number): Progress | null {
  ensureSchema();
  return readJSON<Progress>(PROGRESS_PREFIX + puzzleNumber);
}

export function saveProgress(p: Progress) {
  ensureSchema();
  writeJSON(PROGRESS_PREFIX + p.puzzleNumber, p);
}

export function loadStats(): Stats {
  ensureSchema();
  return readJSON<Stats>(STATS_KEY) ?? emptyStats();
}

export function loadEndless(): EndlessProgress {
  ensureSchema();
  const raw = readJSON<EndlessProgress & { playedIds?: number[] }>(ENDLESS_KEY);
  if (!raw) return { nextRound: 1 };
  if (Array.isArray(raw.playedIds)) {
    return { nextRound: raw.playedIds.length + 1 };
  }
  return { nextRound: raw.nextRound > 0 ? raw.nextRound : 1 };
}

export function markEndlessRoundComplete(round: number) {
  ensureSchema();
  const progress = loadEndless();
  if (round < progress.nextRound) return;
  progress.nextRound = round + 1;
  writeJSON(ENDLESS_KEY, progress);
}

export function loadEndlessStats(): Stats {
  ensureSchema();
  return readJSON<Stats>(ENDLESS_STATS_KEY) ?? emptyStats();
}

/** Endless aggregate, kept apart from daily stats; puzzleNumber holds the round. */
export function recordEndlessResult(record: ResultRecord): Stats {
  ensureSchema();
  const stats = loadEndlessStats();
  if (pushResult(stats, record)) writeJSON(ENDLESS_STATS_KEY, stats);
  return stats;
}

export function recordResult(record: ResultRecord, currentPuzzle: number) {
  ensureSchema();
  const stats = loadStats();
  if (!pushResult(stats, record)) return stats;

  writeJSON(STATS_KEY, stats);

  // Optional: drop old per-puzzle progress entries to keep storage tidy
  // (we keep the current one for resume, but old ones are useless).
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PROGRESS_PREFIX)) continue;
    const n = Number(key.slice(PROGRESS_PREFIX.length));
    if (Number.isFinite(n) && n < currentPuzzle) localStorage.removeItem(key);
  }

  return stats;
}
