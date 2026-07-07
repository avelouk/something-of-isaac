/**
 * Local-only schedule editor. Bind 127.0.0.1 — never expose publicly.
 *
 *   npm run admin
 *
 * The schedule lives in the worker's SCHEDULE_KV (single source of truth). This server is
 * a thin proxy that keeps the ADMIN_TOKEN server-side: it reads/writes the worker's
 * authenticated /schedule endpoints and validates item ids against the local items.json
 * (the worker has no item list). The worker enforces the past-date lock and recomputes the
 * anti-cheat hash.
 *
 * Requires WORKER_URL and ADMIN_TOKEN in .env.local.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { utcTodayDateString } from "../src/puzzle.ts";
import { HINT_COUNT, hintsForPuzzle, type Item } from "../src/hints.ts";
import { loadDotenvLocal } from "./env.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ADMIN_DIR = resolve(ROOT, "admin");
const ITEMS_PATH = resolve(ROOT, "public/data/items.json");
const LADDERS_PATH = resolve(ROOT, "public/data/ladders.json");
const QUOTES_PATH = resolve(ROOT, "public/data/quotes.json");

const HOST = "127.0.0.1";
const PORT = 8765;

type ItemRow = { id: number; name: string };

loadDotenvLocal(ROOT);

const WORKER_URL = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const PUBLISH_ENABLED = Boolean(WORKER_URL && ADMIN_TOKEN);

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

function text(res: import("node:http").ServerResponse, status: number, mime: string, body: string) {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, { "Content-Type": mime, "Content-Length": buf.length });
  res.end(buf);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function loadItems(): ItemRow[] {
  return JSON.parse(readFileSync(ITEMS_PATH, "utf8"));
}

/** Authenticated full-schedule read from the worker. */
async function fetchSchedule(): Promise<unknown> {
  const r = await fetch(`${WORKER_URL}/schedule`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`worker /schedule ${r.status}: ${detail.slice(0, 200)}`);
  }
  return r.json();
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}`);

    if (req.method === "GET" && url.pathname === "/") {
      text(res, 200, "text/html; charset=utf-8", readFileSync(resolve(ADMIN_DIR, "index.html"), "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/client.js") {
      text(res, 200, "application/javascript; charset=utf-8", readFileSync(resolve(ADMIN_DIR, "client.js"), "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/meta") {
      json(res, 200, {
        todayUtc: utcTodayDateString(),
        hintCount: HINT_COUNT,
        publishEnabled: PUBLISH_ENABLED,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/items") {
      json(res, 200, loadItems().map((it) => ({ id: it.id, name: it.name })));
      return;
    }

    // What the game shows when the schedule entry has no hand-authored hints:
    // item.customHints → generated ladder → auto metadata (same resolver the app uses).
    if (req.method === "GET" && url.pathname === "/api/fallback-hints") {
      const id = Number(url.searchParams.get("itemId"));
      const item = (JSON.parse(readFileSync(ITEMS_PATH, "utf8")) as Item[]).find(
        (it) => it.id === id,
      );
      if (!item) {
        json(res, 404, { error: `no item with id ${id}` });
        return;
      }
      const ladders = JSON.parse(readFileSync(LADDERS_PATH, "utf8")) as Record<string, string[]>;
      const quotes = JSON.parse(readFileSync(QUOTES_PATH, "utf8")) as Record<string, string>;
      const ladder = ladders[String(id)];
      const source =
        item.customHints?.length === HINT_COUNT
          ? "item custom hints"
          : ladder?.length === HINT_COUNT
            ? "generated ladder"
            : "auto metadata hints";
      const hints = hintsForPuzzle(undefined, item, quotes[String(id)] ?? "", ladder).map(
        (h) => h.text,
      );
      json(res, 200, { source, hints });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/schedule") {
      if (!PUBLISH_ENABLED) {
        json(res, 503, { error: "set WORKER_URL and ADMIN_TOKEN in .env.local" });
        return;
      }
      try {
        json(res, 200, await fetchSchedule());
      } catch (e) {
        json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/save") {
      if (!PUBLISH_ENABLED) {
        json(res, 503, { ok: false, error: "set WORKER_URL and ADMIN_TOKEN in .env.local" });
        return;
      }

      const raw = await readBody(req);
      let body: { date?: string; itemId?: number; hints?: string[] };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }

      const date = typeof body.date === "string" ? body.date.trim() : "";
      if (!date) {
        json(res, 400, { ok: false, error: "missing date" });
        return;
      }
      if (typeof body.itemId !== "number" || !Number.isFinite(body.itemId)) {
        json(res, 400, { ok: false, error: "missing or invalid itemId" });
        return;
      }
      // The worker can't check this — it has no item list.
      if (!loadItems().some((it) => it.id === body.itemId)) {
        json(res, 400, { ok: false, error: `no item with id ${body.itemId}` });
        return;
      }
      if (!Array.isArray(body.hints) || body.hints.length !== HINT_COUNT) {
        json(res, 400, { ok: false, error: `hints must be an array of ${HINT_COUNT} strings` });
        return;
      }

      try {
        const r = await fetch(`${WORKER_URL}/schedule/entry`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
          body: JSON.stringify({ date, itemId: body.itemId, hints: body.hints }),
        });
        const out = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!r.ok || !out.ok) {
          json(res, r.status === 200 ? 502 : r.status, {
            ok: false,
            error: out.error ?? `worker /schedule/entry ${r.status}`,
          });
          return;
        }
        json(res, 200, { ok: true, publish: "ok" });
      } catch (e) {
        json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, HOST, () => {
  console.log(`Schedule admin (local only): http://${HOST}:${PORT}`);
  console.log("Past UTC dates cannot be edited (the worker rejects them).");
  if (PUBLISH_ENABLED) {
    console.log(`Editing the schedule in ${WORKER_URL} (SCHEDULE_KV).`);
  } else {
    console.log("Set WORKER_URL and ADMIN_TOKEN in .env.local — the schedule lives in the worker now.");
  }
});
