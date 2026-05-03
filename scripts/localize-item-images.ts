/**
 * Point items.json `img` at self-hosted sprites under data/sprites/{id}.webp
 * when that file exists (after npm run download:sprites).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ITEMS = resolve(ROOT, "public/data/items.json");
const SPRITES = resolve(ROOT, "public/data/sprites");

type Item = { id: number; img: string };

function main() {
  const items: Item[] = JSON.parse(readFileSync(ITEMS, "utf8"));
  let n = 0;
  for (const it of items) {
    const file = resolve(SPRITES, `${it.id}.webp`);
    if (!existsSync(file)) continue;
    const next = `data/sprites/${it.id}.webp`;
    if (it.img !== next) {
      it.img = next;
      n++;
    }
  }
  writeFileSync(ITEMS, JSON.stringify(items, null, 2) + "\n");
  console.log(`localize-item-images: updated ${n} entries → data/sprites/{id}.webp`);
}

main();
