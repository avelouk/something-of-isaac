/**
 * Optional daily counter via Cloudflare Worker (see worker/).
 * Uses a random UUID in localStorage — no accounts, no personal fields sent.
 */

import { workerBase } from "./workerBase.ts";

const VISITOR_KEY = "soi-visitor-id";

function getVisitorId(): string {
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
 * If `workerBaseUrl` is set (VITE_STATS_WORKER_URL), registers this page load with the
 * worker (one pageview, plus this browser's first visit of the UTC day) and updates
 * #daily-players from the response.
 *
 * Counting comes first and is never gated on display: a missing footer element or a
 * browser that blocks localStorage used to skip the POST entirely, which silently lost
 * every private-browsing load. An absent visitorId still counts as a pageview worker-side;
 * it just skips the unique/country buckets.
 */
export async function initDailyStats(workerBaseUrl: string | undefined): Promise<void> {
  const base = workerBase(workerBaseUrl);
  if (!base) return;

  // "" when localStorage is unavailable — still a real page load, so still ping.
  const visitorId = getVisitorId();

  try {
    const visitRes = await fetch(`${base}/visit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(visitorId ? { visitorId } : {}),
      // Survive a navigation that starts before the request settles.
      keepalive: true,
    });
    if (!visitRes.ok) return;
    const data = (await visitRes.json()) as { unique?: unknown };
    if (typeof data.unique !== "number" || !Number.isFinite(data.unique)) return;
    const el = document.getElementById("daily-players");
    if (!el) return;
    el.textContent = `${data.unique.toLocaleString()} players today`;
    el.removeAttribute("hidden");
  } catch {
    // Offline or worker URL misconfigured — leave footer line hidden.
  }
}
