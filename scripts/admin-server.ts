/**
 * Local-only schedule editor. Bind 127.0.0.1 — never expose publicly.
 *
 *   npm run admin
 *
 * Past UTC dates (strictly before today) are read-only and rejected on save.
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Schedule } from "../src/puzzle.ts";
import { migrateScheduleIfNeeded, utcTodayDateString } from "../src/puzzle.ts";
import type { ItemRow } from "./schedule-patch.ts";
import { patchScheduleEntry, SchedulePatchError } from "./schedule-patch.ts";
import { HINT_COUNT } from "../src/hints.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ADMIN_DIR = resolve(ROOT, "admin");
const SCHEDULE_PATH = resolve(ROOT, "public/data/schedule.json");
const ITEMS_PATH = resolve(ROOT, "public/data/items.json");

const HOST = "127.0.0.1";
const PORT = 8765;

/**
 * Minimal .env.local reader: KEY=VALUE per line, supports surrounding quotes,
 * does not clobber pre-set env vars. Keeps the publish credentials out of git.
 */
function loadDotenvLocal(): void {
  const path = resolve(ROOT, ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key in process.env) continue;
    process.env[key] = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}
loadDotenvLocal();

const WORKER_URL = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const PUBLISH_ENABLED = Boolean(WORKER_URL && ADMIN_TOKEN);

type PublishResult = { status: "skipped" | "ok" | "failed"; error?: string };

async function publishHintsToWorker(date: string, hints: string[]): Promise<PublishResult> {
  if (!PUBLISH_ENABLED) return { status: "skipped" };
  try {
    const r = await fetch(`${WORKER_URL}/hints`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ date, hints }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { status: "failed", error: `${r.status} ${text}`.trim().slice(0, 200) };
    }
    return { status: "ok" };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

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
  res.writeHead(status, {
    "Content-Type": mime,
    "Content-Length": buf.length,
  });
  res.end(buf);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function loadSchedule(): Schedule {
  let schedule = JSON.parse(readFileSync(SCHEDULE_PATH, "utf8")) as Schedule;
  schedule = migrateScheduleIfNeeded(schedule);
  return schedule;
}

function loadItems(): ItemRow[] {
  return JSON.parse(readFileSync(ITEMS_PATH, "utf8"));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = readFileSync(resolve(ADMIN_DIR, "index.html"), "utf8");
      text(res, 200, "text/html; charset=utf-8", html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/client.js") {
      const js = readFileSync(resolve(ADMIN_DIR, "client.js"), "utf8");
      text(res, 200, "application/javascript; charset=utf-8", js);
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

    if (req.method === "GET" && url.pathname === "/api/schedule") {
      json(res, 200, loadSchedule());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/items") {
      const items = loadItems().map((it) => ({ id: it.id, name: it.name }));
      json(res, 200, items);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/save") {
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

      if (!Number.isFinite(body.itemId)) {
        json(res, 400, { ok: false, error: "missing or invalid itemId" });
        return;
      }

      if (!Array.isArray(body.hints) || body.hints.length !== HINT_COUNT) {
        json(res, 400, {
          ok: false,
          error: `hints must be an array of ${HINT_COUNT} strings`,
        });
        return;
      }

      try {
        let schedule = loadSchedule();
        const items = loadItems();

        patchScheduleEntry(
          schedule,
          items,
          {
            date,
            itemId: body.itemId,
            hints: body.hints,
          },
          "admin save",
        );

        writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule));
        const publish = await publishHintsToWorker(date, body.hints);
        json(res, 200, { ok: true, publish: publish.status, publishError: publish.error });
      } catch (e) {
        if (e instanceof SchedulePatchError) {
          json(res, e.statusCode, { ok: false, error: e.message });
          return;
        }
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        json(res, 500, { ok: false, error: msg });
      }
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    json(res, 500, { ok: false, error: msg });
  }
}).listen(PORT, HOST, () => {
  console.log(`Schedule admin (local only): http://${HOST}:${PORT}`);
  console.log("Past UTC dates cannot be edited from this UI.");
  if (PUBLISH_ENABLED) {
    console.log(`Publishing hints to ${WORKER_URL}/hints on save.`);
  } else {
    console.log("Publish disabled — set WORKER_URL and ADMIN_TOKEN in .env.local to push to the worker.");
  }
});
