/**
 * Entry point. Loads data, resolves today's puzzle, hooks up the UI.
 *
 * URL params:
 *   ?puzzle=N — override today's puzzle (for QA / archive mode).
 */

import { hintsForPuzzle, HINT_COUNT, type Item } from "./hints.ts";
import {
  applyFinalChoice,
  applyGuess,
  fromProgress,
  isFinished,
  isPlaying,
  newGame,
  toProgress,
} from "./game.ts";
import type { GameState } from "./game.ts";
import {
  getPuzzleNumber,
  getEntryForPuzzle,
  migrateScheduleIfNeeded,
  type Schedule,
} from "./puzzle.ts";
import { loadProgress, saveProgress, recordResult, loadStats, type Stats } from "./storage.ts";
import { attachAutocomplete, indexItems, type Searchable } from "./ui/autocomplete.ts";
import { renderBoard, renderGuessList } from "./ui/board.ts";
import { copyToClipboard, shareString } from "./share.ts";
import { pickFinalChoices } from "./finalChoice.ts";
import { initDailyStats } from "./analytics.ts";
import { fetchHintsOverlay, applyHintsOverlay } from "./hintsOverlay.ts";

async function loadJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function formatBrandSub(): string {
  const now = new Date();
  return now
    .toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
    .toUpperCase();
}

function formatElapsed(seconds: number): string {
  const totalMs = Math.max(0, Math.floor(seconds * 1000));
  const m = Math.floor(totalMs / 60000).toString().padStart(2, "0");
  const s = Math.floor((totalMs % 60000) / 1000).toString().padStart(2, "0");
  const ms = (totalMs % 1000).toString().padStart(3, "0");
  return `⏱ ${m}:${s}.${ms}`;
}

/**
 * Counts wall-clock seconds while the game is in progress, including
 * while the tab is in the background. Pauses on win/loss. Persists
 * the running total into Progress so a reload resumes seamlessly.
 *
 * Display updates via rAF for smooth millisecond rendering; persistence
 * is a separate 1Hz interval to avoid hammering localStorage.
 */
function startElapsedTimer(
  el: HTMLElement,
  state: { activeSeconds: number; phase: string },
  onTick: () => void,
): () => void {
  const playing = () => state.phase === "guessing" || state.phase === "multipleChoice";
  const baseSeconds = state.activeSeconds;
  const startWall = Date.now();
  let rafId: number | null = null;
  let saveId: number | null = null;

  const compute = () => {
    state.activeSeconds = baseSeconds + (Date.now() - startWall) / 1000;
  };

  const stop = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (saveId !== null) {
      clearInterval(saveId);
      saveId = null;
    }
  };

  const renderFrame = () => {
    rafId = null;
    if (!playing()) {
      stop();
      return;
    }
    compute();
    el.textContent = formatElapsed(state.activeSeconds);
    rafId = requestAnimationFrame(renderFrame);
  };

  const persist = () => {
    if (!playing()) {
      stop();
      return;
    }
    compute();
    onTick();
  };

  el.textContent = formatElapsed(state.activeSeconds);
  if (playing()) {
    rafId = requestAnimationFrame(renderFrame);
    saveId = window.setInterval(persist, 1000);
  }

  // rAF doesn't fire while the tab is hidden; immediately repaint when
  // the tab returns so the timer doesn't show a stale value.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && playing()) {
      compute();
      el.textContent = formatElapsed(state.activeSeconds);
      if (rafId === null) rafId = requestAnimationFrame(renderFrame);
    }
  });

  return stop;
}

function renderHero(frame: HTMLElement, state: GameState) {
  frame.replaceChildren();
  if (isPlaying(state)) {
    const wrap = document.createElement("div");
    wrap.className = "blind blind-mystery";
    const img = document.createElement("img");
    img.className = "blind-icon";
    img.src = import.meta.env.BASE_URL + "img/questionmark.png";
    img.alt = "Unknown item";
    img.width = 32;
    img.height = 32;
    img.decoding = "async";
    wrap.appendChild(img);
    frame.appendChild(wrap);
    return;
  }
  // Reveal sprite on win/loss.
  if (state.answer.img) {
    const img = document.createElement("img");
    img.className = "item-sprite";
    img.src = state.answer.img;
    img.alt = state.answer.name;
    img.loading = "eager";
    frame.appendChild(img);
  } else {
    const blind = document.createElement("div");
    blind.className = "blind blind-outcome";
    blind.textContent = state.phase === "won" ? "✓" : "✗";
    frame.appendChild(blind);
  }
}

function renderHintHelp(el: HTMLElement, state: GameState) {
  if (state.phase === "won") el.textContent = "You got it.";
  else if (state.phase === "lost")
    el.textContent = "Game over — the answer is revealed above.";
  else if (state.phase === "multipleChoice")
    el.textContent = "Final round — pick the right item. One wrong choice ends it.";
  else el.textContent = "Each wrong guess unlocks the next hint.";
}

function nextResetCountdown(): string {
  const now = new Date();
  const utcEnd = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  const ms = utcEnd - now.getTime();
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function buildShareString(state: GameState): string {
  return shareString({
    won: state.phase === "won",
    hintsUsed: state.hintsRevealed,
    guessCount: state.guessIds.length,
    activeSeconds: state.activeSeconds,
    usedFinalChoice: state.usedFinalChoice,
  });
}

function showResultModal(state: GameState, quotes: Record<number, string>) {
  const root = $("modal-root");
  root.replaceChildren();

  let countdownId: number | null = null;
  const dismiss = () => {
    if (countdownId !== null) {
      clearInterval(countdownId);
      countdownId = null;
    }
    document.removeEventListener("keydown", onEscape);
    root.replaceChildren();
  };

  const onEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
  };
  document.addEventListener("keydown", onEscape);

  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.addEventListener("click", dismiss);

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  const close = document.createElement("button");
  close.className = "modal-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", dismiss);
  modal.appendChild(close);

  const title = document.createElement("div");
  title.className = "modal-title" + (state.phase === "won" ? " win" : "");
  title.textContent = state.phase === "won" ? "FOUND IT" : "DEFEATED";
  modal.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "modal-sub";
  const timeStr = formatElapsed(state.activeSeconds).replace("⏱ ", "");
  if (state.phase === "won") {
    sub.textContent = `${state.hintsRevealed} hint${state.hintsRevealed === 1 ? "" : "s"} · ${state.guessIds.length} ${state.guessIds.length === 1 ? "try" : "tries"} · ${timeStr}`;
  } else {
    sub.textContent = `The answer escaped you · ${timeStr}`;
  }
  modal.appendChild(sub);

  const answer = document.createElement("div");
  answer.className = "modal-answer";
  if (state.answer.img) {
    const img = document.createElement("img");
    img.className = "item-sprite";
    img.src = state.answer.img;
    img.alt = state.answer.name;
    answer.appendChild(img);
  }
  const ansName = document.createElement("div");
  ansName.className = "ans-name";
  ansName.textContent = state.answer.name.toUpperCase();
  answer.appendChild(ansName);
  const quote = quotes[state.answer.id];
  if (quote) {
    const flavor = document.createElement("div");
    flavor.className = "ans-flavor";
    flavor.textContent = `"${quote}"`;
    answer.appendChild(flavor);
  }
  modal.appendChild(answer);

  const share = document.createElement("div");
  share.className = "share-block";
  share.textContent = buildShareString(state);
  modal.appendChild(share);

  const btns = document.createElement("div");
  btns.className = "modal-btns";

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-primary";
  copyBtn.textContent = "COPY RESULTS";
  copyBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(share.textContent ?? "");
    copyBtn.textContent = ok ? "COPIED ✓" : "COPY FAILED";
    setTimeout(() => (copyBtn.textContent = "COPY SHARE"), 1600);
  });
  btns.appendChild(copyBtn);

  const statsBtn = document.createElement("button");
  statsBtn.className = "btn btn-secondary";
  statsBtn.textContent = "STATS";
  statsBtn.addEventListener("click", () => {
    dismiss();
    showStatsPopover(loadStats());
  });
  btns.appendChild(statsBtn);

  const closeModalBtn = document.createElement("button");
  closeModalBtn.className = "btn btn-secondary";
  closeModalBtn.textContent = "CLOSE";
  closeModalBtn.addEventListener("click", dismiss);
  btns.appendChild(closeModalBtn);

  modal.appendChild(btns);

  const supportWrap = document.createElement("div");
  supportWrap.className = "modal-support-link";
  const supportA = document.createElement("a");
  supportA.href = `${import.meta.env.BASE_URL}support.html`;
  supportA.textContent = "☕ SUPPORT THE PROJECT";
  supportWrap.appendChild(supportA);
  modal.appendChild(supportWrap);

  const next = document.createElement("div");
  next.className = "next-room";
  const updateNext = () => (next.textContent = `NEXT ITEM IN ${nextResetCountdown()}`);
  updateNext();
  countdownId = window.setInterval(updateNext, 1000);
  modal.appendChild(next);

  bg.appendChild(modal);
  root.appendChild(bg);
}

function showHelpModal() {
  const root = $("modal-root");
  root.replaceChildren();
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.addEventListener("click", () => root.replaceChildren());

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  const close = document.createElement("button");
  close.className = "modal-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => root.replaceChildren());
  modal.appendChild(close);

  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "HOW TO PLAY";
  modal.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "modal-sub";
  sub.textContent = "Guess the daily item with the fewest hints.";
  modal.appendChild(sub);

  const list = document.createElement("ul");
  list.style.textAlign = "left";
  list.style.lineHeight = "1.5";
  list.style.fontSize = "14px";
  list.style.color = "var(--ink)";
  list.style.padding = "0 4px 0 22px";
  list.style.margin = "0 0 18px";
  for (const txt of [
    "You start with one hint visible.",
    "Type a guess — name, pickup quote, or effect all match.",
    "Each wrong guess unlocks the next hint.",
    "After 6 hints, you fall into a 4-option final round. One wrong pick ends it.",
    "Lower hints used + fewer tries = better score.",
  ]) {
    const li = document.createElement("li");
    li.textContent = txt;
    list.appendChild(li);
  }
  modal.appendChild(list);

  const btns = document.createElement("div");
  btns.className = "modal-btns";
  const ok = document.createElement("button");
  ok.className = "btn btn-primary";
  ok.textContent = "GOT IT";
  ok.addEventListener("click", () => root.replaceChildren());
  btns.appendChild(ok);
  modal.appendChild(btns);

  bg.appendChild(modal);
  root.appendChild(bg);
}

function showStatsPopover(stats: Stats) {
  const root = $("modal-root");
  root.replaceChildren();

  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.addEventListener("click", () => root.replaceChildren());

  const pop = document.createElement("div");
  pop.className = "stats-pop";
  pop.style.position = "static";
  pop.style.width = "100%";
  pop.style.maxWidth = "300px";
  pop.addEventListener("click", (e) => e.stopPropagation());

  const title = document.createElement("div");
  title.className = "stats-title";
  title.textContent = "▸ STATS";
  pop.appendChild(title);

  const wins = stats.won;
  const totalHints = stats.history.filter((h) => h.won).reduce((a, h) => a + h.hintsUsed, 0);
  const totalAttempts = stats.history.filter((h) => h.won).reduce((a, h) => a + h.guesses, 0);
  const rows: Array<[string, string | number]> = [
    ["Played", stats.played],
    ["Wins", wins],
    ["Streak", stats.currentStreak],
    ["Best Streak", stats.bestStreak],
    ["Avg hints", wins ? (totalHints / wins).toFixed(1) : "—"],
    ["Avg tries", wins ? (totalAttempts / wins).toFixed(1) : "—"],
  ];
  for (const [k, v] of rows) {
    const r = document.createElement("div");
    r.className = "stat-row";
    const label = document.createElement("span");
    label.textContent = k;
    const val = document.createElement("span");
    val.className = "v";
    val.textContent = String(v);
    r.append(label, val);
    pop.appendChild(r);
  }

  const closeRow = document.createElement("div");
  closeRow.style.marginTop = "12px";
  closeRow.style.textAlign = "right";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-secondary";
  closeBtn.style.fontSize = "14px";
  closeBtn.style.padding = "6px 12px";
  closeBtn.textContent = "CLOSE";
  closeBtn.addEventListener("click", () => root.replaceChildren());
  closeRow.appendChild(closeBtn);
  pop.appendChild(closeRow);

  bg.appendChild(pop);
  root.appendChild(bg);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const puzzleOverride = Number(params.get("puzzle"));

  const [items, quotes, scheduleRaw, hintsOverlay] = await Promise.all([
    loadJSON<Item[]>(import.meta.env.BASE_URL + "data/items.json"),
    loadJSON<Record<number, string>>(import.meta.env.BASE_URL + "data/quotes.json"),
    loadJSON<Schedule>(import.meta.env.BASE_URL + "data/schedule.json"),
    fetchHintsOverlay(import.meta.env.VITE_STATS_WORKER_URL),
  ]);
  const schedule = migrateScheduleIfNeeded(scheduleRaw);
  applyHintsOverlay(schedule, hintsOverlay);

  const puzzleNumber =
    Number.isFinite(puzzleOverride) && puzzleOverride > 0
      ? puzzleOverride
      : getPuzzleNumber();
  const entry = getEntryForPuzzle(schedule, puzzleNumber);
  if (!entry) {
    document.body.innerHTML = `<div class="app"><h1>No puzzle for #${puzzleNumber}</h1><p>The schedule covers ${schedule.entries.length} days. Come back tomorrow.</p></div>`;
    return;
  }
  const answer = items.find((it) => it.id === entry.itemId);
  if (!answer) {
    document.body.innerHTML = `<div class="app"><h1>Item missing</h1></div>`;
    return;
  }

  const indexed = indexItems(items, quotes);
  const existing = loadProgress(puzzleNumber);
  const state: GameState = existing
    ? fromProgress(existing, answer)
    : newGame(puzzleNumber, answer);
  saveProgress(toProgress(state));

  $("brand-sub").textContent = formatBrandSub();
  $("puzzle-number").textContent = `PUZZLE #${puzzleNumber}`;
  void initDailyStats(import.meta.env.VITE_STATS_WORKER_URL);
  const stopTimer = startElapsedTimer($("utc-clock"), state, () => {
    // Persist active-time on each tick so a reload resumes from the same point.
    saveProgress(toProgress(state));
  });

  const hints = hintsForPuzzle(entry.hints, answer, quotes[answer.id]);
  const board = $("hints");
  const heroFrame = $("hero-frame");
  const hintHelp = $("hint-help");
  const guessHistory = $("guess-history");
  const hintsCount = $("hints-count");
  const attemptCount = $("attempt-count");
  const btnViewResults = $("btn-view-results") as HTMLButtonElement;

  const guessRow = $("guess-row");
  const finalChoiceEl = $("final-choice");
  const input = $("guess-input") as HTMLInputElement;
  const listbox = $("guess-listbox") as HTMLUListElement;
  const submit = $("guess-submit") as HTMLButtonElement;

  let pendingItem: Searchable | null = null;
  // Decoupled from state.hintsRevealed so we can keep revealing rows
  // post-win without corrupting the recorded score/share string.
  // Reloading a finished puzzle shows every hint — the player has
  // already earned the right to see them.
  let visibleHints = isFinished(state) ? HINT_COUNT : state.hintsRevealed;
  let prevVisible = visibleHints;

  function syncSubmitState() {
    if (state.phase !== "guessing") {
      submit.disabled = true;
      return;
    }
    submit.disabled = pendingItem == null;
  }

  function renderFinalChoice() {
    finalChoiceEl.replaceChildren();
    if (state.phase !== "multipleChoice") {
      finalChoiceEl.hidden = true;
      return;
    }
    const tiles = pickFinalChoices(state.answer, items, state.guessIds, state.puzzleNumber);
    for (const it of tiles) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fc-tile";
      btn.setAttribute("aria-label", it.name);
      if (it.img) {
        const img = document.createElement("img");
        img.src = it.img;
        img.alt = "";
        img.loading = "eager";
        img.className = "fc-sprite";
        btn.appendChild(img);
      }
      const name = document.createElement("div");
      name.className = "fc-name";
      name.textContent = it.name;
      btn.appendChild(name);
      btn.addEventListener("click", () => commitFinalChoice(it));
      finalChoiceEl.appendChild(btn);
    }
    finalChoiceEl.hidden = false;
  }

  function refresh() {
    if (state.hintsRevealed > visibleHints) visibleHints = state.hintsRevealed;
    const winningIndex =
      state.phase === "won" && !state.usedFinalChoice
        ? state.hintsRevealed - 1
        : undefined;
    renderBoard(board, hints, visibleHints, prevVisible, winningIndex);
    prevVisible = visibleHints;
    renderHero(heroFrame, state);
    renderHintHelp(hintHelp, state);
    renderGuessList(
      guessHistory,
      state.guessIds.map((id) => ({
        id,
        name: items.find((it) => it.id === id)?.name ?? `#${id}`,
        correct: id === state.answer.id,
      })),
    );
    hintsCount.textContent = `${state.hintsRevealed}/${HINT_COUNT}`;
    attemptCount.textContent = String(state.guessIds.length);

    // Hide the text/sprite picker once we leave the guessing phase.
    const inGuess = state.phase === "guessing";
    guessRow.hidden = !inGuess;
    if (!inGuess) input.disabled = true;

    renderFinalChoice();
    btnViewResults.hidden = isPlaying(state);
    syncSubmitState();
  }
  refresh();

  attachAutocomplete({
    input,
    listbox,
    items: indexed,
    onSelect: (item) => {
      pendingItem = item;
      syncSubmitState();
    },
  });

  function commitGuess() {
    if (state.phase !== "guessing") return;
    if (!pendingItem) return;
    const outcome = applyGuess(state, pendingItem.id);
    if (outcome === "ignored") return;
    saveProgress(toProgress(state));
    input.value = "";
    pendingItem = null;
    refresh();
    if (outcome === "correct") revealRemainingThenFinalize();
  }

  // After a correct guess, cascade the unseen hints in one by one so
  // the player can read what they would have gotten, then open the
  // result modal.
  function revealRemainingThenFinalize() {
    const INITIAL_PAUSE_MS = 600;
    const STAGGER_MS = 1000;
    const FINAL_PAUSE_MS = 1000;
    const step = () => {
      visibleHints += 1;
      refresh();
      if (visibleHints < HINT_COUNT) setTimeout(step, STAGGER_MS);
      else setTimeout(finalize, FINAL_PAUSE_MS);
    };
    if (visibleHints >= HINT_COUNT) setTimeout(finalize, FINAL_PAUSE_MS);
    else setTimeout(step, INITIAL_PAUSE_MS);
  }

  function commitFinalChoice(it: Item) {
    if (state.phase !== "multipleChoice") return;
    applyFinalChoice(state, it.id);
    saveProgress(toProgress(state));
    refresh();
    if (isFinished(state)) finalize();
  }

  function finalize() {
    stopTimer();
    recordResult(
      {
        puzzleNumber: state.puzzleNumber,
        won: state.phase === "won",
        hintsUsed: state.hintsRevealed,
        guesses: state.guessIds.length,
        finishedAt: state.finishedAt ?? Date.now(),
        activeSeconds: state.activeSeconds,
      },
      state.puzzleNumber,
    );
    showResultModal(state, quotes);
  }

  submit.addEventListener("click", commitGuess);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && listbox.hidden) commitGuess();
  });

  $("btn-help").addEventListener("click", showHelpModal);
  $("btn-stats").addEventListener("click", () => showStatsPopover(loadStats()));
  btnViewResults.addEventListener("click", () => showResultModal(state, quotes));

  // Finished puzzle: sync stats, but do not auto-open the result modal (use VIEW RESULTS).
  if (isFinished(state)) {
    stopTimer();
    recordResult(
      {
        puzzleNumber: state.puzzleNumber,
        won: state.phase === "won",
        hintsUsed: state.hintsRevealed,
        guesses: state.guessIds.length,
        finishedAt: state.finishedAt ?? Date.now(),
        activeSeconds: state.activeSeconds,
      },
      state.puzzleNumber,
    );
  }
}

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div class="app"><h1>Boot error</h1><pre>${String(e)}</pre></div>`;
});
