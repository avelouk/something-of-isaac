/**
 * Generate data/schedule.json — a 2-year, deterministic mapping of
 * puzzleNumber -> itemId.
 *
 * - Weighted by item quality (well-known quality-2/3 items appear more
 *   often; obscure quality-0 items rarer).
 * - 14-day no-repeat lookback so players don't see the same item twice
 *   in a fortnight.
 * - sha256(itemId + salt + puzzleNumber) committed alongside each
 *   entry as cheap anti-cheat (devtools users still win — fine).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { weightedDraw } from "../src/puzzle.ts";

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
const SCHEDULE_VERSION = 1;
const SALT = "isaac-daily-guess-v1";

type Item = { id: number; quality: number };

function main() {
  const items: Item[] = JSON.parse(
    readFileSync(resolve(ROOT, "public/data/items.json"), "utf8"),
  );
  // Stable order: by id ascending. weightedDraw consumes items[i] by index.
  items.sort((a, b) => a.id - b.id);

  const weights = items.map((it) => QUALITY_WEIGHT[it.quality] ?? 1.0);
  const recentIndices: number[] = []; // FIFO of last N draws (by index into items[])

  const entries: { n: number; itemId: number; hash: string }[] = [];
  for (let n = 1; n <= TOTAL_DAYS; n++) {
    const exclude = new Set(recentIndices);
    const { value, index } = weightedDraw(items, weights, `${SALT}:${n}`, exclude);
    const itemId = value.id;
    const hash = createHash("sha256").update(`${itemId}:${SALT}:${n}`).digest("hex").slice(0, 16);
    entries.push({ n, itemId, hash });
    recentIndices.push(index);
    if (recentIndices.length > NO_REPEAT_WINDOW) recentIndices.shift();
  }

  const schedule = { version: SCHEDULE_VERSION, salt: SALT, entries };
  writeFileSync(resolve(ROOT, "public/data/schedule.json"), JSON.stringify(schedule));

  // Quick sanity report.
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
    console.log(`    n=${e.n} -> #${it.id} Q${it.quality} hash=${e.hash}`);
  }
}

main();
