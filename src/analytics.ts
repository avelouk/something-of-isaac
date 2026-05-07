/**
 * Optional daily counter via Cloudflare Worker (see worker/).
 * Uses a random UUID in localStorage — no accounts, no personal fields sent.
 */

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
 * If `workerBaseUrl` is set (VITE_STATS_WORKER_URL), registers this browser once per load
 * and updates #daily-players from the worker response.
 */
export async function initDailyStats(workerBaseUrl: string | undefined): Promise<void> {
  const base = workerBaseUrl?.trim().replace(/\/+$/, "");
  if (!base) return;

  const el = document.getElementById("daily-players");
  if (!el) return;

  const visitorId = getVisitorId();
  if (!visitorId) return;

  try {
    const visitRes = await fetch(`${base}/visit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId }),
    });
    if (!visitRes.ok) return;
    const data = (await visitRes.json()) as { unique?: unknown };
    if (typeof data.unique !== "number" || !Number.isFinite(data.unique)) return;
    el.textContent = `${data.unique.toLocaleString()} players today`;
    el.removeAttribute("hidden");
  } catch {
    // Offline or worker URL misconfigured — leave footer line hidden.
  }
}
