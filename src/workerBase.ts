/**
 * Normalize VITE_STATS_WORKER_URL for fetch calls: trim, strip trailing
 * slashes. Returns null when unset/blank so callers can bail out early.
 */
export function workerBase(url: string | undefined): string | null {
  const base = url?.trim().replace(/\/+$/, "");
  return base ? base : null;
}
