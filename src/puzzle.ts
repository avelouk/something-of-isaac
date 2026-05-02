/**
 * Daily puzzle resolution.
 *
 * Each UTC day maps to one puzzleNumber. Each puzzleNumber maps to one
 * itemId via a deterministic seeded draw (see scripts/build-schedule.ts).
 * The schedule.json is pre-computed and committed so the answer is the
 * same across clients regardless of algorithm changes later.
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

export type ScheduleEntry = {
  n: number; // puzzle number
  itemId: number;
  hash: string; // sha256(itemId + salt + n) — cheap anti-cheat
};

export type Schedule = {
  version: number;
  salt: string;
  entries: ScheduleEntry[];
};

export function getEntryForPuzzle(schedule: Schedule, n: number): ScheduleEntry | null {
  return schedule.entries.find((e) => e.n === n) ?? null;
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
