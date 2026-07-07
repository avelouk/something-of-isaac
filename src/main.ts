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
import {
  loadEndless,
  loadProgress,
  loadStats,
  markEndlessRoundComplete,
  recordResult,
  saveProgress,
  type Stats,
} from "./storage.ts";
import { attachAutocomplete, indexItems, type Searchable } from "./ui/autocomplete.ts";
import { renderBoard, renderGuessList } from "./ui/board.ts";
import { openModal } from "./ui/modal.ts";
import { copyToClipboard, shareString } from "./share.ts";
import { pickFinalChoices } from "./finalChoice.ts";
import { initDailyStats } from "./analytics.ts";
import { showFeedbackModal } from "./feedback.ts";
import { effectiveEndlessRound, endlessItemFor } from "./endless.ts";
import { fetchScheduleEntry, type PublicScheduleEntry } from "./scheduleFetch.ts";

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

function buildShareString(state: GameState, label?: string): string {
  return shareString({
    won: state.phase === "won",
    hintsUsed: state.hintsRevealed,
    guessCount: state.guessIds.length,
    activeSeconds: state.activeSeconds,
    usedFinalChoice: state.usedFinalChoice,
    label,
  });
}

/** endlessRound: null for the daily game, the round number in endless mode. */
function showResultModal(
  state: GameState,
  quotes: Record<number, string>,
  endlessRound: number | null = null,
) {
  let countdownId: number | null = null;
  const { modal, dismiss } = openModal({
    onClose: () => {
      if (countdownId !== null) {
        clearInterval(countdownId);
        countdownId = null;
      }
    },
  });

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
  share.textContent = buildShareString(
    state,
    endlessRound ? `Endless #${endlessRound}` : undefined,
  );
  modal.appendChild(share);

  const btns = document.createElement("div");
  btns.className = "modal-btns";

  if (endlessRound) {
    const next = document.createElement("button");
    next.className = "btn btn-primary";
    next.textContent = "NEXT ITEM →";
    next.addEventListener("click", () => {
      location.search = `?endless=${endlessRound + 1}`;
    });
    btns.appendChild(next);
  }

  const copyBtn = document.createElement("button");
  copyBtn.className = endlessRound ? "btn btn-secondary" : "btn btn-primary";
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

  if (!endlessRound) {
    const endlessBtn = document.createElement("button");
    endlessBtn.className = "btn btn-secondary";
    endlessBtn.textContent = "∞ ENDLESS";
    endlessBtn.addEventListener("click", () => {
      location.search = "?endless=1";
    });
    btns.appendChild(endlessBtn);
  }

  modal.appendChild(btns);

  const supportWrap = document.createElement("div");
  supportWrap.className = "modal-support-link";
  const supportA = document.createElement("a");
  supportA.href = `${import.meta.env.BASE_URL}support.html`;
  supportA.textContent = "☕ SUPPORT THE PROJECT";
  supportWrap.appendChild(supportA);
  modal.appendChild(supportWrap);

  if (!endlessRound) {
    const next = document.createElement("div");
    next.className = "next-room";
    const updateNext = () => (next.textContent = `NEXT ITEM IN ${nextResetCountdown()}`);
    updateNext();
    countdownId = window.setInterval(updateNext, 1000);
    modal.appendChild(next);
  }
}

function showHelpModal() {
  const { modal, dismiss } = openModal();

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
  ok.addEventListener("click", dismiss);
  btns.appendChild(ok);
  modal.appendChild(btns);
}

function showStatsPopover(stats: Stats) {
  const { modal: pop, dismiss } = openModal({ className: "stats-pop", closeButton: false });
  pop.style.position = "static";
  pop.style.width = "100%";
  pop.style.maxWidth = "300px";

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
  closeBtn.addEventListener("click", dismiss);
  closeRow.appendChild(closeBtn);
  pop.appendChild(closeRow);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const puzzleOverride = Number(params.get("puzzle"));

  const puzzleNumber =
    Number.isFinite(puzzleOverride) && puzzleOverride > 0
      ? puzzleOverride
      : getPuzzleNumber();

  // Endless mode: ?endless=N plays round N of a fixed item permutation.
  const endlessRaw = params.get("endless");
  const endlessUrlRound =
    endlessRaw !== null ? Math.max(1, Math.trunc(Number(endlessRaw)) || 1) : 0;
  const isEndless = endlessUrlRound > 0;
  const endlessRound = isEndless
    ? effectiveEndlessRound(endlessUrlRound, loadEndless().nextRound)
    : 0;

  // The backend (SCHEDULE_KV) is the source of truth for the daily item + hints.
  // The committed schedule.json is only an offline fallback, lazy-loaded so the full
  // future schedule doesn't ship to every player on the happy path.
  const [items, quotes, backendEntry, ladders] = await Promise.all([
    loadJSON<Item[]>(import.meta.env.BASE_URL + "data/items.json"),
    loadJSON<Record<number, string>>(import.meta.env.BASE_URL + "data/quotes.json"),
    isEndless ? null : fetchScheduleEntry(import.meta.env.VITE_STATS_WORKER_URL, puzzleNumber),
    isEndless
      ? loadJSON<Record<string, string[]>>(import.meta.env.BASE_URL + "data/ladders.json").catch(
          () => ({}) as Record<string, string[]>,
        )
      : ({} as Record<string, string[]>),
  ]);

  let answer: Item | undefined;
  let entryHints: string[] | undefined;
  let ladderHints: string[] | undefined;
  if (isEndless) {
    answer = endlessItemFor(items, endlessRound);
    ladderHints = ladders[String(answer.id)];
  } else {
    let entry: PublicScheduleEntry | null = backendEntry;
    if (!entry) {
      const fallback = migrateScheduleIfNeeded(
        await loadJSON<Schedule>(import.meta.env.BASE_URL + "data/schedule.json"),
      );
      entry = getEntryForPuzzle(fallback, puzzleNumber);
    }
    if (!entry) {
      document.body.innerHTML = `<div class="app"><h1>No puzzle for #${puzzleNumber}</h1><p>Come back tomorrow.</p></div>`;
      return;
    }
    answer = items.find((it) => it.id === entry.itemId);
    entryHints = entry.hints;
  }
  if (!answer) {
    document.body.innerHTML = `<div class="app"><h1>Item missing</h1></div>`;
    return;
  }

  // No admin-authored hints for today: fall back to the generated ladder.
  // Lazy-loaded so the 270 KB file doesn't ship when hints are authored.
  if (!isEndless && (!entryHints || entryHints.length !== HINT_COUNT)) {
    const dailyLadders = await loadJSON<Record<string, string[]>>(
      import.meta.env.BASE_URL + "data/ladders.json",
    ).catch(() => ({}) as Record<string, string[]>);
    ladderHints = dailyLadders[String(answer.id)];
  }

  const indexed = indexItems(items, quotes);
  const existing = isEndless ? null : loadProgress(puzzleNumber);
  const state: GameState = existing
    ? fromProgress(existing, answer)
    : newGame(isEndless ? endlessRound : puzzleNumber, answer);
  const persist = () => {
    if (!isEndless) saveProgress(toProgress(state));
  };
  persist();

  $("brand-sub").textContent = formatBrandSub();
  $("puzzle-number").textContent = isEndless
    ? `ENDLESS #${endlessRound}`
    : `PUZZLE #${puzzleNumber}`;
  if (isEndless) {
    const modeLink = $("mode-link") as HTMLAnchorElement;
    modeLink.textContent = "← BACK TO DAILY";
    modeLink.href = location.pathname;
  }
  void initDailyStats(import.meta.env.VITE_STATS_WORKER_URL);
  const stopTimer = startElapsedTimer($("utc-clock"), state, () => {
    // Persist active-time on each tick so a reload resumes from the same point.
    persist();
  });

  const hints = hintsForPuzzle(entryHints, answer, quotes[answer.id], ladderHints);
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
    persist();
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
    persist();
    refresh();
    if (isFinished(state)) finalize();
  }

  function recordDailyResult() {
    if (isEndless) {
      markEndlessRoundComplete(endlessRound);
      return;
    }
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

  function finalize() {
    stopTimer();
    recordDailyResult();
    showResultModal(state, quotes, isEndless ? endlessRound : null);
  }

  submit.addEventListener("click", commitGuess);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && listbox.hidden) commitGuess();
  });

  $("btn-help").addEventListener("click", showHelpModal);
  $("btn-stats").addEventListener("click", () => showStatsPopover(loadStats()));
  $("btn-feedback").addEventListener("click", (e) => {
    e.preventDefault();
    showFeedbackModal(
      import.meta.env.VITE_STATS_WORKER_URL,
      puzzleNumber,
      isEndless ? `[Endless #${endlessRound}] ` : "",
    );
  });
  btnViewResults.addEventListener("click", () =>
    showResultModal(state, quotes, isEndless ? endlessRound : null),
  );

  // Finished puzzle: sync stats, but do not auto-open the result modal (use VIEW RESULTS).
  if (isFinished(state)) {
    stopTimer();
    recordDailyResult();
  }
}

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div class="app"><h1>Boot error</h1><pre>${String(e)}</pre></div>`;
});
