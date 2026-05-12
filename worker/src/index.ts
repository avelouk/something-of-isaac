/**
 * something-of-isaac worker: daily player counts + hand-authored hint overrides.
 *
 * Routes:
 *   POST /visit  — counts each UUID at most once per UTC day (Durable Object per day).
 *   GET  /hints  — returns { "YYYY-MM-DD": string[6] } overrides, edge-cached for 60s.
 *   POST /hints  — bearer-token gated; merges one date's hints into the KV blob.
 *
 * Why KV for hints? Whole overrides map is small (one JSON blob), read every page load.
 * Edge caching keeps origin reads near zero on the free plan; writes are rare (admin only).
 *
 * Why DO for visits? KV has no atomic increment and no cheap "count unique keys," so races
 * would skew the public counter. DO storage gives serialized handlers per day.
 */

/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DAILY_STATS: DurableObjectNamespace;
  HINTS_KV: KVNamespace;
  ADMIN_TOKEN: string;
}

const HINTS_KEY = "overrides";
const HINT_COUNT = 6;
const HINTS_CACHE_TTL_SECONDS = 60;
const HINT_MAX_LENGTH = 1024;

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
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN ?? "";
  if (!expected) return false;
  const header = request.headers.get("Authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return supplied.length > 0 && constantTimeEqual(expected, supplied);
}

function hintsCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(`${url.origin}${url.pathname}`, { method: "GET" });
}

async function readOverrides(env: Env): Promise<Record<string, string[]>> {
  const raw = await env.HINTS_KV.get(HINTS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

async function handleHints(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "GET") {
    const cache = caches.default;
    const cacheKey = hintsCacheKey(request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const overrides = await readOverrides(env);
    const res = json(overrides, 200, {
      "Cache-Control": `public, max-age=${HINTS_CACHE_TTL_SECONDS}`,
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  if (request.method === "POST") {
    if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

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
    const hints = (body as { hints?: unknown } | null)?.hints;

    if (!isValidIsoDate(date)) {
      return json({ error: "date must be YYYY-MM-DD" }, 400);
    }
    if (
      !Array.isArray(hints) ||
      hints.length !== HINT_COUNT ||
      !hints.every((h) => typeof h === "string")
    ) {
      return json({ error: `hints must be an array of ${HINT_COUNT} strings` }, 400);
    }
    if ((hints as string[]).some((h) => h.length > HINT_MAX_LENGTH)) {
      return json({ error: `each hint must be ≤${HINT_MAX_LENGTH} chars` }, 400);
    }

    const overrides = await readOverrides(env);
    overrides[date] = hints as string[];
    await env.HINTS_KV.put(HINTS_KEY, JSON.stringify(overrides));
    ctx.waitUntil(caches.default.delete(hintsCacheKey(request)));
    return json({ ok: true, date, count: Object.keys(overrides).length });
  }

  return new Response("Not found", { status: 404, headers: corsHeaders() });
}

/** Worker entry: CORS + route to /hints or to today's DO. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/hints") {
      return handleHints(request, env, ctx);
    }

    const day = utcDay();
    const id = env.DAILY_STATS.idFromName(day);
    const stub = env.DAILY_STATS.get(id);
    const res = await stub.fetch(request);
    return withCors(res);
  },
};

export class DailyRoom implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
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
