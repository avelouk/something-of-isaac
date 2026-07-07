/**
 * Endless mode: round N maps into a fixed pseudo-random permutation of all
 * item ids. The seed is a constant, so every player sees the same item on
 * the same round (results are comparable) and no item repeats until the
 * whole pool has been played once.
 */

import seedrandom from "seedrandom";
import { shuffleInPlace } from "./finalChoice.ts";
import type { Item } from "./hints.ts";

export function endlessItemFor(items: Item[], round: number): Item {
  // Guard against duplicated ids in items.json (build-items.ts dedupes now,
  // but a stale data file must not shift this shared permutation): everything
  // downstream identifies items by id, so serve each id at most once.
  const seen = new Set<number>();
  const unique = items.filter((it) => !seen.has(it.id) && seen.add(it.id));
  unique.sort((a, b) => a.id - b.id);
  shuffleInPlace(unique, seedrandom("endless-v1"));
  return unique[(round - 1) % unique.length];
}

/** Resume where the player left off when re-entering via ?endless=1. */
export function effectiveEndlessRound(urlRound: number, nextRound: number): number {
  if (urlRound === 1 && nextRound > 1) return nextRound;
  return urlRound;
}
