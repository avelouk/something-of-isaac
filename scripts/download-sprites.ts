/**
 * Optional: download all item sprites from isaacguru.com into data/sprites/
 * for self-hosting (so we don't depend on a third-party CDN).
 *
 * Run after build:items so data/items.json exists.
 * Skips already-downloaded files.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "public/data/sprites");

type Item = { id: number; img: string };

async function main() {
  mkdirSync(OUT, { recursive: true });
  const items: Item[] = JSON.parse(
    readFileSync(resolve(ROOT, "public/data/items.json"), "utf8"),
  );
  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const it of items) {
    const dest = resolve(OUT, `${it.id}.webp`);
    if (existsSync(dest)) {
      skipped++;
      continue;
    }
    if (!it.img) {
      failed++;
      continue;
    }
    try {
      const res = await fetch(it.img, {
        headers: { "User-Agent": "isaac-daily-guess sprite downloader (one-off)" },
      });
      if (!res.ok) {
        failed++;
        console.warn(`fail ${it.id} (${res.status}): ${it.img}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(dest, buf);
      done++;
      if (done % 50 === 0) console.log(`  ${done} downloaded`);
      // gentle throttle: 50ms between requests
      await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      failed++;
      console.warn(`error ${it.id}:`, e);
    }
  }
  console.log(`done. downloaded=${done} skipped=${skipped} failed=${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
