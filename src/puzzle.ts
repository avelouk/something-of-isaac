/**
 * Daily puzzle resolution.
 *
 * Each UTC calendar day (YYYY-MM-DD) is the canonical puzzle identity.
 * Puzzle #n is still derived from BASE_DATE (puzzle #1 = launch day UTC).
 * Schedule rows include both `date` and `n` for lookups and display.
 */

import seedrandom from "seedrandom";

// Anchor date: when puzzle #1 began. Picked at launch and never moves.
// 2026-05-02 UTC midnight — moving this later would shift every player's
// streak, so don't.
export const BASE_DATE_UTC = Date.UTC(2026, 4, 2); // months 0-indexed

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getPuzzleNumber(now: Date = new Date()): number {
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((utcMidnight - BASE_DATE_UTC) / MS_PER_DAY) + 1;
}

/** UTC calendar day string for puzzle #n (matches ISO date at UTC midnight). */
export function puzzleNumberToUtcDateString(n: number): string {
  const ms = BASE_DATE_UTC + (n - 1) * MS_PER_DAY;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** Inverse of puzzleNumberToUtcDateString for that same UTC midnight convention. */
export function utcDateStringToPuzzleNumber(dateStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) throw new Error(`invalid date "${dateStr}", expected YYYY-MM-DD (UTC)`);
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor((utcMidnight - BASE_DATE_UTC) / MS_PER_DAY) + 1;
}

/** Today's puzzle date in UTC, YYYY-MM-DD. */
export function utcTodayDateString(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

export type ScheduleEntry = {
  /** UTC calendar day — canonical row identity (author imports use this). */
  date: string;
  n: number;
  itemId: number;
  hash: string; // sha256(itemId + salt + n) — cheap anti-cheat
  hints?: string[];
};

export type Schedule = {
  version: number;
  salt: string;
  entries: ScheduleEntry[];
};

/** Legacy schedule rows omitted `date`; hydrate at load so old deploys keep working. */
export function migrateScheduleIfNeeded(raw: Schedule): Schedule {
  if (!raw.entries?.length) return raw;
  const first = raw.entries[0];
  if (typeof first.date === "string") return raw;
  return {
    ...raw,
    version: Math.max(raw.version ?? 1, 2),
    entries: raw.entries.map((e) => ({
      ...e,
      date: puzzleNumberToUtcDateString(e.n),
    })),
  };
}

export function getEntryForPuzzle(schedule: Schedule, n: number): ScheduleEntry | null {
  const dateStr = puzzleNumberToUtcDateString(n);
  return schedule.entries.find((e) => e.date === dateStr) ?? schedule.entries.find((e) => e.n === n) ?? null;
}

/**
 * Seeded weighted draw used by build-schedule.ts. Exported here so the
 * algorithm lives next to getPuzzleNumber for readability.
 *
 * @param items   pool to draw from (must be deterministic order)
 * @param weights parallel array of positive weights
 * @param seed    string seed (we use `${salt}:${puzzleNumber}`)
 * @param exclude set of indices to forbid (the no-repeat lookback)
 */
export function weightedDraw<T>(
  items: T[],
  weights: number[],
  seed: string,
  exclude: Set<number>,
): { value: T; index: number } {
  const rng = seedrandom(seed);
  // Effective weights with excluded indices zeroed.
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (!exclude.has(i)) total += weights[i];
  }
  if (total <= 0) throw new Error("weightedDraw: all items excluded");
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    if (exclude.has(i)) continue;
    r -= weights[i];
    if (r <= 0) return { value: items[i], index: i };
  }
  // Floating-point fallthrough: return last unexcluded.
  for (let i = items.length - 1; i >= 0; i--) {
    if (!exclude.has(i)) return { value: items[i], index: i };
  }
  throw new Error("unreachable");
}
