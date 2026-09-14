/**
 * Generate per-item hint ladders for endless mode → public/data/ladders.json.
 *
 *   npm run build:ladders            # all items missing from ladders.json
 *   npm run build:ladders -- --limit 12   # small sample run
 *
 * Hint 1 is templated ("It is a Quality N Passive Item.") from items.json, so
 * it can never be wrong — provided refresh:wiki has run, since quality is
 * DLC-conditional for ~20% of items and Platinum God carries the pre-Repentance
 * value. Hints 2–6 come from `claude -p` (headless Claude CLI), few-shot
 * prompted with hand-authored ladders pulled live from the worker.
 *
 * Facts come from scripts/wiki-extra.json (written by refresh:wiki): unlock
 * method, plus the wiki's Effects/Notes/Trivia bullets. Those bullets are what
 * make hints 2–4 possible — the infobox description alone only yields the
 * headline effect, which is hint 5/6 material.
 *
 * Output is validated (5 hints, length caps, no item-name leakage including
 * distinctive single words) and written incrementally, so the script is safe
 * to re-run and only fills gaps. Delete an entry from ladders.json to have it
 * regenerated.
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
const SPRITES_PATH = resolve(ROOT, "scripts/sprite-descriptions.json");

const BATCH_SIZE = 10;
const CONCURRENCY = 5;
const MODEL = "opus";
const HINT_MIN = 10;
const HINT_MAX = 140;
/** Base pause after a dead wave; doubles per consecutive failure (usage-limit windows can last a while). */
const BACKOFF_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
/** Consecutive dead waves before giving up. At the 15min backoff ceiling this
 * waits ~7h, enough to ride out a full usage-limit window and self-complete. */
const MAX_DEAD_WAVES = 30;

type WikiExtra = Record<
  string,
  { unlock?: string; trivia?: string[]; effects?: string[]; notes?: string[] }
>;

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

const clean = (s: string, n: number) => s.replace(/\s+/g, " ").slice(0, n);

function itemBlock(
  it: Item,
  quotes: Record<number, string>,
  extra: WikiExtra,
  sprites: Record<string, string>,
  generic: Set<string>,
): string {
  const x = extra[String(it.id)] ?? {};
  // Quality is deliberately omitted — hint 1 is templated from items.json, and
  // showing the number here only invites the model to restate it in hint 2.
  const lines = [
    `id ${it.id} | ${it.name} | ${it.type} | DLC: ${it.dlc} | Pools: ${it.pools.join(", ") || "none"}`,
    `  Pickup quote: "${quotes[it.id] ?? ""}"`,
    `  Effect: ${clean(it.description, 450)}`,
  ];
  if (x.unlock) lines.push(`  Unlock: ${clean(x.unlock, 160)}`);
  for (const e of x.effects?.slice(0, 6) ?? []) lines.push(`  Detail: ${clean(e, 240)}`);
  for (const n of x.notes?.slice(0, 5) ?? []) lines.push(`  Note: ${clean(n, 240)}`);
  for (const t of x.trivia?.slice(0, 3) ?? []) lines.push(`  Trivia: ${clean(t, 220)}`);
  const sprite = sprites[String(it.id)];
  if (sprite) lines.push(`  Sprite: ${clean(sprite, 200)}`);
  // Mirrors validateHints: substring match, so "coin" also bans "coins".
  const banned = bannedWords(it, generic);
  if (banned.length) {
    lines.push(`  Forbidden (rejected if any hint contains these, even inside another word): ${banned.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Hand-authored ladders used as the style reference. Chosen to cover every
 * hint category (unlock, pool, transformation, name association, oblique
 * effect property, sprite, quote) and all three item types.
 *
 * This list is the single biggest lever on output quality. The previous
 * version took `refs.slice(0, 10)` — the ten *earliest* authored ladders,
 * written before the style settled — and fitted every generated ladder to
 * them. Prefer editing this list over editing the prompt.
 */
const STYLE_EXEMPLARS = [
  "Bird's Eye",
  "Zodiac",
  "The Virus",
  "Fortune Cookie",
  "More Options",
  "Camo Undies",
  "Finger!",
  "The Negative",
  "Greed's Gullet",
  "YO LISTEN!",
];
const EXEMPLAR_TARGET = 12;

/** Named exemplars first, topped up with the most *recent* authored ladders. */
function pickExemplars(refs: AuthoredRef[]): AuthoredRef[] {
  const byName = new Map(refs.map((r) => [r.name, r]));
  const picked: AuthoredRef[] = [];
  const seen = new Set<string>();
  for (const name of STYLE_EXEMPLARS) {
    const r = byName.get(name);
    if (r && !seen.has(name)) picked.push(r), seen.add(name);
  }
  for (const r of [...refs].reverse()) {
    if (picked.length >= EXEMPLAR_TARGET) break;
    if (!seen.has(r.name)) picked.push(r), seen.add(r.name);
  }
  return picked;
}

function buildPrompt(
  refs: AuthoredRef[],
  batch: Item[],
  quotes: Record<number, string>,
  extra: WikiExtra,
  sprites: Record<string, string>,
  generic: Set<string>,
): string {
  const examples = pickExemplars(refs)
    .map((r) => `${r.name}:\n${r.hints.map((h, i) => `${i + 1}. ${h.trim()}`).join("\n")}`)
    .join("\n\n");

  return `You write hint ladders for "Something of Isaac", a daily item-guessing game for
The Binding of Isaac (Repentance). Players see one hint at a time and guess the
item. There are ~718 possible items.

For each item below, write hints 2 through 6. Hint 1 is templated elsewhere as
"It is a Quality N Passive Item." — do not write it, and do not mention the
item's quality anywhere in your hints.

USE ONLY THE FACTS GIVEN
Every hint must be traceable to a line in that item's block below. Do not use
anything you remember about this game — if it is not in the block, you do not
know it. Never invent an unlock, a number, a pool, or a reference. The game is
on REPENTANCE: where a line describes both an old and a current behaviour,
describe the current one.

THE SHAPE OF THE LADDER
Difficulty falls. After hint 2 almost nobody should know it; after hint 6
almost everybody should.

Hints 2, 3, 4 — three NARROWING facts, each from a DIFFERENT category below.
None may identify the item on its own.
  - How it is unlocked ("Unlocked by ...")
  - Where it is found: item pool, room type, which beggar or miniboss drops it
  - A transformation it counts toward
  - Its name: wordplay, the real-world object, a cultural or game reference
  - An oblique property of the effect: a limitation, a trigger, a number, a
    chance, something it does NOT do, an enemy it does not work on
  - A challenge or seed it appears in
  - An interaction with a specific character, item or trinket

Pick the three most interesting for this item. Do not force a category that has
nothing good to say — a flat hint is worse than using a different category. If
the natural fact for a slot would leak the name, use a different category
rather than a weaker phrasing of the same fact. Order them yourself, hardest
first.

Hint 5 — the effect, stated plainly and completely, without the name.
Hint 6 — the giveaway: the pickup quote, or what the item looks like.
Swap 5 and 6 when the quote or appearance is more cryptic than the effect.

The "Sprite:" line, where present, is a description of the item's actual
in-game artwork, written by someone who was shown the picture and not told the
item's name. It is reliable — use it for the appearance hint, rephrased in your
own words rather than quoted wholesale, and trimmed to the one or two details
that would make a player recognise it.

If there is no Sprite line, use the pickup quote or a second identifying fact
instead. NEVER guess at the artwork from the item's name: "its sprite is a tube
of eyelash makeup" is an invention, not a hint.

HARD RULES
- One fact per hint, one sentence. If a hint could be split in two, split it
  and drop the weaker half.
- NEVER write the item's name or any distinctive word from it. The source
  lines below often name the item outright — that is a trap, not a licence.
  Oblique references to the name are good: describing the real-world object
  the item is named after is exactly right, as long as you avoid the word.
- No two hints may rest on the same underlying fact. Hint 5 owns the effect,
  so hint 6 must not restate it.
- Keep the source's exact strength of wording. "chance to" is not "always";
  range is not power; a boss is a boss.
- Under 120 characters per hint.

VOICE
Short, plain, declarative. Call the item "It", or address the player as "you"
when describing an effect. No marketing voice, no "great for", no opinion on
whether the item is good. Write like a person noting a fact. A dry joke in
hint 6 is fine about one ladder in ten, never forced.

HAND-WRITTEN LADDERS FROM THE GAME — MATCH THIS VOICE AND TERSENESS
(hint 1 is shown for context; you are writing 2-6)

${examples}

ITEMS

${batch.map((it) => itemBlock(it, quotes, extra, sprites, generic)).join("\n\n")}

OUTPUT
A single JSON object mapping each item id (as a string key) to an array of
exactly 5 strings (hints 2-6). Output only the JSON, no other text.`;
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

/**
 * Words that recur across many item names ("bombs", "baby", "eye", "ball") are
 * generic — banning them would make whole ladders unwritable, and using one
 * gives almost nothing away when a dozen items share it. A word that belongs
 * to only a handful of names is distinctive, and using it is a leak.
 *
 * At a threshold of 6 this blocks "greed" (1 name), "ring" (2) and "black" (5)
 * while allowing "bombs" (12) and "ball" (6) — which is where a human drew the
 * line on the same ladders.
 */
const GENERIC_NAME_WORD_MIN = 6;

function buildGenericWords(items: Item[]): Set<string> {
  const freq = new Map<string, number>();
  for (const it of items) {
    for (const w of new Set(nameWords(it.name))) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return new Set([...freq].filter(([, n]) => n >= GENERIC_NAME_WORD_MIN).map(([w]) => w));
}

/** Function words in names ("Telepathy for Dummies", "Tooth and Nail") carry
 * no signal, and since matching is by substring, banning "for" or "and" would
 * reject nearly every sentence. */
const STOPWORDS = new Set(["the", "and", "for", "with", "you", "your", "not"]);

function nameWords(name: string): string[] {
  return (fold(name).match(/[a-z]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

function bannedWords(item: Item, generic: Set<string>): string[] {
  return nameWords(item.name).filter((w) => !generic.has(w));
}

function validateHints(item: Item, hints: unknown, generic: Set<string>): string[] | null {
  if (!Array.isArray(hints) || hints.length !== 5) return null;
  const foldedName = fold(item.name);
  const banned = bannedWords(item, generic);
  for (const h of hints) {
    if (typeof h !== "string") return null;
    const t = h.trim();
    if (t.length < HINT_MIN || t.length > HINT_MAX) return null;
    const folded = fold(t);
    // Reject the full name anywhere in a hint (names ≤2 chars like "D6" would
    // false-positive on ordinary words, so only check meaningful names).
    if (foldedName.length > 2 && folded.includes(foldedName)) return null;
    // …and any distinctive word from it. "Unlocked by defeating Ultra Greedier"
    // in an Eye of Greed ladder passes the full-name check and still gives the
    // answer away, so match on word stems rather than whole words.
    for (const w of banned) if (folded.includes(w)) return null;
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
  sprites: Record<string, string>,
  generic: Set<string>,
): Promise<{ ok: Record<string, string[]>; failed: Item[] }> {
  const ok: Record<string, string[]> = {};
  const failed: Item[] = [];
  try {
    const raw = await runClaude(buildPrompt(refs, batch, quotes, extra, sprites, generic));
    const parsed = extractJson(raw);
    for (const item of batch) {
      const valid = validateHints(item, parsed[String(item.id)], generic);
      if (valid) ok[String(item.id)] = [hint1For(item), ...valid];
      else {
        console.error(`  rejected ${item.id} ${item.name}: ${JSON.stringify(parsed[String(item.id)] ?? null).slice(0, 300)}`);
        failed.push(item);
      }
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
  const generic = buildGenericWords(items);
  const sprites: Record<string, string> = existsSync(SPRITES_PATH)
    ? (JSON.parse(readFileSync(SPRITES_PATH, "utf8")) as Record<string, string>)
    : {};
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
    const results = await Promise.all(wave.map((b) => processBatch(b, refs, quotes, extra, sprites, generic)));
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
        .map((it) => processBatch([it], refs, quotes, extra, sprites, generic));
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
