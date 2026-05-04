/**
 * Shared logic for updating one schedule row (local admin server).
 */

import { createHash } from "node:crypto";
import type { Schedule } from "../src/puzzle.ts";
import { utcDateStringToPuzzleNumber, utcTodayDateString } from "../src/puzzle.ts";
import { HINT_COUNT } from "../src/hints.ts";

export type PatchDraft = {
  date: string;
  n?: number;
  itemId?: number;
  item?: string;
  hints?: string[];
};

export type ItemRow = { id: number; name: string };

/** Validation / immutability failures for HTTP mapping (admin server). */
export class SchedulePatchError extends Error {
  readonly statusCode: 400 | 403;

  constructor(message: string, statusCode: 400 | 403) {
    super(message);
    this.name = "SchedulePatchError";
    this.statusCode = statusCode;
  }
}

export function hashEntry(itemId: number, salt: string, n: number): string {
  return createHash("sha256").update(`${itemId}:${salt}:${n}`).digest("hex").slice(0, 16);
}

export function assertIsoDate(d: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) {
    throw new SchedulePatchError(`invalid date "${d}", want YYYY-MM-DD (UTC)`, 400);
  }
}

export function resolveItemId(draft: PatchDraft, items: ItemRow[], ctx: string): number | undefined {
  const hasId = draft.itemId !== undefined && draft.itemId !== null;
  const name = typeof draft.item === "string" ? draft.item.trim() : "";
  const hasName = name.length > 0;
  if (hasId && hasName) {
    throw new SchedulePatchError(`${ctx}: use either itemId or item name, not both`, 400);
  }
  if (!hasId && !hasName) return undefined;
  if (hasId) {
    if (!Number.isFinite(draft.itemId)) {
      throw new SchedulePatchError(`${ctx}: invalid itemId`, 400);
    }
    return draft.itemId!;
  }
  const hits = items.filter((it) => it.name === name);
  if (hits.length === 0) throw new SchedulePatchError(`${ctx}: no item named "${name}"`, 400);
  if (hits.length > 1) throw new SchedulePatchError(`${ctx}: ambiguous item name "${name}"`, 400);
  return hits[0].id;
}

/**
 * Applies one draft. Dates strictly before UTC today cannot be changed.
 */
export function patchScheduleEntry(
  schedule: Schedule,
  items: ItemRow[],
  draft: PatchDraft,
  ctx: string,
): void {
  if (!draft || typeof draft.date !== "string") {
    throw new SchedulePatchError(`${ctx}: missing string "date"`, 400);
  }
  const date = draft.date.trim();
  assertIsoDate(date);

  const n = utcDateStringToPuzzleNumber(date);
  if (n < 1) {
    throw new SchedulePatchError(`${ctx}: date ${date} is before puzzle #1`, 400);
  }

  if (draft.n !== undefined && draft.n !== n) {
    throw new SchedulePatchError(`${ctx}: n=${draft.n} disagrees with date ${date} (expected ${n})`, 400);
  }

  const today = utcTodayDateString();
  if (date < today) {
    throw new SchedulePatchError(
      `${ctx}: cannot edit ${date} — only today and future UTC dates are editable`,
      403,
    );
  }

  const entry =
    schedule.entries.find((e) => e.date === date) ?? schedule.entries.find((e) => e.n === n);
  if (!entry) {
    throw new SchedulePatchError(`${ctx}: schedule has no row for ${date} (#${n})`, 400);
  }

  const nextItemId = resolveItemId(draft, items, ctx);
  if (nextItemId !== undefined && nextItemId !== entry.itemId) {
    entry.itemId = nextItemId;
    entry.hash = hashEntry(nextItemId, schedule.salt, n);
  }

  if (draft.hints !== undefined) {
    if (!Array.isArray(draft.hints) || draft.hints.length !== HINT_COUNT) {
      throw new SchedulePatchError(`${ctx}: hints must be an array of length ${HINT_COUNT}`, 400);
    }
    entry.hints = draft.hints;
  }
}
