/**
 * Generate data/schedule.json — a 2-year mapping of UTC calendar day → itemId.
 *
 * Each row: { date, n, itemId, hash, hints? } where date is YYYY-MM-DD (UTC)
 * and n matches puzzleNumberToUtcDateString⁻¹ (see src/puzzle.ts).
 *
 * - Weighted by item quality (well-known quality-2/3 items appear more
 *   often; obscure quality-0 items rarer).
 * - 14-day no-repeat lookback so players don't see the same item twice
 *   in a fortnight.
 * - sha256(itemId + salt + puzzleNumber) committed alongside each
 *   entry as cheap anti-cheat (devtools users still win — fine).
 * - Preserves hand-authored `hints` when date + itemId match the previous file.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { weightedDraw, puzzleNumberToUtcDateString } from "../src/puzzle.ts";
import { HINT_COUNT } from "../src/hints.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const QUALITY_WEIGHT: Record<number, number> = {
  0: 0.6,
  1: 1.0,
  2: 1.2,
  3: 1.0,
  4: 0.7,
};

const NO_REPEAT_WINDOW = 14;
const TOTAL_DAYS = 365 * 2; // 2 years
const SCHEDULE_VERSION = 2;
const SALT = "isaac-daily-guess-v1";

type Item = { id: number; quality: number };

const SCHEDULE_PATH = resolve(ROOT, "public/data/schedule.json");

function loadHintsToPreserve(): Map<string, { itemId: number; hints: string[] }> {
  const map = new Map<string, { itemId: number; hints: string[] }>();
  if (!existsSync(SCHEDULE_PATH)) return map;
  try {
    const prev = JSON.parse(readFileSync(SCHEDULE_PATH, "utf8")) as {
      entries?: { date?: string; n: number; itemId: number; hints?: string[] }[];
    };
    for (const e of prev.entries ?? []) {
      if (!Array.isArray(e.hints) || e.hints.length !== HINT_COUNT) continue;
      const dateKey = typeof e.date === "string" ? e.date : puzzleNumberToUtcDateString(e.n);
      map.set(dateKey, { itemId: e.itemId, hints: e.hints });
    }
  } catch {
    /* ignore corrupt schedule */
  }
  return map;
}

function main() {
  const items: Item[] = JSON.parse(
    readFileSync(resolve(ROOT, "public/data/items.json"), "utf8"),
  );
  items.sort((a, b) => a.id - b.id);

  const weights = items.map((it) => QUALITY_WEIGHT[it.quality] ?? 1.0);
  const recentIndices: number[] = [];
  const preserveHints = loadHintsToPreserve();

  const entries: {
    date: string;
    n: number;
    itemId: number;
    hash: string;
    hints?: string[];
  }[] = [];

  for (let n = 1; n <= TOTAL_DAYS; n++) {
    const date = puzzleNumberToUtcDateString(n);
    const exclude = new Set(recentIndices);
    const { value, index } = weightedDraw(items, weights, `${SALT}:${n}`, exclude);
    const itemId = value.id;
    const hash = createHash("sha256").update(`${itemId}:${SALT}:${n}`).digest("hex").slice(0, 16);
    const kept = preserveHints.get(date);
    const hints =
      kept && kept.itemId === itemId && kept.hints.length === HINT_COUNT ? kept.hints : undefined;
    entries.push({ date, n, itemId, hash, ...(hints ? { hints } : {}) });
    recentIndices.push(index);
    if (recentIndices.length > NO_REPEAT_WINDOW) recentIndices.shift();
  }

  const schedule = { version: SCHEDULE_VERSION, salt: SALT, entries };
  writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule));

  const counts: Record<number, number> = {};
  for (const e of entries) counts[e.itemId] = (counts[e.itemId] ?? 0) + 1;
  const distinct = Object.keys(counts).length;
  const max = Math.max(...Object.values(counts));
  const min = Math.min(...Object.values(counts));
  console.log(`schedule v${SCHEDULE_VERSION}: ${entries.length} days, ${items.length} items in pool`);
  console.log(`  distinct items used: ${distinct}/${items.length}`);
  console.log(`  per-item appearances: min=${min} max=${max}`);
  console.log(`  first 5 entries:`);
  for (const e of entries.slice(0, 5)) {
    const it = items.find((i) => i.id === e.itemId)!;
    console.log(`    ${e.date} n=${e.n} -> #${it.id} Q${it.quality} hash=${e.hash}`);
  }
}

main();
