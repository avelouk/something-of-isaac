/**
 * Generate per-item hint ladders for endless mode → public/data/ladders.json.
 *
 *   npm run build:ladders            # all items missing from ladders.json
 *   npm run build:ladders -- --limit 12   # small sample run
 *
 * Hint 1 is templated ("It is a Quality N Passive Item.") so it can never be
 * wrong; hints 2–6 come from `claude -p` (headless Claude CLI), few-shot
 * prompted with the hand-authored ladders pulled live from the worker so the
 * style matches. Unlock methods and trivia come from scripts/wiki-extra.json
 * (written by refresh:wiki). Output is validated (5 hints, length caps, no
 * item-name leakage) and written incrementally, so the script is safe to
 * re-run and only fills gaps.
 *
 * Requires WORKER_URL and ADMIN_TOKEN in .env.local (for the style reference)
 * and a logged-in `claude` CLI.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Item } from "../src/hints.ts";
import type { Schedule } from "../src/puzzle.ts";
import { fold } from "../src/ui/autocomplete.ts";
import { loadDotenvLocal } from "./env.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ITEMS_PATH = resolve(ROOT, "public/data/items.json");
const QUOTES_PATH = resolve(ROOT, "public/data/quotes.json");
const EXTRA_PATH = resolve(ROOT, "scripts/wiki-extra.json");
const LADDERS_PATH = resolve(ROOT, "public/data/ladders.json");

const BATCH_SIZE = 10;
const CONCURRENCY = 2;
const MODEL = "sonnet";
const HINT_MIN = 10;
const HINT_MAX = 140;
/** Base pause after a dead wave; doubles per consecutive failure (usage-limit windows can last a while). */
const BACKOFF_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
/** Give up after this many consecutive dead waves at max backoff — the CLI is not coming back. */
const MAX_DEAD_WAVES = 8;

type WikiExtra = Record<string, { unlock?: string; trivia?: string[] }>;

function hint1For(item: Item): string {
  const kind =
    item.type === "familiar"
      ? "Familiar"
      : `${item.type.charAt(0).toUpperCase() + item.type.slice(1)} Item`;
  return `It is a Quality ${item.quality} ${kind}.`;
}

type AuthoredRef = { name: string; hints: string[] };

async function fetchAuthoredRefs(items: Map<number, Item>): Promise<AuthoredRef[]> {
  const workerUrl = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
  const token = process.env.ADMIN_TOKEN ?? "";
  if (!workerUrl || !token) {
    throw new Error("Set WORKER_URL and ADMIN_TOKEN in .env.local");
  }
  const r = await fetch(`${workerUrl}/schedule`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`GET /schedule failed: ${r.status}`);
  const schedule = (await r.json()) as Schedule;
  return schedule.entries
    .filter((e) => e.hints?.length === 6 && e.hints.every((h) => h.trim().length >= HINT_MIN))
    .map((e) => ({ name: items.get(e.itemId)?.name ?? `item ${e.itemId}`, hints: e.hints! }));
}

function itemBlock(it: Item, quotes: Record<number, string>, extra: WikiExtra): string {
  const x = extra[String(it.id)] ?? {};
  const lines = [
    `id ${it.id} | ${it.name} | Quality ${it.quality} | ${it.type} | DLC: ${it.dlc} | Pools: ${it.pools.join(", ") || "none"}`,
    `  Pickup quote: "${quotes[it.id] ?? ""}"`,
    `  Effect: ${it.description.replace(/\s+/g, " ").slice(0, 450)}`,
  ];
  if (x.unlock) lines.push(`  Unlock: ${x.unlock.slice(0, 160)}`);
  if (x.trivia?.length) {
    lines.push(...x.trivia.slice(0, 3).map((t) => `  Trivia: ${t.replace(/\s+/g, " ").slice(0, 200)}`));
  }
  return lines.join("\n");
}

function buildPrompt(
  refs: AuthoredRef[],
  batch: Item[],
  quotes: Record<number, string>,
  extra: WikiExtra,
): string {
  const examples = refs
    .slice(0, 10)
    .map((r) => `${r.name}:\n${r.hints.map((h, i) => `${i + 1}. ${h.trim()}`).join("\n")}`)
    .join("\n\n");

  return `You write hint ladders for "Something of Isaac", a Binding of Isaac item-guessing game. Players see hints one at a time; there are ~700 possible items. Every hint must narrow the field with ONE new fact.

For each item below, write hints 2 through 6 (hint 1 is templated elsewhere as "It is a Quality N ... Item.").

THE ONE RULE: each hint states exactly ONE fact in one short sentence. No compound facts, no commentary, no "great for..." filler. If a hint could be split in two, it's wrong.

Ladder roles:
2. One oblique property of the effect — a limitation, trigger, side effect, or number. NEVER the headline effect; after hint 2 a veteran should still have dozens of candidates.
3. One lateral association: wordplay on the name, what the object is in real life, or a cultural reference. Trivia lines are gold here. If the item is named directly after the real-world object, do NOT describe that object plainly (it gives the name away) — use a more oblique angle instead.
4. The unlock method if an "Unlock:" line is provided (phrase it "Unlocked by ..."). Otherwise ONE relation fact: an item pool, or a connection to another item, trinket, or character.
5. One clearly identifying gameplay fact — the effect or behavior, stated without the name.
6. Near-giveaway: what the sprite depicts, or the single most defining detail.

Rules:
- Difficulty strictly falls: after hint 6 nearly everyone should know the answer; after hint 2 almost no one.
- Each hint under 120 characters.
- NEVER include the item's name, or a distinctive word from it, in any hint. Oblique references to the name ("its name sounds like...") are good.
- Only use facts from the item's provided lines. Never invent unlocks, numbers, pools, or references.
- Keep the source's exact strength of wording: if the data says "range", don't write "power"; a boss is a "boss", not a "superboss".
- No two hints in a ladder may state the same underlying fact. Hint 5 owns the effect — hint 6 must NOT restate it; describe the sprite or another defining detail instead.

Hand-written ladders from the game — match this voice and terseness exactly:

${examples}

Items:
${batch.map((it) => itemBlock(it, quotes, extra)).join("\n")}

Output a single JSON object mapping each item id (as a string key) to an array of exactly 5 strings (hints 2–6). Output only the JSON, no other text.`;
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(
      "claude",
      ["-p", "--model", MODEL],
      { maxBuffer: 10 * 1024 * 1024, timeout: 10 * 60_000 },
      (err, stdout, stderr) =>
        err ? rej(new Error(`${err.message} — ${String(stderr).slice(0, 300)}`)) : res(stdout),
    );
    child.stdin!.end(prompt);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in output");
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

function validateHints(item: Item, hints: unknown): string[] | null {
  if (!Array.isArray(hints) || hints.length !== 5) return null;
  const foldedName = fold(item.name);
  for (const h of hints) {
    if (typeof h !== "string") return null;
    const t = h.trim();
    if (t.length < HINT_MIN || t.length > HINT_MAX) return null;
    // Reject the full name anywhere in a hint (names ≤2 chars like "D6" would
    // false-positive on ordinary words, so only check meaningful names).
    if (foldedName.length > 2 && fold(t).includes(foldedName)) return null;
  }
  return (hints as string[]).map((h) => h.trim());
}

function readLadders(): Record<string, string[]> {
  if (!existsSync(LADDERS_PATH)) return {};
  return JSON.parse(readFileSync(LADDERS_PATH, "utf8")) as Record<string, string[]>;
}

function writeLadders(ladders: Record<string, string[]>): void {
  const sorted = Object.fromEntries(
    Object.entries(ladders).sort(([a], [b]) => Number(a) - Number(b)),
  );
  writeFileSync(LADDERS_PATH, JSON.stringify(sorted));
}

async function processBatch(
  batch: Item[],
  refs: AuthoredRef[],
  quotes: Record<number, string>,
  extra: WikiExtra,
): Promise<{ ok: Record<string, string[]>; failed: Item[] }> {
  const ok: Record<string, string[]> = {};
  const failed: Item[] = [];
  try {
    const raw = await runClaude(buildPrompt(refs, batch, quotes, extra));
    const parsed = extractJson(raw);
    for (const item of batch) {
      const valid = validateHints(item, parsed[String(item.id)]);
      if (valid) ok[String(item.id)] = [hint1For(item), ...valid];
      else failed.push(item);
    }
  } catch (e) {
    console.error(`  batch error (${batch.length} items): ${e instanceof Error ? e.message : e}`);
    failed.push(...batch);
  }
  return { ok, failed };
}

async function main() {
  loadDotenvLocal(ROOT);
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  if (Number.isNaN(limit)) {
    throw new Error("--limit needs a numeric value");
  }

  const items = JSON.parse(readFileSync(ITEMS_PATH, "utf8")) as Item[];
  const quotes = JSON.parse(readFileSync(QUOTES_PATH, "utf8")) as Record<number, string>;
  const extra: WikiExtra = existsSync(EXTRA_PATH)
    ? (JSON.parse(readFileSync(EXTRA_PATH, "utf8")) as WikiExtra)
    : {};
  if (Object.keys(extra).length === 0) {
    console.warn("scripts/wiki-extra.json missing/empty — run `npm run refresh:wiki` first for unlock/trivia hints.");
  }
  const byId = new Map(items.map((i) => [i.id, i]));

  const refs = await fetchAuthoredRefs(byId);
  console.log(`Style reference: ${refs.length} authored ladders from the backend.`);

  const ladders = readLadders();
  const todo = items.filter((it) => !ladders[String(it.id)]).slice(0, limit);
  console.log(`${Object.keys(ladders).length} ladders exist, ${todo.length} to generate.`);
  if (todo.length === 0) return;

  const batches: Item[][] = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

  const retry: Item[] = [];
  let done = 0;
  let consecDead = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const wave = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(wave.map((b) => processBatch(b, refs, quotes, extra)));
    // A wave with zero successes means the CLI itself is down/limited (partial
    // results just mean some items failed validation). Re-run the wave after
    // a growing backoff instead of enqueueing its items as retries.
    const dead = results.every((r) => Object.keys(r.ok).length === 0);
    if (dead) {
      consecDead++;
      if (consecDead >= MAX_DEAD_WAVES) {
        console.error(`CLI dead for ${MAX_DEAD_WAVES} consecutive waves — giving up; re-run later to resume.`);
        break;
      }
      const wait = Math.min(BACKOFF_MS * 2 ** (consecDead - 1), BACKOFF_MAX_MS);
      console.log(`  CLI returning nothing — backing off ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
      i -= CONCURRENCY; // repeat this wave
      continue;
    }
    consecDead = 0;
    for (const r of results) {
      Object.assign(ladders, r.ok);
      retry.push(...r.failed);
      done += Object.keys(r.ok).length;
    }
    writeLadders(ladders);
    console.log(`  ${done}/${todo.length} generated (${retry.length} pending retry)`);
  }

  // One retry pass, single items — these are validation rejects, not outages.
  // Bail if the CLI stops responding.
  if (retry.length > 0) {
    console.log(`Retrying ${retry.length} items individually…`);
    let deadRuns = 0;
    for (let i = 0; i < retry.length && deadRuns < 5; i += CONCURRENCY) {
      const wave = retry
        .slice(i, i + CONCURRENCY)
        .map((it) => processBatch([it], refs, quotes, extra));
      for (const r of await Promise.all(wave)) {
        Object.assign(ladders, r.ok);
        deadRuns = Object.keys(r.ok).length === 0 ? deadRuns + 1 : 0;
      }
      writeLadders(ladders);
    }
  }

  const missing = items.filter((it) => !ladders[String(it.id)]);
  console.log(
    `Done: ${Object.keys(ladders).length}/${items.length} ladders.` +
      (missing.length ? ` Still missing: ${missing.length} items.` : ""),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
