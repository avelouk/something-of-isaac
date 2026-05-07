/**
 * Daily stats: one Durable Object per UTC calendar day (via idFromName).
 * - POST /visit { visitorId } — counts each UUID at most once per day; returns current unique total.
 *   Country (CF geo) is recorded on first visit only for optional future use — not returned over HTTP.
 *
 * Why not KV? KV has no atomic increment and no cheap “count unique keys,” so races and
 * duplicates would skew the public counter. DO storage gives serialized handlers per day.
 */

/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DAILY_STATS: DurableObjectNamespace;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

/** Worker entry: CORS + route to today’s DO by UTC date string. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
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
