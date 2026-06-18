/**
 * Schedule storage in KV — single source of truth for daily item + hints.
 *
 * Public reads return one day only (today or past) so future puzzles aren't scraped.
 * Admin reads/writes use bearer token.
 */

/// <reference types="@cloudflare/workers-types" />

// Reuse the canonical epoch + date math so the worker can never drift from the
// frontend's puzzle↔date mapping (a divergence would serve the wrong item silently).
import {
  puzzleNumberToUtcDateString,
  utcDateStringToPuzzleNumber,
  utcTodayDateString,
  type Schedule,
  type ScheduleEntry,
} from "../../src/puzzle.ts";

export interface ScheduleEnv {
  SCHEDULE_KV: KVNamespace;
}

export type { Schedule, ScheduleEntry };

const SCHEDULE_KEY = "schedule";
const HINT_COUNT = 6;
const HINT_MAX_LENGTH = 1024;
const MAX_ITEM_ID = 9999;
const MAX_SCHEDULE_ENTRIES = 20000; // ~54 years; guards against a runaway/abusive upload
const CACHE_TTL_SECONDS = 60;

type JsonFn = (data: unknown, status?: number, extra?: HeadersInit) => Response;

async function hashEntryAsync(itemId: number, salt: string, n: number): Promise<string> {
  const data = new TextEncoder().encode(`${itemId}:${salt}:${n}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  // Round-trip so impossible calendar dates (2026-02-30, 2026-13-45) are rejected;
  // Date.UTC silently normalizes overflow, so the regex alone is not enough.
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function compareIsoDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isValidHints(hints: unknown): hints is string[] {
  return (
    Array.isArray(hints) &&
    hints.length === HINT_COUNT &&
    hints.every((h) => typeof h === "string")
  );
}

function hintsHaveContent(hints: string[]): boolean {
  return hints.some((h) => h.trim().length > 0);
}

function publicEntry(entry: ScheduleEntry): Omit<ScheduleEntry, "hash"> {
  const { hash: _hash, ...rest } = entry;
  return rest;
}

async function readSchedule(env: ScheduleEnv): Promise<Schedule | null> {
  const raw = await env.SCHEDULE_KV.get(SCHEDULE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Schedule;
    if (!parsed?.entries?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeSchedule(env: ScheduleEnv, schedule: Schedule): Promise<void> {
  await env.SCHEDULE_KV.put(SCHEDULE_KEY, JSON.stringify(schedule));
}

function findEntry(schedule: Schedule, date: string): ScheduleEntry | undefined {
  return schedule.entries.find((e) => e.date === date);
}


async function bustScheduleCache(ctx: ExecutionContext, date?: string): Promise<void> {
  ctx.waitUntil(
    (async () => {
      const cache = (caches as unknown as { default: Cache }).default;
      await cache.delete(new Request("https://schedule-cache/today"));
      // The frontend reads today via /schedule/day?puzzle=N, which caches under the
      // day key — bust it too or an edit to today stays hidden until the TTL lapses.
      if (date) await cache.delete(new Request(`https://schedule-cache/day?${date}`));
    })(),
  );
}

function resolvePublicDay(url: URL): { date: string } | { error: string; status: number } {
  const today = utcTodayDateString();
  const dateParam = (url.searchParams.get("date") ?? "").trim();
  const puzzleParam = url.searchParams.get("puzzle");

  let date: string;
  if (dateParam) {
    if (!isValidIsoDate(dateParam)) return { error: "date must be YYYY-MM-DD", status: 400 };
    date = dateParam;
  } else if (puzzleParam !== null && puzzleParam !== "") {
    const n = Number(puzzleParam);
    if (!Number.isFinite(n) || n < 1) return { error: "puzzle must be a positive number", status: 400 };
    date = puzzleNumberToUtcDateString(Math.trunc(n));
  } else {
    return { error: "pass date= or puzzle=", status: 400 };
  }

  if (compareIsoDate(date, today) > 0) {
    return { error: "future schedule entries are not public", status: 403 };
  }

  return { date };
}

export async function handleSchedule(
  request: Request,
  env: ScheduleEnv,
  ctx: ExecutionContext,
  json: JsonFn,
  isAuthorized: (req: Request) => boolean,
  path: string,
): Promise<Response> {
  const url = new URL(request.url);

  // Full schedule dump — authed only (the local admin UI browses every row by date).
  if (request.method === "GET" && path === "/schedule") {
    if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);
    const schedule = await readSchedule(env);
    if (!schedule) return json({ error: "schedule not loaded" }, 503);
    return json(schedule);
  }

  if (request.method === "GET" && path === "/schedule/today") {
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request("https://schedule-cache/today");
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const schedule = await readSchedule(env);
    if (!schedule) return json({ error: "schedule not loaded" }, 503);

    const today = utcTodayDateString();
    const entry = findEntry(schedule, today);
    if (!entry) return json({ error: "no puzzle for today" }, 404);

    const res = json(publicEntry(entry), 200, {
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  if (request.method === "GET" && path === "/schedule/day") {
    const resolved = resolvePublicDay(url);
    if ("error" in resolved) return json({ error: resolved.error }, resolved.status);

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(`https://schedule-cache/day?${resolved.date}`);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const schedule = await readSchedule(env);
    if (!schedule) return json({ error: "schedule not loaded" }, 503);

    const entry = findEntry(schedule, resolved.date);
    if (!entry) return json({ error: "no puzzle for this day" }, 404);

    const res = json(publicEntry(entry), 200, {
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  if (request.method === "GET" && path.startsWith("/schedule/entry/")) {
    if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);

    const date = path.slice("/schedule/entry/".length);
    if (!isValidIsoDate(date)) return json({ error: "invalid date" }, 400);

    const schedule = await readSchedule(env);
    if (!schedule) return json({ error: "schedule not loaded" }, 503);

    const entry = findEntry(schedule, date);
    if (!entry) return json({ error: "no row for this date" }, 404);
    return json(entry);
  }

  if (request.method === "POST" && path === "/schedule/entry") {
    if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    const date =
      typeof body === "object" && body !== null && typeof (body as { date?: unknown }).date === "string"
        ? (body as { date: string }).date.trim()
        : "";
    const itemIdRaw = (body as { itemId?: unknown }).itemId;
    const hintsRaw = (body as { hints?: unknown }).hints;

    if (!isValidIsoDate(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);

    const today = utcTodayDateString();
    if (compareIsoDate(date, today) < 0) {
      return json({ error: "cannot edit past UTC dates" }, 403);
    }

    if (typeof itemIdRaw !== "number" || !Number.isFinite(itemIdRaw) || itemIdRaw < 1 || itemIdRaw > MAX_ITEM_ID) {
      return json({ error: `itemId must be an integer from 1 to ${MAX_ITEM_ID}` }, 400);
    }
    const itemId = Math.trunc(itemIdRaw);

    // Three cases for hints: omitted → keep whatever's stored; provided-with-content → set;
    // provided-but-all-blank → explicit clear (fall back to auto hints).
    const hintsProvided = hintsRaw !== undefined && hintsRaw !== null;
    let parsedHints: string[] | undefined;
    if (hintsProvided) {
      if (!isValidHints(hintsRaw)) {
        return json({ error: `hints must be an array of ${HINT_COUNT} strings` }, 400);
      }
      if (hintsRaw.some((h) => h.length > HINT_MAX_LENGTH)) {
        return json({ error: `each hint must be ≤${HINT_MAX_LENGTH} chars` }, 400);
      }
      if (hintsHaveContent(hintsRaw)) parsedHints = hintsRaw;
    }

    const schedule = await readSchedule(env);
    if (!schedule) return json({ error: "schedule not loaded" }, 503);

    const idx = schedule.entries.findIndex((e) => e.date === date);
    if (idx < 0) return json({ error: "no row for this date" }, 404);

    const hints = hintsProvided ? parsedHints : schedule.entries[idx].hints;
    const n = utcDateStringToPuzzleNumber(date);
    const hash = await hashEntryAsync(itemId, schedule.salt, n);
    const next: ScheduleEntry = { date, n, itemId, hash, ...(hints ? { hints } : {}) };
    schedule.entries[idx] = next;

    await writeSchedule(env, schedule);
    await bustScheduleCache(ctx, date);
    return json({ ok: true, entry: next });
  }

  if (request.method === "PUT" && path === "/schedule") {
    if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    const schedule = body as Schedule;
    if (
      !schedule ||
      typeof schedule !== "object" ||
      !Array.isArray(schedule.entries) ||
      schedule.entries.length === 0 ||
      typeof schedule.salt !== "string"
    ) {
      return json({ error: "body must be a schedule { version, salt, entries[] }" }, 400);
    }
    if (schedule.entries.length > MAX_SCHEDULE_ENTRIES) {
      return json({ error: `too many entries (max ${MAX_SCHEDULE_ENTRIES})` }, 400);
    }

    // This blob becomes the single source of truth for every player, so reject a
    // malformed upload rather than bricking the daily puzzle. (hash is cheap anti-cheat
    // only and not re-verified here.)
    const seen = new Set<string>();
    for (let i = 0; i < schedule.entries.length; i++) {
      const e = schedule.entries[i];
      let err: string | null = null;
      if (!e || typeof e !== "object") err = "not an object";
      else if (typeof e.date !== "string" || !isValidIsoDate(e.date)) err = `bad date ${e.date}`;
      else if (seen.has(e.date)) err = `duplicate date ${e.date}`;
      else if (e.n !== utcDateStringToPuzzleNumber(e.date)) err = `n ${e.n} ≠ ${utcDateStringToPuzzleNumber(e.date)}`;
      else if (!Number.isInteger(e.itemId) || e.itemId < 1 || e.itemId > MAX_ITEM_ID) err = `bad itemId ${e.itemId}`;
      else if (typeof e.hash !== "string" || e.hash.length === 0) err = "missing hash";
      else if (e.hints !== undefined && !isValidHints(e.hints)) err = "bad hints";
      if (err) return json({ error: `invalid entry ${i}${e?.date ? ` (${e.date})` : ""}: ${err}` }, 400);
      seen.add(e.date);
    }

    await writeSchedule(env, schedule);
    await bustScheduleCache(ctx);
    return json({ ok: true, count: schedule.entries.length });
  }

  return new Response("Not found", { status: 404 });
}
