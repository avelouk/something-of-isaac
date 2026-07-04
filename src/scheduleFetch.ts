/**
 * Fetch one puzzle day from the stats worker schedule API.
 */

import type { ScheduleEntry } from "./puzzle.ts";
import { workerBase } from "./workerBase.ts";

// The worker's public /schedule/day strips `hash` (anti-cheat), so the response is a
// ScheduleEntry without it. Type it honestly — nothing on the client reads hash.
export type PublicScheduleEntry = Omit<ScheduleEntry, "hash">;

const FETCH_TIMEOUT_MS = 5000;

export async function fetchScheduleEntry(
  workerUrl: string | undefined,
  puzzleNumber: number,
): Promise<PublicScheduleEntry | null> {
  const base = workerBase(workerUrl);
  if (!base) return null;
  try {
    const r = await fetch(`${base}/schedule/day?puzzle=${puzzleNumber}`, {
      cache: "default",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as PublicScheduleEntry;
    if (!data || typeof data.itemId !== "number" || typeof data.date !== "string") return null;
    return data;
  } catch {
    return null;
  }
}
