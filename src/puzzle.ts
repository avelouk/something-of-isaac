/**
 * Daily puzzle resolution.
 *
 * Each UTC calendar day (YYYY-MM-DD) is the canonical puzzle identity.
 * Puzzle #n is still derived from BASE_DATE (puzzle #1 = launch day UTC).
 * Schedule rows include both `date` and `n` for lookups and display.
 */

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

/**
 * True for a real YYYY-MM-DD UTC calendar date. Round-trips through Date.UTC
 * because it silently normalizes overflow (2026-02-30 → March), so the regex
 * alone is not enough.
 */
export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Lexicographic compare works for ISO dates: -1 / 0 / 1. */
export function compareIsoDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Next UTC calendar day, YYYY-MM-DD. */
export function addUtcDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
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
