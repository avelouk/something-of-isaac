/**
 * Game state machine. No DOM. Owns:
 *   - the resolved daily item
 *   - the player's guess history
 *   - the number of hints currently revealed
 *   - the won/lost outcome
 *
 * Flow: auto-reveal on wrong guess. Hint #1 visible at start. Each
 * wrong guess reveals the next. After all 7 revealed and still wrong,
 * the player loses.
 */

import { HINT_COUNT } from "./hints.ts";
import type { Item } from "./hints.ts";
import type { Progress } from "./storage.ts";

export type Phase = "guessing" | "won" | "lost";

export type GameState = {
  puzzleNumber: number;
  answer: Item;
  guessIds: number[];
  hintsRevealed: number; // 1..HINT_COUNT
  phase: Phase;
  firstSeenAt: number;
  finishedAt?: number;
  activeSeconds: number;
};

export function newGame(puzzleNumber: number, answer: Item, now = Date.now()): GameState {
  return {
    puzzleNumber,
    answer,
    guessIds: [],
    hintsRevealed: 1,
    phase: "guessing",
    firstSeenAt: now,
    activeSeconds: 0,
  };
}

export function fromProgress(progress: Progress, answer: Item): GameState {
  let phase: Phase = "guessing";
  if (progress.finished) phase = progress.won ? "won" : "lost";
  return {
    puzzleNumber: progress.puzzleNumber,
    answer,
    guessIds: progress.guessIds.slice(),
    hintsRevealed: Math.max(1, Math.min(HINT_COUNT, progress.hintsRevealed)),
    phase,
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
    finished: state.phase !== "guessing",
    won: state.phase === "won",
    firstSeenAt: state.firstSeenAt,
    finishedAt: state.finishedAt,
    activeSeconds: state.activeSeconds,
  };
}

/**
 * Apply a guess. Mutates state in-place and returns the outcome of
 * this single guess for UI feedback.
 */
export function applyGuess(
  state: GameState,
  guessId: number,
  now = Date.now(),
): "correct" | "wrong" | "lost" | "ignored" {
  if (state.phase !== "guessing") return "ignored";
  if (state.guessIds.includes(guessId)) return "ignored";
  state.guessIds.push(guessId);

  if (guessId === state.answer.id) {
    state.phase = "won";
    state.finishedAt = now;
    return "correct";
  }

  // Wrong guess: reveal the next hint, or lose if all are out.
  if (state.hintsRevealed < HINT_COUNT) {
    state.hintsRevealed += 1;
    return "wrong";
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
