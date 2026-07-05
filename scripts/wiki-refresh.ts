/**
 * Refresh the volatile item fields from the Binding of Isaac wiki (wiki.gg),
 * which is actively maintained — Platinum God data drifts out of date.
 *
 *   npm run refresh:wiki
 *
 * Patches public/data/items.json and public/data/quotes.json in place:
 *   - quality, description, dlc ← wiki infobox (source of truth)
 *   - active-item recharge appended to the description (feeds hint generation)
 *   - pickup quote ← wiki infobox `quote`
 * Structure fields (id, name, type, pools, img) are untouched — they come from
 * the build:items pipeline and the Isaaconnect id/sprite alignment.
 *
 * Also writes scripts/wiki-extra.json (per item id: unlock method resolved via
 * the wiki's Cargo `achievement` table, plus Trivia bullets) — generation
 * input for build:ladders, never shipped to the client.
 *
 * Items are joined by in-game id (the wiki infobox `id` param), so wiki page
 * titles never need to match our item names. Run after build:items.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Item } from "../src/hints.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ITEMS_PATH = resolve(ROOT, "public/data/items.json");
const QUOTES_PATH = resolve(ROOT, "public/data/quotes.json");
const EXTRA_PATH = resolve(ROOT, "scripts/wiki-extra.json");

const API = "https://bindingofisaacrebirth.wiki.gg/api.php";
const INFOBOX_TEMPLATES = [
  "Template:Infobox_passive_collectible",
  "Template:Infobox_activated_collectible",
];
const TITLES_PER_REQUEST = 50;

const DLC_MAP: Record<string, Item["dlc"]> = {
  a: "afterbirth",
  "a+": "afterbirth+",
  r: "repentance",
  "r+": "repentance+",
};

type WikiItem = {
  quality?: number;
  quote?: string;
  description?: string;
  dlc?: Item["dlc"];
  recharge?: string;
  /** Achievement name from `unlocked by` — resolved to requirements via Cargo. */
  unlockedBy?: string;
  trivia?: string[];
};

async function api(params: Record<string, string>): Promise<any> {
  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  const r = await fetch(url, { headers: { "User-Agent": "something-of-isaac data refresh" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function listInfoboxPages(): Promise<string[]> {
  const titles = new Set<string>();
  for (const template of INFOBOX_TEMPLATES) {
    let cont: string | undefined;
    do {
      const d = await api({
        action: "query",
        list: "embeddedin",
        eititle: template,
        eilimit: "500",
        einamespace: "0",
        ...(cont ? { eicontinue: cont } : {}),
      });
      for (const p of d.query.embeddedin) titles.add(p.title);
      cont = d.continue?.eicontinue;
    } while (cont);
  }
  return [...titles];
}

/** {{x|…|Name}} → "Name" when the last positional param looks like a name. */
function crossRefName(template: string): string {
  const body = template.slice(2, -2);
  const positional = body.split("|").slice(1).filter((p) => !p.includes("="));
  const last = positional[positional.length - 1]?.trim() ?? "";
  return last.length > 1 ? last : "";
}

/** Strip wikitext markup down to plain sentences. */
function stripWikitext(s: string): string {
  return s
    .replace(/\{\{!\}\}/g, "|") // escaped-pipe magic word
    .replace(/\[\[File:.*?\]\]/gs, "") // icon/image links — the text label follows separately
    .replace(/\{\{dlcalt\|([^{}]*)\}\}/gi, (_, body: string) => {
      // {{dlcalt|6|r=4}} = "6, but 4 since Repentance" — the game runs the
      // latest DLC, so the last dlc-specific value wins.
      const parts = body.split("|");
      const withEq = parts.filter((p) => p.includes("="));
      const pick = withEq.length
        ? withEq[withEq.length - 1].split("=").slice(1).join("=")
        : parts[parts.length - 1];
      return pick.trim();
    })
    .replace(/\{\{dlc\|[^}]*\}\}/gi, "") // dlc availability markers
    // Cross-ref templates ({{e|Poop}}, {{b|Mom's Heart}}, {{r|Blue Womb}}…):
    // keep the last positional param when it looks like a name. Two passes
    // for one level of nesting.
    .replace(/\{\{[^{}]*\}\}/g, crossRefName)
    .replace(/\{\{[^{}]*\}\}/g, crossRefName)
    .replace(/\{\{[^}]*\}\}/g, "") // anything left over
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1") // [[page|label]] → label
    .replace(/\[\[([^\]]*)\]\]/g, "$1") // [[page]] → page
    .replace(/'{2,}/g, "") // bold/italic quotes
    .replace(/<[^>]+>/g, "") // html tags
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1") // tidy gaps left by dropped templates
    .replace(/,\s*,/g, ",")
    .trim();
}

/**
 * Split the infobox body into `key = value` params on top-level pipes only —
 * pipes inside nested templates ({{e|Poop}}) or links ([[a|b]]) don't count.
 */
function parseInfoboxParams(box: string): Record<string, string> {
  // Strip the outer `{{` and `}}` so only param pipes remain at depth 0.
  const inner = box.replace(/^\{\{/, "").replace(/\}\}$/, "");
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const two = inner.slice(i, i + 2);
    if (two === "{{" || two === "[[") {
      depth++;
      current += two;
      i++;
    } else if (two === "}}" || two === "]]") {
      depth--;
      current += two;
      i++;
    } else if (inner[i] === "|" && depth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += inner[i];
    }
  }
  segments.push(current);

  const params: Record<string, string> = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    const value = seg.slice(eq + 1).trim();
    if (key) params[key] = value;
  }
  return params;
}

function parsePage(content: string): { id: number; item: WikiItem } | null {
  const boxStart = content.search(/\{\{infobox (passive|activated) collectible/i);
  if (boxStart < 0) return null;
  // The infobox ends at the matching `}}` — params never nest deeper than one
  // template level, so scan with a depth counter.
  let depth = 0;
  let end = boxStart;
  for (let i = boxStart; i < content.length - 1; i++) {
    if (content[i] === "{" && content[i + 1] === "{") depth++, i++;
    else if (content[i] === "}" && content[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const box = content.slice(boxStart, end);
  const params = parseInfoboxParams(box);

  const id = Number(params["id"]);
  if (!Number.isInteger(id) || id < 1) return null;

  const qualityRaw = Number(params["quality"]);
  const dlcRaw = (params["dlc"] ?? "").toLowerCase();

  return {
    id,
    item: {
      quality: Number.isInteger(qualityRaw) && qualityRaw >= 0 ? qualityRaw : undefined,
      quote: params["quote"] ? stripWikitext(params["quote"]) : undefined,
      description: params["description"] ? stripWikitext(params["description"]) : undefined,
      dlc: DLC_MAP[dlcRaw],
      recharge: params["recharge"] ? stripWikitext(params["recharge"]) : undefined,
      unlockedBy: params["unlocked by"] ? stripWikitext(params["unlocked by"]) : undefined,
      trivia: parseTrivia(content),
    },
  };
}

/** Bullets from the page's == Trivia == section, stripped to plain text. */
function parseTrivia(content: string): string[] | undefined {
  const m = content.match(/==\s*Trivia\s*==\n([\s\S]*?)(?=\n==|$)/);
  if (!m) return undefined;
  const bullets = m[1]
    .split("\n")
    .filter((l) => l.startsWith("*") && !l.startsWith("**"))
    .map((l) => stripWikitext(l.replace(/^\*+\s*/, "")))
    .filter((l) => l.length >= 20)
    .slice(0, 5);
  return bullets.length ? bullets : undefined;
}

/** Cargo `achievement` table: achievement name → unlock requirements text. */
async function fetchAchievementRequirements(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += 500) {
    const d = await api({
      action: "cargoquery",
      tables: "achievement",
      fields: "name,requirements",
      limit: "500",
      offset: String(offset),
    });
    const rows: Array<{ title: { name?: string; requirements?: string } }> = d.cargoquery ?? [];
    for (const r of rows) {
      if (r.title.name && r.title.requirements) {
        // "6 / 9 / 10 / 12" sequences are per-DLC variants; the last one is
        // the current game's value.
        const clean = stripWikitext(r.title.requirements).replace(/(?:\d+\s*\/\s*)+(\d+)/g, "$1");
        out.set(r.title.name, clean);
      }
    }
    if (rows.length < 500) break;
  }
  return out;
}

async function fetchWikiItems(titles: string[]): Promise<Map<number, WikiItem>> {
  const out = new Map<number, WikiItem>();
  for (let i = 0; i < titles.length; i += TITLES_PER_REQUEST) {
    const chunk = titles.slice(i, i + TITLES_PER_REQUEST);
    const d = await api({
      action: "query",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: chunk.join("|"),
    });
    for (const p of d.query.pages) {
      const content = p.revisions?.[0]?.slots?.main?.content;
      if (!content) continue;
      const parsed = parsePage(content);
      if (parsed) out.set(parsed.id, parsed.item);
    }
    console.log(`  fetched ${Math.min(i + TITLES_PER_REQUEST, titles.length)}/${titles.length} pages`);
  }
  return out;
}

async function main() {
  console.log("Listing collectible pages…");
  const titles = await listInfoboxPages();
  console.log(`${titles.length} pages. Fetching…`);
  const wiki = await fetchWikiItems(titles);
  console.log(`Parsed ${wiki.size} wiki items with valid ids.`);
  const requirements = await fetchAchievementRequirements();
  console.log(`Cargo: ${requirements.size} achievement requirements.`);

  const items = JSON.parse(readFileSync(ITEMS_PATH, "utf8")) as Item[];
  const quotes = JSON.parse(readFileSync(QUOTES_PATH, "utf8")) as Record<string, string>;

  let quality = 0, desc = 0, dlc = 0, quote = 0, missing = 0;
  for (const it of items) {
    const w = wiki.get(it.id);
    if (!w) {
      missing++;
      continue;
    }
    if (w.quality !== undefined && w.quality !== it.quality) (it.quality = w.quality), quality++;
    if (w.dlc && w.dlc !== it.dlc) (it.dlc = w.dlc), dlc++;
    if (w.description) {
      const withCharge =
        it.type === "active" && w.recharge
          ? `${w.description} Recharge: ${w.recharge} ${/^\d+$/.test(w.recharge) ? "room(s)" : ""}`.trim() + "."
          : w.description;
      if (withCharge !== it.description) (it.description = withCharge), desc++;
    }
    if (w.quote && w.quote !== quotes[String(it.id)]) (quotes[String(it.id)] = w.quote), quote++;
  }

  writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2));
  writeFileSync(QUOTES_PATH, JSON.stringify(quotes, null, 2));

  // Generation-only extras: unlock method (achievement name → Cargo
  // requirements text) + trivia bullets, keyed by item id.
  const extra: Record<string, { unlock?: string; trivia?: string[] }> = {};
  for (const it of items) {
    const w = wiki.get(it.id);
    if (!w) continue;
    const unlock = w.unlockedBy ? requirements.get(w.unlockedBy) : undefined;
    if (unlock || w.trivia) {
      extra[String(it.id)] = { ...(unlock ? { unlock } : {}), ...(w.trivia ? { trivia: w.trivia } : {}) };
    }
  }
  writeFileSync(EXTRA_PATH, JSON.stringify(extra, null, 1));
  console.log(`Wrote scripts/wiki-extra.json: ${Object.keys(extra).length} items with unlock/trivia.`);
  console.log(
    `Updated: ${quality} qualities, ${desc} descriptions, ${dlc} dlc tags, ${quote} quotes. ` +
      `${missing} of ${items.length} items not found on wiki (kept as-is).`,
  );
  if (missing > 50) {
    console.warn("High missing count — check whether the wiki templates were renamed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
