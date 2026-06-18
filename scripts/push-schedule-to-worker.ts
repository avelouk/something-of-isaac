/**
 * Upload public/data/schedule.json to the worker's SCHEDULE_KV (PUT /schedule).
 *
 *   npm run push:schedule
 *
 * Requires WORKER_URL and ADMIN_TOKEN in .env.local. Run `npm run build:schedule` first.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Schedule } from "../src/puzzle.ts";
import { migrateScheduleIfNeeded } from "../src/puzzle.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCHEDULE_PATH = resolve(ROOT, "public/data/schedule.json");

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

async function main() {
  loadDotenvLocal();
  const workerUrl = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
  const token = process.env.ADMIN_TOKEN ?? "";
  if (!workerUrl || !token) {
    console.error("Set WORKER_URL and ADMIN_TOKEN in .env.local");
    process.exit(1);
  }

  if (!existsSync(SCHEDULE_PATH)) {
    throw new Error("public/data/schedule.json not found — run `npm run build:schedule` first.");
  }
  const path = SCHEDULE_PATH;
  const schedule = migrateScheduleIfNeeded(JSON.parse(readFileSync(path, "utf8")) as Schedule);
  const withHints = schedule.entries.filter((e) => e.hints?.some((h) => h.trim())).length;

  console.log(`Uploading ${schedule.entries.length} days (${withHints} with hints) from ${path} …`);

  const r = await fetch(`${workerUrl}/schedule`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(schedule),
  });

  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`Upload failed (${r.status}):`, body);
    process.exit(1);
  }

  console.log("OK:", body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
