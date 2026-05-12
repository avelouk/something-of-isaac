/**
 * Live hint overrides fetched from the stats worker.
 *
 * The committed `schedule.json` stays the source of truth for which item maps to
 * which UTC date (and the integrity hash). Authoring new hint copy only goes through
 * the local admin UI → worker `POST /hints`, and the game merges the published
 * `{ date → hints[] }` map on top of the static schedule at load time.
 *
 * Any failure here (missing worker URL, network error, malformed response) yields
 * an empty overlay so the game still works with whatever's in schedule.json.
 */

import type { Schedule } from "./puzzle.ts";
import { HINT_COUNT } from "./hints.ts";

export type HintsOverlay = Record<string, string[]>;

const FETCH_TIMEOUT_MS = 3000;

export async function fetchHintsOverlay(workerUrl: string | undefined): Promise<HintsOverlay> {
  if (!workerUrl) return {};
  try {
    const r = await fetch(`${workerUrl.replace(/\/$/, "")}/hints`, {
      cache: "default",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return {};
    const data: unknown = await r.json();
    if (!data || typeof data !== "object") return {};
    return data as HintsOverlay;
  } catch {
    return {};
  }
}

export function applyHintsOverlay(schedule: Schedule, overlay: HintsOverlay): void {
  for (const entry of schedule.entries) {
    const o = overlay[entry.date];
    if (Array.isArray(o) && o.length === HINT_COUNT && o.every((h) => typeof h === "string")) {
      entry.hints = o;
    }
  }
}
