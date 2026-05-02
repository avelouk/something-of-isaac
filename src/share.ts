/**
 * Share string shown in the result modal and copied to clipboard.
 *
 * Format (matches the design reference):
 *
 *   Something of Isaac · 2026-05-02
 *   ✓ 3/7 hints · 2 tries
 *   🟥🟥🟥⬜⬜⬜⬜  ⏱ 00:42
 */

import { HINT_COUNT } from "./hints.ts";

const SOLID = "🟥";
const EMPTY = "⬜";

function formatDate(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function shareString(opts: {
  won: boolean;
  hintsUsed: number; // 1..HINT_COUNT
  guessCount: number;
  activeSeconds: number;
}) {
  const { won, hintsUsed, guessCount, activeSeconds } = opts;
  let bar = "";
  for (let i = 0; i < HINT_COUNT; i++) {
    if (!won) bar += SOLID; // all-red ladder on loss
    else if (i < hintsUsed) bar += SOLID;
    else bar += EMPTY;
  }
  const mark = won ? "✓" : "✗";
  const score = won ? `${hintsUsed}/${HINT_COUNT}` : `X/${HINT_COUNT}`;
  const tries = `${guessCount} ${guessCount === 1 ? "try" : "tries"}`;
  const time = `⏱ ${formatTime(activeSeconds)}`;
  return `Something of Isaac · ${formatDate()}\n${mark} ${score} hints · ${tries}\n${bar}  ${time}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
