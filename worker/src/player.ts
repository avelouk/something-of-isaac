/**
 * POST /player/sync — cross-device player state (daily stats, endless stats,
 * endless position). GET /player/stats — admin coverage snapshot.
 *
 * Why this exists: localStorage is origin-scoped, so when the game moves to its
 * own domain every returning player would start at zero. Streaks are the whole
 * retention mechanism, so the server keeps a copy.
 *
 * One endpoint, always merge-and-return. A sync with no local delta IS a pull,
 * because the merge (src/playerState.ts) is commutative and idempotent. POST
 * rather than GET /player/:id so the visitor id stays out of request logs and
 * out of any cache key.
 *
 * The merge is ADDITIVE and never replaces. That is deliberate: storage.ts's
 * ensureSchema() wipes local state on a schema bump, so a client can legitimately
 * push an empty history for a player with months of it. The server keeps
 * everything and hands it back.
 *
 * Trust model, same posture as /visit: unauthenticated, and the visitor UUID is
 * effectively the password. Anyone holding one can read and merge into that
 * player's stats. UUIDv4 makes guessing infeasible, blast radius is bounded by
 * PLAYER_STORE_MAX_ROWS × the per-row caps, and nothing sensitive may ever go in
 * this blob. Inflated numbers only affect the attacker's own stats — there is no
 * leaderboard.
 */

import type { Env } from "./index.ts";
import {
  emptyPlayerState,
  mergePlayerState,
  sanitizePlayerState,
  serializePlayerState,
  type PlayerState,
} from "../../src/playerState.ts";
import {
  isVisitorId,
  PLAYER_STORE_MAX_ROWS,
  PLAYER_SYNC_MAX_BODY_BYTES,
  PLAYER_SYNC_VERSION,
} from "../../src/limits.ts";

/** Hex nibbles a v4 UUID can start with — one PlayerStore instance each. */
const SHARD_KEYS = "0123456789abcdef".split("");

/**
 * Rows are cumulative visitor ids, not active players, so a single instance
 * would need re-sharding within a year or two — and moving rows between Durable
 * Objects later is a one-shot migration with no safe rollback. Sharding on the
 * first nibble (uniform for UUIDv4) costs one function now and buys 16× the
 * storage and throughput headroom.
 */
export function playerShardName(visitorId: string): string {
  return `v1-${visitorId[0]}`;
}

/** Canonical form of "nothing worth storing" — see the row-creation guard below. */
const EMPTY_STATE_JSON = serializePlayerState(emptyPlayerState());

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handlePlayer(
  request: Request,
  env: Env,
  json: (data: unknown, status?: number) => Response,
  isAuthorized: (req: Request) => boolean,
  path: string,
): Promise<Response> {
  if (path === "/player/stats") return handlePlayerStats(request, env, json, isAuthorized);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Cheap pre-filter; absent on chunked bodies, so the real check is below.
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > PLAYER_SYNC_MAX_BODY_BYTES) {
    return json({ error: "payload too large" }, 413);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (raw.length > PLAYER_SYNC_MAX_BODY_BYTES) {
    return json({ error: "payload too large" }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (typeof body !== "object" || body === null) return json({ error: "invalid json" }, 400);
  const obj = body as Record<string, unknown>;

  if (obj.v !== PLAYER_SYNC_VERSION) {
    return json({ error: `unsupported version (expected ${PLAYER_SYNC_VERSION})` }, 400);
  }

  // Lowercased before it is used as both the shard key and the primary key, so a
  // hand-cased UUID can't land in a different shard than the client's own writes.
  const visitorId =
    typeof obj.visitorId === "string" ? obj.visitorId.trim().slice(0, 64).toLowerCase() : "";
  if (!isVisitorId(visitorId)) return json({ error: "visitorId must be a UUID" }, 400);

  // Anything malformed inside the history is dropped, never 400'd: a rejected
  // sync would make that client fall back to localStorage forever, silently,
  // which is the exact outcome this endpoint exists to prevent.
  const incoming = sanitizePlayerState(obj);

  const stub = env.PLAYER_STORE.get(env.PLAYER_STORE.idFromName(playerShardName(visitorId)));
  return stub.fetch(
    new Request("https://internal/player/__sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId, state: incoming }),
    }),
  );
}

/**
 * Admin coverage snapshot, fanned out across shards the same way
 * handleStatsHistory fans out across day rooms. The number that matters is
 * updated1d ÷ that day's `unique` from /stats/history: if it isn't close to 1,
 * a real slice of players never reaches this endpoint.
 */
async function handlePlayerStats(
  request: Request,
  env: Env,
  json: (data: unknown, status?: number) => Response,
  isAuthorized: (req: Request) => boolean,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);

  const totals = { players: 0, updated1d: 0, updated7d: 0, updated30d: 0, bytes: 0, maxBytes: 0 };
  const shards: Record<string, number> = {};

  try {
    const rows = await Promise.all(
      SHARD_KEYS.map(async (key) => {
        const name = `v1-${key}`;
        const stub = env.PLAYER_STORE.get(env.PLAYER_STORE.idFromName(name));
        const res = await stub.fetch(new Request("https://internal/player/__snapshot"));
        if (!res.ok) throw new Error(`snapshot failed for ${name}: ${res.status}`);
        return { name, data: (await res.json()) as Record<string, number> };
      }),
    );
    for (const { name, data } of rows) {
      shards[name] = data.players ?? 0;
      totals.players += data.players ?? 0;
      totals.updated1d += data.updated1d ?? 0;
      totals.updated7d += data.updated7d ?? 0;
      totals.updated30d += data.updated30d ?? 0;
      totals.bytes += data.bytes ?? 0;
      totals.maxBytes = Math.max(totals.maxBytes, data.maxBytes ?? 0);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }

  return json({ ...totals, maxRowsPerShard: PLAYER_STORE_MAX_ROWS, shards });
}

export class PlayerStore implements DurableObject {
  /**
   * Cached row count. The DO is the sole writer and single-threaded, so this
   * stays exact after one O(n) scan at cold start — no COUNT(*) per request.
   */
  private rows = 0;

  constructor(private readonly ctx: DurableObjectState) {
    // blockConcurrencyWhile guarantees no request is served before the table
    // exists and `rows` is primed.
    void this.ctx.blockConcurrencyWhile(async () => {
      // The repo's first real table. DailyRoom uses plain storage.get/put
      // because it holds a handful of counters; this one is a keyed table with
      // an ordered admin scan, so it wants SQL.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS players (
          visitor_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
      // Also makes a future DELETE FROM players WHERE updated_at < ? cheap.
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS players_updated_at ON players(updated_at)`,
      );
      this.rows = Number(this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM players`).one().n);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path.endsWith("/__snapshot")) return this.snapshot();
    if (path.endsWith("/__sync")) return this.sync(request);
    return new Response("Not found", { status: 404 });
  }

  private snapshot(): Response {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS players,
                COALESCE(SUM(CASE WHEN updated_at >= ?1 THEN 1 ELSE 0 END), 0) AS updated1d,
                COALESCE(SUM(CASE WHEN updated_at >= ?2 THEN 1 ELSE 0 END), 0) AS updated7d,
                COALESCE(SUM(CASE WHEN updated_at >= ?3 THEN 1 ELSE 0 END), 0) AS updated30d,
                COALESCE(SUM(LENGTH(state_json)), 0) AS bytes,
                COALESCE(MAX(LENGTH(state_json)), 0) AS maxBytes
         FROM players`,
        now - 86_400_000,
        now - 7 * 86_400_000,
        now - 30 * 86_400_000,
      )
      .one();
    return jsonResponse({
      players: Number(row.players),
      updated1d: Number(row.updated1d),
      updated7d: Number(row.updated7d),
      updated30d: Number(row.updated30d),
      bytes: Number(row.bytes),
      maxBytes: Number(row.maxBytes),
    });
  }

  private async sync(request: Request): Promise<Response> {
    const { visitorId, state } = (await request.json()) as {
      visitorId: string;
      state: PlayerState;
    };

    const existing = this.ctx.storage.sql
      .exec(`SELECT state_json FROM players WHERE visitor_id = ?`, visitorId)
      .toArray();
    const storedJson = existing.length ? String(existing[0].state_json) : null;

    const stored = storedJson ? sanitizePlayerState(JSON.parse(storedJson)) : emptyPlayerState();
    const merged = mergePlayerState(stored, state);
    const nextJson = serializePlayerState(merged);

    // Canonical serialization makes string equality a valid change test, which
    // is what holds this to ~1 write per player per day. When nothing changed we
    // skip the write entirely — including updated_at, since a precise "last
    // seen" is worth less than the write budget.
    //
    // The null case is not just an optimisation: a first page load syncs before
    // the player has finished anything, and every private-mode load mints a
    // fresh UUID. Materialising a row for each would burn the row budget on
    // players who have no state at all. Rows appear on first real result.
    const changed =
      storedJson === null ? nextJson !== EMPTY_STATE_JSON : storedJson !== nextJson;

    // Admission cap: unbounded UUID minting is the real attack here, not
    // inflated numbers. Only gate actual row creation — an existing player, or
    // anyone merely pulling, is never turned away.
    if (changed && storedJson === null && this.rows >= PLAYER_STORE_MAX_ROWS) {
      return jsonResponse({ error: "player store full" }, 503);
    }

    const updatedAt = Date.now();
    if (changed) {
      this.ctx.storage.sql.exec(
        `INSERT INTO players (visitor_id, state_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(visitor_id) DO UPDATE
           SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
        visitorId,
        nextJson,
        updatedAt,
      );
      if (storedJson === null) this.rows += 1;
    }

    return jsonResponse({
      v: PLAYER_SYNC_VERSION,
      daily: merged.daily,
      endless: merged.endless,
      endlessNextRound: merged.endlessNextRound,
      changed,
      updatedAt,
    });
  }
}
