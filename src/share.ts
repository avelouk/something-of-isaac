/**
 * Share string shown in the result modal and copied to clipboard.
 *
 * Format (matches the design reference):
 *
 *   Something of Isaac · 2026-05-02
 *   ✓ 3/6 hints · 2 tries
 *   🟩🟩🟩⬜⬜⬜  ⏱ 00:42
 *   https://avelouk.com/something-of-isaac/
 *
 * If the player went through the multiple-choice round, a 🎯 is
 * appended to the score line — wins-via-MC and losses both carry it.
 */

import { HINT_COUNT } from "./hints.ts";

/** Public site — appended to copied share text. */
export const SHARE_SITE_URL = "https://avelouk.com/something-of-isaac/";

const EMPTY = "⬜";

/** Filled squares grade the run: few hints = green, mid = yellow, all six = red. */
function solidSquare(filledCount: number): string {
  if (filledCount <= 3) return "🟩";
  if (filledCount <= 5) return "🟨";
  return "🟥";
}

function formatDate(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatTime(seconds: number): string {
  const totalMs = Math.max(0, Math.floor(seconds * 1000));
  const m = Math.floor(totalMs / 60000).toString().padStart(2, "0");
  const s = Math.floor((totalMs % 60000) / 1000).toString().padStart(2, "0");
  const ms = (totalMs % 1000).toString().padStart(3, "0");
  return `${m}:${s}.${ms}`;
}

export function shareString(opts: {
  won: boolean;
  hintsUsed: number; // 1..HINT_COUNT
  guessCount: number;
  activeSeconds: number;
  usedFinalChoice: boolean;
  /** Heading suffix; defaults to today's UTC date (endless mode passes "Endless #N"). */
  label?: string;
}) {
  const { won, hintsUsed, guessCount, activeSeconds, usedFinalChoice } = opts;
  const filled = won ? hintsUsed : HINT_COUNT; // loss fills the whole ladder
  const solid = solidSquare(filled);
  let bar = "";
  for (let i = 0; i < HINT_COUNT; i++) {
    bar += i < filled ? solid : EMPTY;
  }
  const mark = won ? "✓" : "✗";
  const score = won ? `${hintsUsed}/${HINT_COUNT}` : `X/${HINT_COUNT}`;
  const tries = `${guessCount} ${guessCount === 1 ? "try" : "tries"}`;
  const mc = usedFinalChoice ? " 🎯" : "";
  const time = `⏱ ${formatTime(activeSeconds)}`;
  return `Something of Isaac · ${opts.label ?? formatDate()}\n${mark} ${score} hints · ${tries}${mc}\n${bar}  ${time}\n${SHARE_SITE_URL}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
