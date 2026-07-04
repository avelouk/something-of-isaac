/**
 * POST /feedback — player-submitted problem reports, forwarded to Telegram.
 *
 * Unauthenticated by design (any player can report), so it is deliberately dumb:
 * one text field, hard length cap, and a soft daily cap (KV counter) so a
 * script can't flood the Telegram chat. No storage — Telegram is the inbox.
 *
 * Setup (one-time):
 *   1. Create a bot with @BotFather, copy the token.
 *   2. Send the bot any message, then read your chat id from
 *      https://api.telegram.org/bot<token>/getUpdates
 *   3. npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/wrangler.toml
 *      npx wrangler secret put TELEGRAM_CHAT_ID  --config worker/wrangler.toml
 */

import type { Env } from "./index.ts";
import { FEEDBACK_MAX_CHARS } from "../../src/limits.ts";
import { utcTodayDateString } from "../../src/puzzle.ts";

/** Soft cap on delivered reports per UTC day; beyond it we return 429. */
const DAILY_CAP = 50;

export async function handleFeedback(
  request: Request,
  env: Env,
  json: (data: unknown, status?: number) => Response,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json({ error: "feedback not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const message = typeof obj.message === "string" ? obj.message.trim() : "";
  const puzzle =
    typeof obj.puzzle === "number" && Number.isInteger(obj.puzzle) && obj.puzzle > 0
      ? obj.puzzle
      : null;

  if (!message) return json({ error: "message required" }, 400);
  if (message.length > FEEDBACK_MAX_CHARS) {
    return json({ error: `message too long (max ${FEEDBACK_MAX_CHARS} chars)` }, 400);
  }

  // Soft cap: KV isn't atomic, but an approximate counter is enough here.
  const day = utcTodayDateString();
  const capKey = `feedback-count:${day}`;
  const count = Number((await env.SCHEDULE_KV.get(capKey)) ?? "0");
  if (count >= DAILY_CAP) return json({ error: "daily report limit reached" }, 429);

  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const country = cf?.country ?? "?";
  const text = [
    "🐛 Something of Isaac — feedback",
    `${puzzle ? `Puzzle #${puzzle}` : "No puzzle"} · ${country}`,
    "",
    message,
  ].join("\n");

  let tgOk = false;
  try {
    const tgRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      },
    );
    tgOk = tgRes.ok;
  } catch {
    tgOk = false;
  }
  if (!tgOk) return json({ error: "delivery failed" }, 502);

  // Count only delivered reports, so an outage + retries can't burn the day's cap.
  await env.SCHEDULE_KV.put(capKey, String(count + 1), { expirationTtl: 172800 });

  return json({ ok: true });
}
