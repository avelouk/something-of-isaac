/**
 * Generate data/schedule.json — UTC calendar day → itemId, with NO duplicates.
 *
 * Rules:
 * - Everything from launch through *today* (UTC) is preserved verbatim (item + hints).
 *   Those puzzles have already been played; we never rewrite history.
 * - The future is regenerated as a stream of shuffled "cycles". A cycle is a random
 *   permutation in which every item appears exactly once, so an item never repeats
 *   until the whole pool (719 items) has been used. The first future cycle is finished
 *   off with only the items not yet shown in the preserved past, so across the first
 *   ~719 days each item appears once. When the pool is exhausted we reshuffle and start
 *   a fresh cycle (chosen by the user: loop forever).
 * - On top of per-cycle uniqueness, no item may repeat within NO_REPEAT_DAYS (100) of
 *   its previous appearance — this only bites at cycle boundaries and is enforced by a
 *   greedy "skip anything used in the trailing window" placement.
 * - sha256(itemId:salt:puzzleNumber) committed alongside each entry as cheap anti-cheat;
 *   the same salt is kept so preserved rows keep their existing hash, and it matches the
 *   worker's hashEntryAsync.
 *
 * The base for the preserved past is the live backend if reachable (so authored hints
 * survive repeated regenerations), else the committed schedule.json.
 *
 * After writing schedule.json (the offline fallback), seed the backend with
 * `npm run push:schedule`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import seedrandom from "seedrandom";
import {
  puzzleNumberToUtcDateString,
  utcDateStringToPuzzleNumber,
  utcTodayDateString,
  type Schedule,
  type ScheduleEntry,
} from "../src/puzzle.ts";
import { HINT_COUNT } from "../src/hints.ts";
import { loadDotenvLocal } from "./env.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const NO_REPEAT_DAYS = 100; // no item may recur within this many days
const TOTAL_DAYS = 365 * 5; // horizon (~5 years; loops through the pool as needed)
const SCHEDULE_VERSION = 2;
const SALT = "isaac-daily-guess-v1";

// One file serves two roles: the offline fallback shipped to the client, and the seed
// pushed to SCHEDULE_KV (`npm run push:schedule`).
const SCHEDULE_PATH = resolve(ROOT, "public/data/schedule.json");
const ITEMS_PATH = resolve(ROOT, "public/data/items.json");

type Item = { id: number };

function hashEntry(itemId: number, n: number): string {
  return createHash("sha256").update(`${itemId}:${SALT}:${n}`).digest("hex").slice(0, 16);
}

function validHints(h: unknown): h is string[] {
  return Array.isArray(h) && h.length === HINT_COUNT && h.every((x) => typeof x === "string");
}

/**
 * Best-effort overlay so authored hints/items survive a regeneration:
 *   - authed GET /schedule  → the new KV store (repeat runs)
 *   - public GET /hints      → the old overlay store (first migration only)
 * Merges { itemId?, hints? } onto the base by date. Never throws.
 */
async function mergeLiveOverrides(base: Schedule): Promise<void> {
  const workerUrl = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
  const token = process.env.ADMIN_TOKEN ?? "";
  if (!workerUrl) return;
  const byDate = new Map(base.entries.map((e) => [e.date, e]));

  // New store (full schedule) — authoritative for already-stored rows.
  if (token) {
    try {
      const r = await fetch(`${workerUrl}/schedule`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const live = (await r.json()) as Schedule;
        for (const e of live.entries ?? []) {
          const cur = byDate.get(e.date);
          if (!cur) continue;
          cur.itemId = e.itemId;
          if (validHints(e.hints)) cur.hints = e.hints;
          else delete cur.hints;
        }
        console.log(`  merged ${live.entries?.length ?? 0} rows from backend /schedule`);
        return;
      }
    } catch {
      /* fall through to /hints */
    }
  }

  // Old overlay store — used for the one-time migration. The historical blob mixes two
  // shapes: a bare hints array (oldest) and { hints, itemId? } (newer). Handle both, or
  // the bare-array entries silently lose their authored hints.
  try {
    const r = await fetch(`${workerUrl}/hints`);
    if (!r.ok) return;
    const overrides = (await r.json()) as Record<string, unknown>;
    let n = 0;
    for (const [date, raw] of Object.entries(overrides)) {
      const cur = byDate.get(date);
      if (!cur) continue;
      const hints = Array.isArray(raw) ? raw : (raw as { hints?: unknown })?.hints;
      const itemId = Array.isArray(raw) ? undefined : (raw as { itemId?: unknown })?.itemId;
      if (typeof itemId === "number" && Number.isFinite(itemId)) cur.itemId = itemId;
      if (validHints(hints)) cur.hints = hints;
      n++;
    }
    if (n) console.log(`  merged ${n} rows from legacy /hints overlay`);
  } catch {
    /* offline — fall back to committed schedule.json */
  }
}

function shuffle<T>(arr: T[], seed: string): T[] {
  const rng = seedrandom(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  loadDotenvLocal(ROOT);

  const items: Item[] = JSON.parse(readFileSync(ITEMS_PATH, "utf8"));
  const allIds = items.map((it) => it.id).sort((a, b) => a - b);
  const idSet = new Set(allIds);

  const base = JSON.parse(readFileSync(SCHEDULE_PATH, "utf8")) as Schedule;
  await mergeLiveOverrides(base);

  const today = utcTodayDateString();
  const todayN = utcDateStringToPuzzleNumber(today);
  console.log(`Preserving puzzles #1..#${todayN} (through ${today}); regenerating the rest.`);

  // Preserved past (date <= today), verbatim, sorted by n.
  const baseByDate = new Map(base.entries.map((e) => [e.date, e]));
  const entries: ScheduleEntry[] = [];
  const seq: number[] = []; // itemId per day in order — for the trailing-window check
  const pastItems = new Set<number>();

  for (let n = 1; n <= todayN; n++) {
    const date = puzzleNumberToUtcDateString(n);
    const prev = baseByDate.get(date);
    if (!prev || !idSet.has(prev.itemId)) {
      throw new Error(`missing/invalid preserved entry for ${date} (#${n})`);
    }
    const e: ScheduleEntry = {
      date,
      n,
      itemId: prev.itemId,
      hash: hashEntry(prev.itemId, n),
      ...(validHints(prev.hints) ? { hints: prev.hints } : {}),
    };
    entries.push(e);
    seq.push(e.itemId);
    pastItems.add(e.itemId);
  }

  // Future stream of shuffled cycles. Cycle 1 = items not yet shown in the past.
  let cycle = 0;
  let pool = shuffle(
    allIds.filter((id) => !pastItems.has(id)),
    `${SALT}:c1`,
  );

  const windowHas = (id: number): boolean => {
    const start = Math.max(0, seq.length - NO_REPEAT_DAYS);
    for (let i = start; i < seq.length; i++) if (seq[i] === id) return true;
    return false;
  };

  for (let n = todayN + 1; n <= TOTAL_DAYS; n++) {
    if (pool.length === 0) {
      cycle++;
      pool = shuffle(allIds, `${SALT}:c${cycle + 1}`);
    }
    // Greedy: first pooled item not used within the trailing NO_REPEAT_DAYS window.
    // Within a cycle every item is unique, so the only blocked items are the previous
    // cycle's tail; with a pool much larger than the window one is always available.
    const pick = pool.findIndex((id) => !windowHas(id));
    if (pick === -1) {
      // Only possible if the item pool shrinks below ~NO_REPEAT_DAYS. Fail loudly
      // rather than silently emit a duplicate / sub-window repeat.
      throw new Error(
        `cannot place puzzle #${n}: every remaining item (pool ${pool.length}) is within the ` +
          `${NO_REPEAT_DAYS}-day window. Pool too small for the no-repeat rule.`,
      );
    }
    const [itemId] = pool.splice(pick, 1);

    const date = puzzleNumberToUtcDateString(n);
    entries.push({ date, n, itemId, hash: hashEntry(itemId, n) });
    seq.push(itemId);
  }

  const schedule: Schedule = { version: SCHEDULE_VERSION, salt: SALT, entries };

  // --- self-check BEFORE writing anything ---
  // Any repeat whose *later* occurrence is in the regenerated future must be > the
  // window. Repeats entirely within the preserved past are pre-existing and allowed.
  let minFutureGap = Infinity;
  let pastDupCount = 0;
  const lastSeen = new Map<number, number>();
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i].itemId;
    const prevIdx = lastSeen.get(id);
    if (prevIdx !== undefined) {
      const gap = i - prevIdx;
      const laterIsFuture = i + 1 > todayN; // entry index i is puzzle #(i+1)
      if (laterIsFuture) minFutureGap = Math.min(minFutureGap, gap);
      else pastDupCount++;
    }
    lastSeen.set(id, i);
  }
  if (minFutureGap <= NO_REPEAT_DAYS) {
    throw new Error(`future repeat gap ${minFutureGap} ≤ ${NO_REPEAT_DAYS} — generation bug, nothing written`);
  }

  writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule));

  const futureCount = entries.length - todayN;
  console.log(`schedule v${SCHEDULE_VERSION}: ${entries.length} days (${todayN} preserved, ${futureCount} regenerated)`);
  console.log(`  range: ${entries[0].date} .. ${entries.at(-1)!.date}`);
  console.log(`  pool: ${allIds.length} items; smallest future repeat gap: ${minFutureGap} days (> ${NO_REPEAT_DAYS} ✓)`);
  if (pastDupCount) console.log(`  preserved past contains ${pastDupCount} pre-existing repeat(s) — left untouched by design`);
  console.log(`  → public/data/schedule.json (full schedule: fallback + \`npm run push:schedule\` seed)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
