/**
 * Build data/items.json from Platinum God's Repentance cheat sheet.
 *
 * Platinum God (https://platinumgod.co.uk/repentance) renders every
 * collectible as a single <li class="textbox" data-cid="N"> with all
 * the metadata we need: name, quality, type, pools, pickup quote,
 * description. The page is ~850 KB; we fetch once and parse with cheerio.
 *
 * Cross-references with Isaaconnect's items.json to align IDs and reuse
 * its sprite URLs. Only includes items present in Isaaconnect (so the
 * sprite atlas stays in sync).
 */

import { load } from "cheerio";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PLATINUM_GOD_URL = "https://platinumgod.co.uk/repentance";
const ISAACONNECT_ITEMS = "/Users/belzebub/code/Isaaconnect/json/items.json";
const HTML_CACHE = "/tmp/pg_rep.html";

type IsaaconnectItem = { alias: string; id: number; img: string };

type DLC = "rebirth" | "afterbirth" | "afterbirth+" | "repentance" | "repentance+";
type ItemType = "passive" | "active" | "familiar";

export type Item = {
  id: number;
  name: string;
  quality: number; // 0-4
  type: ItemType;
  dlc: DLC;
  pools: string[];
  primaryTag: string; // derived from description keywords
  pickupQuote: string;
  description: string;
  img: string;
};

async function fetchHtml(): Promise<string> {
  if (existsSync(HTML_CACHE)) {
    return readFileSync(HTML_CACHE, "utf8");
  }
  const res = await fetch(PLATINUM_GOD_URL, {
    headers: { "User-Agent": "isaac-daily-guess data builder (one-off, https://github.com/)" },
  });
  if (!res.ok) throw new Error(`PG fetch failed: ${res.status}`);
  const html = await res.text();
  writeFileSync(HTML_CACHE, html);
  return html;
}

function parseDLC(classAttr: string): DLC {
  // PG class hints: re-itm-new (Rebirth IDs 1-260ish), rep-item (Repentance), rep-item-plus / rep+
  if (/rep-item-plus|repplus|rep\+/.test(classAttr)) return "repentance+";
  if (/rep-item/.test(classAttr)) return "repentance";
  if (/ab-itm|afterbirth-plus/.test(classAttr)) return "afterbirth+";
  if (/afterbirth/.test(classAttr)) return "afterbirth";
  return "rebirth";
}

function parseType(typeStr: string): ItemType {
  const s = typeStr.toLowerCase();
  if (s.includes("active")) return "active";
  if (s.includes("familiar")) return "familiar";
  return "passive";
}

// Order matters: most specific / iconic patterns first.
const TAG_KEYWORDS: Array<[RegExp, string]> = [
  [/\btears? up\b/i, "tears up"],
  [/\bdamage up\b/i, "damage up"],
  [/\brange up\b/i, "range up"],
  [/\bspeed up\b/i, "speed up"],
  [/\bshot ?speed up\b/i, "shot speed up"],
  [/\bluck up\b/i, "luck up"],
  [/\bspectral\b/i, "spectral tears"],
  [/\bpiercing\b/i, "piercing tears"],
  [/\bhoming\b/i, "homing tears"],
  [/\bflight\b/i, "flight"],
  [/\bfamiliar\b/i, "familiar"],
  [/\borbital\b/i, "orbital"],
  [/\bpoison\b/i, "poison tears"],
  [/\bburn|fire tears\b/i, "burn"],
  [/\bfreeze\b/i, "freeze"],
  [/\bchargeable\b/i, "chargeable"],
  [/blood\s*beam|brimstone(\s+laser)?/i, "blood beam"],
  [/\bsoul heart\b/i, "soul hearts"],
  [/\bblack heart\b/i, "black hearts"],
  [/\bred heart\b|\+\d+ health/i, "health up"],
  [/\bcoin\b/i, "coins"],
  [/\bkey\b/i, "keys"],
  [/\bbomb\b|explosion/i, "explosive"],
  [/devil deal|angel room/i, "devil/angel synergy"],
  // Fallback bucket from softer matches
  [/damage|damage multiplier/i, "damage up"],
  [/fire rate|tears? multiplier/i, "tears up"],
];

function derivePrimaryTag(haystack: string): string {
  for (const [re, tag] of TAG_KEYWORDS) {
    if (re.test(haystack)) return tag;
  }
  return "miscellaneous";
}

function extractPools(metaParas: string[]): string[] {
  for (const p of metaParas) {
    const m = p.match(/Item Pool:\s*(.+)/i);
    if (m) {
      return m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function extractType(metaParas: string[]): ItemType | null {
  for (const p of metaParas) {
    const m = p.match(/Type:\s*(\w+)/i);
    if (m) return parseType(m[1]);
  }
  return null;
}

async function main() {
  console.log("Loading Isaaconnect items...");
  const isaaconnect: IsaaconnectItem[] = JSON.parse(
    readFileSync(ISAACONNECT_ITEMS, "utf8"),
  );
  const validIds = new Set(isaaconnect.filter((x) => x.id > 0).map((x) => x.id));
  const imgById = new Map(isaaconnect.map((x) => [x.id, x.img]));
  const nameById = new Map(isaaconnect.map((x) => [x.id, x.alias]));

  console.log("Fetching Platinum God HTML...");
  const html = await fetchHtml();

  console.log("Parsing...");
  const $ = load(html);
  const items: Item[] = [];
  const skipped: { id: number; reason: string }[] = [];
  const seenIds = new Set<number>();

  $("li.textbox").each((_, el) => {
    const li = $(el);
    const innerDiv = li.find("div.item").first();
    const classAttr = innerDiv.attr("class") || "";
    if (/rep-trink|trinket|^item$/.test(classAttr) === false && !classAttr.includes("item")) {
      return;
    }
    if (/rep-trink|trinket/.test(classAttr)) {
      return; // skip trinkets
    }
    // Authoritative ID is in <p class="r-itemid">ItemID: N</p>
    const idText = li.find(".r-itemid").first().text();
    const idMatch = idText.match(/ItemID:\s*(\d+)/i);
    if (!idMatch) return;
    const id = parseInt(idMatch[1], 10);
    if (!validIds.has(id)) {
      skipped.push({ id, reason: "not in Isaaconnect" });
      return;
    }
    // PG repeats some items on its tainted-characters pages under the same
    // ItemID (e.g. 619 "Birthright (Tainted)") — keep the first occurrence.
    if (seenIds.has(id)) {
      skipped.push({ id, reason: "duplicate id" });
      return;
    }
    seenIds.add(id);

    const name = li.find(".item-title").first().text().trim() || nameById.get(id) || `Item ${id}`;
    const pickupQuote = li
      .find(".pickup")
      .first()
      .text()
      .trim()
      .replace(/^["“]/, "")
      .replace(/["”]$/, "");
    const qualityText = li.find(".quality").first().text();
    const qualityMatch = qualityText.match(/Quality:\s*(\d+)/i);
    const quality = qualityMatch ? parseInt(qualityMatch[1], 10) : -1;

    // Description = top-level <p> children of <span> excluding marked classes
    const span = li.find("a > span").first();
    const descParas: string[] = [];
    span.children("p").each((_, p) => {
      const $p = $(p);
      const cls = $p.attr("class") || "";
      if (/item-title|r-itemid|pickup|quality|tags/.test(cls)) return;
      const t = $p.text().trim();
      if (t) descParas.push(t);
    });

    // Metadata <ul><p> entries
    const metaParas: string[] = [];
    span.find("ul p").each((_, p) => {
      metaParas.push($(p).text().trim());
    });

    const type = extractType(metaParas) ?? "passive";
    const pools = extractPools(metaParas);
    const description = descParas.join("\n");
    // Prioritize pickup quote (most iconic 1-2 word descriptor), then description.
    const primaryTag = derivePrimaryTag(
      `${pickupQuote} ${description} ${metaParas.join(" ")}`,
    );
    const dlc = parseDLC(classAttr);
    const img = imgById.get(id) ?? "";

    items.push({
      id,
      name,
      quality,
      type,
      dlc,
      pools,
      primaryTag,
      pickupQuote,
      description,
      img,
    });
  });

  // Sort by id for deterministic output.
  items.sort((a, b) => a.id - b.id);

  // Sanity report.
  const missing = [...validIds].filter((id) => !items.some((it) => it.id === id));
  const noQuality = items.filter((it) => it.quality < 0).length;
  const noPool = items.filter((it) => it.pools.length === 0).length;
  console.log(`Parsed ${items.length} items.`);
  console.log(`  missing from PG (in Isaaconnect but not parsed): ${missing.length}`);
  console.log(`  no quality: ${noQuality}`);
  console.log(`  no pool: ${noPool}`);
  console.log(`  skipped: ${skipped.length}`);

  // Split off pickup quotes into quotes.json (lazy-loaded for hint 7).
  const itemsLight = items.map((it) => {
    const { pickupQuote, ...rest } = it;
    void pickupQuote;
    return rest;
  });
  const quotes: Record<number, string> = {};
  for (const it of items) quotes[it.id] = it.pickupQuote;

  writeFileSync(resolve(ROOT, "public/data/items.json"), JSON.stringify(itemsLight, null, 2));
  writeFileSync(resolve(ROOT, "public/data/quotes.json"), JSON.stringify(quotes, null, 2));
  console.log("Wrote public/data/items.json and public/data/quotes.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
