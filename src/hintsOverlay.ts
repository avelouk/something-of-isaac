/**
 * Live schedule overrides fetched from the stats worker.
 *
 * The committed `schedule.json` stays the baseline for dates nobody has edited.
 * Authoring goes through the local admin UI → worker `POST /hints`; the game and
 * admin merge the published `{ date → { hints, itemId? } }` map on load.
 *
 * Any failure here (missing worker URL, network error, malformed response) yields
 * an empty overlay so the game still works with whatever's in schedule.json.
 */

import type { Schedule } from "./puzzle.ts";
import { HINT_COUNT } from "./hints.ts";

export type ScheduleOverride = {
  hints: string[];
  itemId?: number;
};

/** @deprecated Use ScheduleOverride — kept for call-site compatibility. */
export type HintsOverlay = Record<string, ScheduleOverride>;

const FETCH_TIMEOUT_MS = 3000;

function isValidHints(hints: unknown): hints is string[] {
  return (
    Array.isArray(hints) &&
    hints.length === HINT_COUNT &&
    hints.every((h) => typeof h === "string")
  );
}

function parseOneOverride(val: unknown): ScheduleOverride | null {
  if (isValidHints(val)) return { hints: val };
  if (!val || typeof val !== "object") return null;
  const hints = (val as { hints?: unknown }).hints;
  if (!isValidHints(hints)) return null;
  const itemId = (val as { itemId?: unknown }).itemId;
  if (typeof itemId === "number" && Number.isFinite(itemId) && itemId >= 1) {
    return { hints, itemId: Math.trunc(itemId) };
  }
  return { hints };
}

export function parseScheduleOverrides(data: unknown): Record<string, ScheduleOverride> {
  if (!data || typeof data !== "object") return {};
  const out: Record<string, ScheduleOverride> = {};
  for (const [date, val] of Object.entries(data as Record<string, unknown>)) {
    const parsed = parseOneOverride(val);
    if (parsed) out[date] = parsed;
  }
  return out;
}

export async function fetchHintsOverlay(workerUrl: string | undefined): Promise<HintsOverlay> {
  if (!workerUrl) return {};
  try {
    const r = await fetch(`${workerUrl.replace(/\/$/, "")}/hints`, {
      cache: "default",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return {};
    const data: unknown = await r.json();
    return parseScheduleOverrides(data);
  } catch {
    return {};
  }
}

export function applyHintsOverlay(schedule: Schedule, overlay: HintsOverlay): void {
  for (const entry of schedule.entries) {
    const o = overlay[entry.date];
    if (!o) continue;
    if (isValidHints(o.hints)) entry.hints = o.hints;
    if (typeof o.itemId === "number" && Number.isFinite(o.itemId)) entry.itemId = o.itemId;
  }
}
