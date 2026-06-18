/**
 * something-of-isaac worker: daily player counts + the daily schedule (items + hints).
 *
 * Routes:
 *   POST /visit  — counts each UUID at most once per UTC day (Durable Object per day).
 *   GET  /stats/history?from=YYYY-MM-DD&to=YYYY-MM-DD — bearer ADMIN_TOKEN; daily unique counts.
 *   /schedule*   — the daily schedule (see schedule.ts). SCHEDULE_KV is the single source of
 *                  truth for each day's itemId + hints; public reads return one past/today row,
 *                  authed reads/writes (bearer ADMIN_TOKEN) edit the store.
 *
 * Why KV for the schedule? The whole map is small (one JSON blob), read every page load.
 * Edge caching keeps origin reads near zero on the free plan; writes are rare (admin only).
 *
 * Why DO for visits? KV has no atomic increment and no cheap "count unique keys," so races
 * would skew the public counter. DO storage gives serialized handlers per day.
 */

/// <reference types="@cloudflare/workers-types" />

import { handleSchedule } from "./schedule.ts";

export interface Env {
  DAILY_STATS: DurableObjectNamespace;
  /** Single source of truth for the daily schedule (items + hints). */
  SCHEDULE_KV: KVNamespace;
  ADMIN_TOKEN: string;
}

/** Max UTC days per /stats/history request (avoid long CPU loops on free tier). */
const STATS_HISTORY_MAX_DAYS = 400;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders())) {
    out.headers.set(k, String(v));
  }
  return out;
}

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...extra,
    },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function compareIsoDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addUtcDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function utcDaysInclusive(from: string, to: string): number {
  let n = 0;
  for (let d = from; compareIsoDate(d, to) <= 0; d = addUtcDay(d)) n++;
  return n;
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN ?? "";
  if (!expected) return false;
  const header = request.headers.get("Authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return supplied.length > 0 && constantTimeEqual(expected, supplied);
}

/** Parallel DO snapshot fetches per wave (sequential days × cold DOs is too slow). */
const STATS_HISTORY_CONCURRENCY = 32;

async function handleStatsHistory(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
  }
  if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return json({ error: "from and to must be valid UTC calendar dates (YYYY-MM-DD)" }, 400);
  }
  if (compareIsoDate(from, to) > 0) {
    return json({ error: "from must be ≤ to" }, 400);
  }
  const span = utcDaysInclusive(from, to);
  if (span > STATS_HISTORY_MAX_DAYS) {
    return json({ error: `range too large (max ${STATS_HISTORY_MAX_DAYS} days)` }, 400);
  }

  const dateList: string[] = [];
  for (let d = from; compareIsoDate(d, to) <= 0; d = addUtcDay(d)) dateList.push(d);

  const authHeader = request.headers.get("Authorization") ?? "";
  const days: Array<{ date: string; unique: number; countries: Record<string, number> }> = [];

  try {
    for (let i = 0; i < dateList.length; i += STATS_HISTORY_CONCURRENCY) {
      const chunk = dateList.slice(i, i + STATS_HISTORY_CONCURRENCY);
      const wave = await Promise.all(
        chunk.map(async (d) => {
          const id = env.DAILY_STATS.idFromName(d);
          const stub = env.DAILY_STATS.get(id);
          const sub = new Request("https://internal/__stats_snapshot", {
            method: "GET",
            headers: { Authorization: authHeader },
          });
          const res = await stub.fetch(sub);
          if (!res.ok) {
            throw new Error(`snapshot failed for ${d}: ${res.status}`);
          }
          const row = (await res.json()) as { unique?: unknown; countries?: unknown };
          const unique =
            typeof row.unique === "number" && Number.isFinite(row.unique) ? row.unique : 0;
          const countries =
            row.countries && typeof row.countries === "object" && !Array.isArray(row.countries)
              ? (row.countries as Record<string, number>)
              : {};
          return { date: d, unique, countries };
        }),
      );
      days.push(...wave);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 502);
  }

  return json({ from, to, days });
}

/** Worker entry: CORS + route to /schedule, /stats, or today's visit DO. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (
      path === "/schedule" ||
      path === "/schedule/today" ||
      path === "/schedule/day" ||
      path.startsWith("/schedule/entry")
    ) {
      const res = await handleSchedule(request, env, ctx, json, (req) => isAuthorized(req, env), path);
      return withCors(res);
    }

    if (path === "/stats/history") {
      const res = await handleStatsHistory(request, env);
      return withCors(res);
    }

    const day = utcDay();
    const id = env.DAILY_STATS.idFromName(day);
    const stub = env.DAILY_STATS.get(id);
    const res = await stub.fetch(request);
    return withCors(res);
  },
};

export class DailyRoom implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === "GET" && path.endsWith("/__stats_snapshot")) {
      if (!isAuthorized(request, this.env)) return json({ error: "unauthorized" }, 401);
      const unique = (await this.ctx.storage.get<number>("unique")) ?? 0;
      const countries =
        (await this.ctx.storage.get<Record<string, number>>("countries")) ?? {};
      return json({ unique, countries });
    }

    if (request.method === "POST" && path.endsWith("/visit")) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const visitorId =
        typeof body === "object" &&
        body !== null &&
        "visitorId" in body &&
        typeof (body as { visitorId: unknown }).visitorId === "string"
          ? (body as { visitorId: string }).visitorId.trim().slice(0, 64)
          : "";

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitorId)) {
        return json({ error: "visitorId must be a UUID" }, 400);
      }

      const seenKey = `seen:${visitorId}`;
      const already = await this.ctx.storage.get(seenKey);
      const cf = request.cf as IncomingRequestCfProperties | undefined;
      const country = (cf?.country ?? request.headers.get("CF-IPCountry") ?? "").trim();

      if (!already) {
        await this.ctx.storage.put(seenKey, "1");
        const unique = ((await this.ctx.storage.get<number>("unique")) ?? 0) + 1;
        await this.ctx.storage.put("unique", unique);

        if (country && country !== "XX" && country !== "T1") {
          const countries =
            (await this.ctx.storage.get<Record<string, number>>("countries")) ?? {};
          countries[country] = (countries[country] ?? 0) + 1;
          await this.ctx.storage.put("countries", countries);
        }
      }

      const unique = (await this.ctx.storage.get<number>("unique")) ?? 0;
      return json({ unique, newVisitor: !already });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  }
}
