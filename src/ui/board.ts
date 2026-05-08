/**
 * Renders the 7-row hint board. Hidden rows are visually placeholder-only
 * (number visible, body cleared); revealed rows show the hint text.
 *
 * Re-rendering the whole board on every state change is cheap and avoids
 * stale-row bugs during animations.
 */

import type { Hint } from "../hints.ts";

export function renderBoard(
  container: HTMLElement,
  hints: Hint[],
  revealed: number,
  previouslyRevealed: number = revealed,
  winningIndex?: number,
) {
  container.replaceChildren();
  hints.forEach((h, i) => {
    const isUnlocked = i < revealed;
    const isNewlyRevealed = isUnlocked && i >= previouslyRevealed;
    const isWinning = i === winningIndex;
    const row = document.createElement("div");
    row.className =
      "hint" +
      (isUnlocked ? " unlocked" : "") +
      (isNewlyRevealed ? " just-revealed" : "") +
      (isWinning ? " winning" : "");
    row.dataset.kind = h.kind;

    const num = document.createElement("div");
    num.className = "hint-num";
    num.textContent = String(i + 1);

    const body = document.createElement("div");
    body.className = "hint-body" + (isUnlocked ? "" : " locked");
    body.textContent = isUnlocked ? h.text : "—";

    row.append(num, body);
    container.appendChild(row);
  });
}

export function renderGuessList(
  container: HTMLElement,
  guesses: { id: number; name: string; correct?: boolean }[],
) {
  container.replaceChildren();
  for (const g of guesses) {
    const row = document.createElement("div");
    row.className = "guess-entry " + (g.correct ? "correct" : "wrong");
    row.textContent = g.name;
    container.appendChild(row);
  }
}
