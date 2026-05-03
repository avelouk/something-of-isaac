/**
 * Share string shown in the result modal and copied to clipboard.
 *
 * Format (matches the design reference):
 *
 *   Something of Isaac · 2026-05-02
 *   ✓ 3/6 hints · 2 tries
 *   🟥🟥🟥⬜⬜⬜  ⏱ 00:42
 *
 * If the player went through the multiple-choice round, a 🎯 is
 * appended to the score line — wins-via-MC and losses both carry it.
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
  usedFinalChoice: boolean;
}) {
  const { won, hintsUsed, guessCount, activeSeconds, usedFinalChoice } = opts;
  let bar = "";
  for (let i = 0; i < HINT_COUNT; i++) {
    if (!won) bar += SOLID; // all-red ladder on loss
    else if (i < hintsUsed) bar += SOLID;
    else bar += EMPTY;
  }
  const mark = won ? "✓" : "✗";
  const score = won ? `${hintsUsed}/${HINT_COUNT}` : `X/${HINT_COUNT}`;
  const tries = `${guessCount} ${guessCount === 1 ? "try" : "tries"}`;
  const mc = usedFinalChoice ? " 🎯" : "";
  const time = `⏱ ${formatTime(activeSeconds)}`;
  return `Something of Isaac · ${formatDate()}\n${mark} ${score} hints · ${tries}${mc}\n${bar}  ${time}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
