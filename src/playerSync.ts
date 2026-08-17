/**
 * Background sync of player state with the worker (POST /player/sync).
 *
 * Silent by design: no UI, no settings, nothing to explain. Every failure path —
 * worker URL unset, offline, timeout, blocked storage, a bad response — leaves
 * localStorage exactly as it was, and the game behaves as it did before this
 * module existed.
 *
 * Every push is best-effort, because the sync on load always submits the full
 * local state. A push lost to a closing tab is picked up by the next page load,
 * so nothing here needs retries, queues, or `keepalive` (whose 64 KiB body cap
 * would silently break on a long history anyway).
 *
 * The merge is additive on both ends (see playerState.ts), which is what makes
 * the schema-wipe case safe: if storage.ts's ensureSchema() has just cleared
 * local stats, this pushes an empty state, the server keeps everything, and the
 * response rehydrates local. That is the recovery path, not a bug.
 */

import { PLAYER_SYNC_VERSION } from "./limits.ts";
import {
  mergePlayerState,
  sanitizePlayerState,
  statsEqual,
  type PlayerState,
} from "./playerState.ts";
import {
  loadEndless,
  loadEndlessStats,
  loadStats,
  saveEndlessProgress,
  saveEndlessStats,
  saveStats,
} from "./storage.ts";
import { getVisitorId } from "./visitorId.ts";
import { workerBase } from "./workerBase.ts";

const FETCH_TIMEOUT_MS = 5000;

let base: string | null = null;
let visitorId = "";
/** Resolves when the first sync of this page load has settled (never rejects). */
let settled: Promise<void> = Promise.resolve();
let inFlight: Promise<void> | null = null;
let dirty = false;

function readLocal(): PlayerState {
  return {
    daily: loadStats(),
    endless: loadEndlessStats(),
    endlessNextRound: loadEndless().nextRound,
  };
}

async function syncOnce(): Promise<void> {
  if (!base || !visitorId) return;

  const local = readLocal();
  let payload: unknown;
  try {
    const res = await fetch(`${base}/player/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        v: PLAYER_SYNC_VERSION,
        visitorId,
        daily: local.daily,
        endless: local.endless,
        endlessNextRound: local.endlessNextRound,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return;
    payload = await res.json();
  } catch {
    return; // offline, timeout, or worker misconfigured — keep local as-is.
  }

  if (typeof payload !== "object" || payload === null) return;
  if ((payload as { v?: unknown }).v !== PLAYER_SYNC_VERSION) return;

  // Validate the server's reply too. It's the same shared code the worker runs,
  // it's cheap, and it means a worker bug can't poison localStorage.
  const server = sanitizePlayerState(payload);

  // Re-read rather than reusing `local`: a puzzle can finish during the round
  // trip, and merging against the stale snapshot would drop that result.
  const current = readLocal();
  const merged = mergePlayerState(current, server);

  if (!statsEqual(current.daily, merged.daily)) saveStats(merged.daily);
  if (!statsEqual(current.endless, merged.endless)) saveEndlessStats(merged.endless);
  if (merged.endlessNextRound !== current.endlessNextRound) {
    saveEndlessProgress(merged.endlessNextRound);
  }
}

/** Run a sync, coalescing anything requested while one is already in flight. */
function kick(): Promise<void> {
  const run = syncOnce().finally(() => {
    inFlight = null;
    if (dirty) {
      dirty = false;
      kick();
    }
  });
  inFlight = run;
  return run;
}

/**
 * Pull server state and push whatever is local. Call once at module scope,
 * after adoptVisitorIdFromUrl().
 */
export function startPlayerSync(workerBaseUrl: string | undefined): void {
  base = workerBase(workerBaseUrl);
  // "" means the browser blocks localStorage: there is nothing to sync and
  // nowhere to put a result, so skip entirely rather than minting server rows
  // for an identity that won't survive the page.
  visitorId = base ? getVisitorId() : "";
  if (!base || !visitorId) return;
  settled = kick();
}

/** Fire-and-forget flush, for when a genuinely new result was just recorded. */
export function pushPlayerState(): void {
  if (!base || !visitorId) return;
  if (inFlight) {
    dirty = true;
    return;
  }
  void kick();
}

/**
 * Wait (briefly) for the initial sync before reading stats, so the modal doesn't
 * show pre-sync numbers. Capped because stale numbers now beat a hang: a human
 * takes seconds to reach the stats button, so this is normally already resolved.
 */
export function playerSyncSettled(timeoutMs = 400): Promise<void> {
  return Promise.race([
    settled,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
