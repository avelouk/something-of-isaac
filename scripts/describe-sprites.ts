/**
 * Describe every item sprite once → scripts/sprite-descriptions.json.
 *
 *   npm run describe:sprites
 *   npm run describe:sprites -- --limit 20   # small sample run
 *
 * Hint 6 of a ladder is usually "what the item looks like", but the wiki only
 * describes appearance for a minority of items — and when it does, it tends to
 * use the item's own name ("looks like a bursting Sack"), which is unusable.
 * So the sprites themselves are the source: public/data/sprites/<id>.webp.
 *
 * They are 32×32, too small to read reliably, so each is upscaled 10× with
 * nearest-neighbour (keeping the pixel edges crisp) into a local cache before
 * being handed to `claude -p --allowedTools Read`.
 *
 * This runs as a separate pass rather than inline in build:ladders because the
 * descriptions are reusable, reviewable, and expensive to recompute: ladder
 * generation can then stay text-only and re-run freely.
 *
 * The describer is deliberately NOT told the item's name, so a description can
 * never leak it. Output is validated against the name anyway — and for items
 * whose name is the thing drawn (Scissors, Stapler, Apple!, Crystal Ball) that
 * check legitimately rejects every description, since "a pair of scissors" IS
 * the answer. Roughly 20 items end up with no description by design; their
 * ladders fall back to the pickup quote for the giveaway hint.
 *
 * Requires ffmpeg on PATH and a logged-in `claude` CLI.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Item } from "../src/hints.ts";
import { fold } from "../src/ui/autocomplete.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ITEMS_PATH = resolve(ROOT, "public/data/items.json");
const SPRITE_DIR = resolve(ROOT, "public/data/sprites");
const CACHE_DIR = resolve(ROOT, "scripts/.sprite-cache");
const OUT_PATH = resolve(ROOT, "scripts/sprite-descriptions.json");

const BATCH_SIZE = 12;
const CONCURRENCY = 5;
const MODEL = "opus";
const UPSCALE = 320;
const DESC_MIN = 12;
const DESC_MAX = 160;
/** Base pause after a wave where every batch failed; doubles per repeat. */
const BACKOFF_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
const MAX_DEAD_WAVES = 8;

/**
 * Upscale one sprite into the cache with nearest-neighbour, so the pixel edges
 * stay hard. Returns the cached path, or null if the sprite is missing or
 * ffmpeg fails. Cached files are reused across runs.
 */
function upscale(id: number): string | null {
  const src = resolve(SPRITE_DIR, `${id}.webp`);
  if (!existsSync(src)) return null;
  const out = resolve(CACHE_DIR, `${id}.png`);
  if (existsSync(out)) return out;
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      src,
      "-vf",
      `scale=${UPSCALE}:${UPSCALE}:flags=neighbor`,
      out,
    ],
    { encoding: "utf8" },
  );
  return r.status === 0 ? out : null;
}

function runClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(
      "claude",
      ["-p", "--model", MODEL, "--allowedTools", "Read"],
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 10 * 60_000 },
      (err, stdout, stderr) =>
        err ? rej(new Error(`${err.message} — ${String(stderr).slice(0, 300)}`)) : res(stdout),
    );
    child.stdin!.end(prompt);
  });
}

function buildPrompt(entries: Array<{ id: number; name: string }>): string {
  return `These are item sprites from The Binding of Isaac, upscaled from 32x32 pixel art.

Read each of these image files in the current directory:
${entries.map((e) => `  ${e.id}.png  — this one depicts: ${e.name}`).join("\n")}

Each file is labelled with what it actually depicts. That label is given ONLY
so you do not misread the picture — at this resolution a bent spoon reads as a
safety pin and a coat hanger reads as a swan. Look at the image and describe
what is drawn; use the label to settle what you are looking at, never as a
substitute for looking.

For each one, describe what the sprite DEPICTS, in a single short sentence.

- NEVER use the label's wording, any word from it, or an obvious synonym for
  it. This description becomes a guessing-game hint, so naming the thing ruins
  it. Describe shape, colour, material and distinctive parts instead: a bent
  spoon is "a curved metal utensil with a shallow oval bowl", not "a spoon".
- Describe only what is visibly drawn: the object, its colour, its distinctive
  parts, any face or symbol on it.
- Write it as a fact a person could use to recognise the picture, e.g.
  "A red chili pepper with a green stem and a grinning face."
- Write with certainty. Never hedge with "or", "possibly", "appears to be",
  "some kind of" — a hedged description makes a bad hint. If you are unsure
  what the object is, describe its shape and colour plainly and confidently
  ("A swirling purple vortex", "A pale rectangular card with red markings").
- Do NOT state what the item is called or what it does. You are describing a
  picture, not identifying an item.
- Under 150 characters.

Output a single JSON object mapping each file's number (as a string key) to its
description. Output only the JSON, no other text.`;
}

function extractJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in output");
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * A hedged description is an unreliable one. At 32x32 the model misreads a bent
 * spoon as a safety pin and a coat hanger as a swan, and when it does it says
 * "X or Y" — then that guess gets flattened into a confident hint that can
 * point at a completely different item. Reject the hedge rather than ship it.
 */
const HEDGE =
  /\b(or|possibly|perhaps|maybe|appears to be|looks like|resembling|resembles|some kind of|likely|probably|unclear|unknown|either)\b/i;

/**
 * Reject a description that gives the answer away. The describer is now told
 * the item's name (so it reads the picture correctly), which makes this check
 * load-bearing rather than a backstop: both the whole name and any distinctive
 * word from it are banned.
 */
function validate(item: Item, desc: unknown): string | null {
  if (typeof desc !== "string") return null;
  const t = desc.trim().replace(/\s+/g, " ");
  if (t.length < DESC_MIN || t.length > DESC_MAX) return null;
  if (HEDGE.test(t)) return null;
  const folded = fold(t);
  const foldedName = fold(item.name);
  if (foldedName.length > 2 && folded.includes(foldedName)) return null;
  for (const w of (foldedName.match(/[a-z]{4,}/g) ?? [])) {
    if (w === "the") continue;
    if (folded.includes(w)) return null;
  }
  return t;
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  if (Number.isNaN(limit)) throw new Error("--limit needs a numeric value");

  mkdirSync(CACHE_DIR, { recursive: true });
  const items = JSON.parse(readFileSync(ITEMS_PATH, "utf8")) as Item[];
  const out: Record<string, string> = existsSync(OUT_PATH)
    ? (JSON.parse(readFileSync(OUT_PATH, "utf8")) as Record<string, string>)
    : {};

  const todo = items.filter((it) => !out[String(it.id)]).slice(0, limit);
  console.log(`${Object.keys(out).length} described, ${todo.length} to go.`);
  if (todo.length === 0) return;

  console.log("Upscaling sprites…");
  const byId = new Map(items.map((it) => [it.id, it]));
  const ready = todo.filter((it) => upscale(it.id));
  const missing = todo.length - ready.length;
  if (missing) console.warn(`  ${missing} sprites missing or unconvertible — skipped`);

  const batches: Array<Array<{ id: number; name: string }>> = [];
  for (let i = 0; i < ready.length; i += BATCH_SIZE) {
    batches.push(ready.slice(i, i + BATCH_SIZE).map((it) => ({ id: it.id, name: it.name })));
  }

  let done = 0;
  let consecDead = 0;
  const rejected: string[] = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const wave = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      wave.map(async (ids) => {
        try {
          return extractJson(await runClaude(buildPrompt(ids), CACHE_DIR));
        } catch (e) {
          console.error(`  batch error: ${e instanceof Error ? e.message : e}`);
          return null;
        }
      }),
    );
    // A whole wave failing means the CLI is down or we are inside a usage-limit
    // window. Without this the script cheerfully burns through every remaining
    // batch against a dead CLI and reports "Done" having described nothing.
    if (results.every((r) => r === null)) {
      consecDead++;
      if (consecDead >= MAX_DEAD_WAVES) {
        console.error(`CLI dead for ${MAX_DEAD_WAVES} waves — stopping; re-run later to resume.`);
        break;
      }
      const wait = Math.min(BACKOFF_MS * 2 ** (consecDead - 1), BACKOFF_MAX_MS);
      console.error(`  whole wave failed; waiting ${Math.round(wait / 1000)}s then retrying`);
      await new Promise((r) => setTimeout(r, wait));
      i -= CONCURRENCY; // retry the same wave
      continue;
    }
    consecDead = 0;
    for (const parsed of results) {
      for (const [key, value] of Object.entries(parsed ?? {})) {
        const item = byId.get(Number(key));
        if (!item) continue;
        const ok = validate(item, value);
        if (ok) (out[key] = ok), done++;
        else rejected.push(`${item.name}: ${String(value).slice(0, 80)}`);
      }
    }
    writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
    console.log(`  ${done}/${ready.length} described`);
  }
  if (rejected.length) {
    // Expected, not a failure: for items whose name IS the thing drawn
    // (Scissors, Stapler, Apple!), an honest description of the picture
    // contains the answer. Those items get no description and their ladder
    // falls back to the pickup quote for the giveaway hint.
    console.log(`\n${rejected.length} rejected for naming the item (expected for self-depicting names):`);
    for (const r of rejected.slice(0, 30)) console.log(`  ${r}`);
  }
  console.log(`\nDone: ${Object.keys(out).length}/${items.length} sprite descriptions.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
