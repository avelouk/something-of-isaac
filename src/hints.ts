/**
 * Generate the 7-hint ladder for an item, vague -> specific.
 *
 * Each hint is a complete natural-language sentence (not a label/value
 * pair) so the board reads like the original Reddit post:
 *
 *   1. It's a Quality 1 item.
 *   2. It's an active item.
 *   3. It appears in Shops and the Crane Game.
 *   4. It was added in Afterbirth.
 *   5. It breaks rocks and damages enemies.
 *   6. Description: "Rocks didn't stand a chance."
 *   7. Item name begins with: Notched...
 *
 * Hint #5 (effect summary) reuses the first sentence of the in-game
 * description. Hint #7 (name beginning) shows the first word with an
 * ellipsis — strong narrowing without giving the answer outright.
 */

export type Item = {
  id: number;
  name: string;
  quality: number;
  type: "passive" | "active" | "familiar";
  dlc: "rebirth" | "afterbirth" | "afterbirth+" | "repentance" | "repentance+";
  pools: string[];
  primaryTag: string;
  description: string;
  img: string;
  /** Optional hand-crafted hint sentences that override the auto-generated ones. */
  customHints?: string[];
};

export type HintKind =
  | "quality"
  | "type"
  | "pool"
  | "dlc"
  | "effect"
  | "quote"
  | "nameStart";

export type Hint = {
  kind: HintKind;
  text: string;
};

const TYPE_TEXT: Record<Item["type"], string> = {
  passive: "It's a passive item.",
  active: "It's an active item.",
  familiar: "It's a familiar.",
};

const DLC_TEXT: Record<Item["dlc"], string> = {
  rebirth: "It's a base-game (Rebirth) item.",
  afterbirth: "It was added in the Afterbirth DLC.",
  "afterbirth+": "It was added in the Afterbirth+ DLC.",
  repentance: "It was added in the Repentance DLC.",
  "repentance+": "It was added in the Repentance+ DLC.",
};

function joinList(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function poolSentence(pools: string[]): string {
  if (pools.length === 0) return "Its source is unknown.";
  return `It appears in the ${joinList(pools)}.`;
}

function effectSentence(item: Item): string {
  const desc = item.description.trim();
  if (!desc) {
    return item.primaryTag !== "miscellaneous"
      ? `Its key effect: ${item.primaryTag}.`
      : "Its effect is hard to describe.";
  }
  // First sentence — split on \n first (description lines), then on a
  // sentence terminator. Cap at 140 chars to avoid leaking too much.
  const firstLine = desc.split("\n")[0];
  const firstSentence = firstLine.split(/(?<=[.!?])\s+/)[0];
  let s = firstSentence.trim();
  if (s.length > 140) s = s.slice(0, 137).trimEnd() + "...";
  // Capitalize first letter, ensure trailing period.
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?]$/.test(s)) s += ".";
  return s;
}

function nameStart(name: string): string {
  // Strip leading "The " for the reveal — most "The X" items are guessed
  // by the second word anyway.
  const stripped = name.replace(/^the\s+/i, "");
  const words = stripped.split(/\s+/);
  if (words.length > 1) {
    // Multi-word: reveal first word.
    return `Item name begins with: ${words[0]}…`;
  }
  // Single-word: reveal first 3-4 chars.
  const first = stripped;
  const cut = Math.min(first.length - 1, Math.max(3, Math.ceil(first.length / 3)));
  return `Item name begins with: ${first.slice(0, cut)}…`;
}

const KIND_ORDER: HintKind[] = [
  "quality",
  "type",
  "pool",
  "dlc",
  "effect",
  "quote",
  "nameStart",
];

export function generateHints(item: Item, pickupQuote = ""): Hint[] {
  // If hand-crafted hints exist, use them verbatim; the kinds align
  // 1:1 with the canonical ladder so downstream code (board, share)
  // doesn't need to special-case overrides.
  if (item.customHints && item.customHints.length === HINT_COUNT) {
    return item.customHints.map((text, i) => ({ kind: KIND_ORDER[i], text }));
  }
  return [
    { kind: "quality", text: `It's a Quality ${item.quality} item.` },
    { kind: "type", text: TYPE_TEXT[item.type] },
    { kind: "pool", text: poolSentence(item.pools) },
    { kind: "dlc", text: DLC_TEXT[item.dlc] },
    { kind: "effect", text: effectSentence(item) },
    {
      kind: "quote",
      text: pickupQuote
        ? `Description: "${pickupQuote}"`
        : "Description: (none).",
    },
    { kind: "nameStart", text: nameStart(item.name) },
  ];
}

export const HINT_COUNT = 7;
