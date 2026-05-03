/**
 * Game state machine. No DOM. Owns:
 *   - the resolved daily item
 *   - the player's guess history
 *   - the number of hints currently revealed
 *   - whether the player has fallen into the multiple-choice round
 *   - the won/lost outcome
 *
 * Flow: auto-reveal on wrong guess. Hint #1 visible at start. Each
 * wrong guess reveals the next. After all 6 text hints are out, the
 * next wrong guess kicks the player into a 4-option multiple-choice
 * round. One pick decides the game.
 */

import { HINT_COUNT } from "./hints.ts";
import type { Item } from "./hints.ts";
import type { Progress } from "./storage.ts";

export type Phase = "guessing" | "multipleChoice" | "won" | "lost";

export type GameState = {
  puzzleNumber: number;
  answer: Item;
  guessIds: number[];
  hintsRevealed: number; // 1..HINT_COUNT
  phase: Phase;
  /** True once the player has been forced into the multiple-choice round (sticky). */
  usedFinalChoice: boolean;
  firstSeenAt: number;
  finishedAt?: number;
  activeSeconds: number;
};

export function isPlaying(state: GameState): boolean {
  return state.phase === "guessing" || state.phase === "multipleChoice";
}

export function isFinished(state: GameState): boolean {
  return state.phase === "won" || state.phase === "lost";
}

export function newGame(puzzleNumber: number, answer: Item, now = Date.now()): GameState {
  return {
    puzzleNumber,
    answer,
    guessIds: [],
    hintsRevealed: 1,
    phase: "guessing",
    usedFinalChoice: false,
    firstSeenAt: now,
    activeSeconds: 0,
  };
}

export function fromProgress(progress: Progress, answer: Item): GameState {
  let phase: Phase;
  if (progress.finished) {
    phase = progress.won ? "won" : "lost";
  } else if (progress.usedFinalChoice) {
    phase = "multipleChoice";
  } else {
    phase = "guessing";
  }
  return {
    puzzleNumber: progress.puzzleNumber,
    answer,
    guessIds: progress.guessIds.slice(),
    hintsRevealed: Math.max(1, Math.min(HINT_COUNT, progress.hintsRevealed)),
    phase,
    usedFinalChoice: !!progress.usedFinalChoice,
    firstSeenAt: progress.firstSeenAt,
    finishedAt: progress.finishedAt,
    activeSeconds: progress.activeSeconds ?? 0,
  };
}

export function toProgress(state: GameState): Progress {
  return {
    puzzleNumber: state.puzzleNumber,
    guessIds: state.guessIds.slice(),
    hintsRevealed: state.hintsRevealed,
    finished: state.phase === "won" || state.phase === "lost",
    won: state.phase === "won",
    usedFinalChoice: state.usedFinalChoice,
    firstSeenAt: state.firstSeenAt,
    finishedAt: state.finishedAt,
    activeSeconds: state.activeSeconds,
  };
}

/**
 * Apply a guess from the autocomplete (text/sprite picker) phase.
 * Mutates state in-place and returns the outcome of this single guess.
 *
 *   "correct"        — answer matched, won.
 *   "wrong"          — wrong guess, next hint revealed.
 *   "finalChoice"    — wrong guess that exhausted all 6 hints; player
 *                      now in the multiple-choice round.
 *   "ignored"        — duplicate guess or wrong phase.
 */
export function applyGuess(
  state: GameState,
  guessId: number,
  now = Date.now(),
): "correct" | "wrong" | "finalChoice" | "ignored" {
  if (state.phase !== "guessing") return "ignored";
  if (state.guessIds.includes(guessId)) return "ignored";
  state.guessIds.push(guessId);

  if (guessId === state.answer.id) {
    state.phase = "won";
    state.finishedAt = now;
    return "correct";
  }

  if (state.hintsRevealed < HINT_COUNT) {
    state.hintsRevealed += 1;
    return "wrong";
  }
  // All hints exhausted — drop into the multiple-choice round.
  state.phase = "multipleChoice";
  state.usedFinalChoice = true;
  return "finalChoice";
}

/**
 * Apply the player's pick in the multiple-choice round. One shot —
 * correct wins, anything else loses.
 */
export function applyFinalChoice(
  state: GameState,
  guessId: number,
  now = Date.now(),
): "correct" | "lost" | "ignored" {
  if (state.phase !== "multipleChoice") return "ignored";
  if (!state.guessIds.includes(guessId)) state.guessIds.push(guessId);
  if (guessId === state.answer.id) {
    state.phase = "won";
    state.finishedAt = now;
    return "correct";
  }
  state.phase = "lost";
  state.finishedAt = now;
  return "lost";
}

export function score(state: GameState): number {
  // Number of hints visible when correctly guessed.
  // Lost games score HINT_COUNT.
  return state.phase === "won" ? state.hintsRevealed : HINT_COUNT;
}
