/**
 * Final-round multiple-choice resolution.
 *
 * After all 6 text hints are revealed and the player guesses wrong, the
 * game enters a one-shot multiple-choice round: the answer plus three
 * decoys, one wrong pick ends the game.
 *
 * Decoy strategy (in order of preference):
 *   1. Same quality + at least one shared item pool (the trap zone).
 *   2. Same quality only.
 *   3. Anything (last-resort relaxation, very rarely needed).
 *
 * Already-guessed items are excluded — showing a tile the player has
 * already ruled out is a freebie. The seed is `mc:${puzzleNumber}` so
 * the candidate ranking is stable across reloads, but the *visible* set
 * shifts naturally when the player has knocked decoys out via guessing.
 *
 * Tile order is shuffled with a separate seed so the answer isn't
 * always in the same slot.
 */

import seedrandom from "seedrandom";
import { FINAL_CHOICE_COUNT, type Item } from "./hints.ts";

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function pickFinalChoices(
  answer: Item,
  items: Item[],
  alreadyGuessed: number[],
  puzzleNumber: number,
): Item[] {
  const guessedSet = new Set(alreadyGuessed);
  const answerPools = new Set(answer.pools);

  const baseFilter = (it: Item) => it.id !== answer.id && !guessedSet.has(it.id);

  const tier1 = items.filter(
    (it) =>
      baseFilter(it) &&
      it.quality === answer.quality &&
      it.pools.some((p) => answerPools.has(p)),
  );
  const tier2 = items.filter(
    (it) => baseFilter(it) && it.quality === answer.quality,
  );
  const tier3 = items.filter(baseFilter);

  const decoyCount = FINAL_CHOICE_COUNT - 1;
  let pool = tier1;
  if (pool.length < decoyCount) pool = tier2;
  if (pool.length < decoyCount) pool = tier3;

  // Deterministic Fisher-Yates over the candidate pool.
  const rngPool = seedrandom(`mc:${puzzleNumber}`);
  const ordered = [...pool];
  shuffleInPlace(ordered, rngPool);
  const decoys = ordered.slice(0, decoyCount);

  // Independently shuffle the final 4 so the answer's tile slot rotates.
  const tiles = [answer, ...decoys];
  const rngOrder = seedrandom(`mc:order:${puzzleNumber}`);
  shuffleInPlace(tiles, rngOrder);
  return tiles;
}
