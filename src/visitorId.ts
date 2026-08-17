/**
 * The anonymous per-browser id, shared by the daily counter (analytics.ts) and
 * player state sync (playerSync.ts). Both need the same value, and duplicating
 * the lazy-create would mint two.
 *
 * Not `idg:`-prefixed on purpose, so storage.ts's ensureSchema() wipe leaves it
 * alone — identity survives a local stats reset, which is what makes recovery
 * from the server possible.
 *
 * It is still origin-scoped, though, exactly like the stats it unlocks. On a new
 * domain getVisitorId() would mint a fresh id and the server's copy would be
 * unreachable forever, so a move has to hand the old id over explicitly. That is
 * what adoptVisitorIdFromUrl is for.
 */

import { isVisitorId } from "./limits.ts";

const VISITOR_KEY = "soi-visitor-id";
const ADOPT_PREFIX = "soi=";

export function getVisitorId(): string {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

/**
 * Domain handoff: adopt an id passed in the URL fragment (`#soi=<uuid>`).
 *
 * The fragment rather than a query string because a fragment is never sent to
 * the server — same reason /player/sync is a POST. The id is a bearer
 * credential for that player's stats and does not belong in anyone's logs.
 *
 * Must run before anything else reads the id, or the first /visit of the session
 * registers a freshly-minted id and the migrating player double-counts.
 */
export function adoptVisitorIdFromUrl(): void {
  try {
    const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    if (!hash.startsWith(ADOPT_PREFIX)) return;

    const candidate = decodeURIComponent(hash.slice(ADOPT_PREFIX.length)).trim().toLowerCase();
    // Strip it whether or not we adopt: it has served its purpose, and leaving
    // it in the address bar invites it into a screenshot or a shared link.
    history.replaceState(null, "", location.pathname + location.search);

    if (!isVisitorId(candidate)) return;
    // Never clobber an existing identity — this browser may already have real
    // history of its own, and the server merge will reconcile the two anyway
    // only if we keep the id it already knows.
    if (localStorage.getItem(VISITOR_KEY)) return;

    localStorage.setItem(VISITOR_KEY, candidate);
  } catch {
    // Blocked storage, or a document without a usable history API.
  }
}
