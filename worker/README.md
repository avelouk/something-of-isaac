# Daily stats + schedule worker

This folder is a **Cloudflare Worker** that does three jobs:

1. **Daily stats** — a **Durable Object** stores one bucket per UTC day: unique visitor count (by anonymous UUID) and optional aggregate counts by country (Cloudflare geo on first visit only).
2. **Schedule** — a **KV namespace** (`SCHEDULE_KV`) is the single source of truth for the daily puzzle: which collectible is the answer each UTC day, plus optional hand-written hints. The game fetches today's row from here; `public/data/schedule.json` in the repo is only an offline fallback.
3. **Player state** — a second **Durable Object** class (`PlayerStore`) holds each player's streak history and endless position, keyed by the same anonymous UUID as `/visit`. Primarily so streaks survive the move to a new domain; see the recovery table in the root README for what it does and does not cover (the UUID lives in `localStorage` too, so it is not a cross-device backup).

## Why a Durable Object for stats / KV for the schedule?

Workers KV does not give you atomic counters or a reliable way to count “unique keys” for thousands of visitors, so stats use a Durable Object — all writes for a given day run in one place and the number stays consistent. The schedule is a small, mostly-read document edited by one person, so plain KV (with 60s edge caching) is the right fit.

## One-time setup

1. Create a Cloudflare account (free tier is enough for modest traffic).
2. In the dashboard, open **Workers & Pages** once. That provisions your **`workers.dev` subdomain** (required to deploy). If `wrangler deploy` fails with **code 10063**, you skipped this step.
3. Install CLI (from repo root): `npm install`
4. Log in: `npx wrangler login`
5. Deploy: `npm run deploy:stats`

First deploy applies the `[[migrations]]` entry in `wrangler.toml` (SQLite-backed Durable Object — required on **Workers Free**).

If you ever deployed this worker with the older `new_classes` migration successfully on a paid plan, talk to Cloudflare docs before switching; Free tier cannot use that backend.

For the schedule, also create the **`SCHEDULE_KV`** namespace and set the **`ADMIN_TOKEN`** secret — see **Schedule store (one-time worker setup)** in the root README, then seed it with `npm run push:schedule`.

## Wire the game to the worker

Copy the deployed URL (looks like `https://something-of-isaac-stats.<you>.workers.dev`).

Build the Vite app with:

```bash
VITE_STATS_WORKER_URL=https://something-of-isaac-stats.<you>.workers.dev npm run build
```

Or add a `.env.production` (not committed) with:

```
VITE_STATS_WORKER_URL=https://...
```

GitHub Actions: set repository **Variable** **`VITE_STATS_WORKER_URL`** (see root README).

## Try locally

From repo root:

```bash
npm run dev:stats
```

Temporarily set `VITE_STATS_WORKER_URL=http://127.0.0.1:8787` when running `npm run dev`.

## Endpoints

### Stats

| Method | Path    | Purpose |
|--------|---------|---------|
| POST   | `/visit` | Body: `{ "visitorId": "<uuid>" }`. Counts at most once per visitor per UTC day, **and once per call as a pageview**. `visitorId` may be **omitted or empty** (browsers blocking `localStorage`): the pageview still counts, the unique/country buckets are skipped. A *malformed* id is rejected with 400 and counts nothing. Returns `{ unique, newVisitor }`. |
| GET    | `/stats/history?from=YYYY-MM-DD&to=YYYY-MM-DD` | **Bearer `ADMIN_TOKEN`**. Returns `{ from, to, days: [{ date, unique, pageviews, countries }] }` for each UTC day in range. Days with no traffic show `unique: 0`. Max **400** days per request. |

On each **new** visitor that UTC day, the Worker increments per-country buckets using Cloudflare geo (stored in the DO; returned only on `/stats/history`, not on `/visit`).

**Pageviews vs. uniques.** `/visit` fires on every page load, so `pageviews` counts loads while `unique` counts people — endless-mode "NEXT ITEM" reloads show up in `pageviews` only. Requests with a malformed `visitorId` are rejected before counting. Ad networks (Nitro, Playwire) ask for monthly pageviews on their application forms — this is that number. Days before this shipped (before 2026-08-14) report `pageviews: 0`.

**How much to trust it.** More than the Cloudflare Web Analytics beacon in `index.html`, but it is not ground truth:

- *Blocking.* The worker is a separate host (`*.workers.dev`) from the site, not a same-origin endpoint — that cross-origin split is why this file ships CORS headers, and blockers filter by hostname. The practical difference is that `static.cloudflareinsights.com` is on EasyPrivacy and similar lists **by name**, while an arbitrary `workers.dev` subdomain is not on standard lists. So expect less blocking here, not zero.
- *Undercounts.* `support.html` loads no bundle, so it never calls `/visit` — the Cloudflare beacon is the only thing covering that page. Everything else that used to be lost is now counted: the ping fires before `main()` (so a failed boot still registers) and no longer requires `localStorage` or the `#daily-players` element.
- *Inflatable.* The endpoint is unauthenticated and the counter has no per-visitor cap, so a replayed UUID can raise `pageviews` without bound. Sanity-check the daily numbers before quoting them to an ad network.

### Schedule (`SCHEDULE_KV`)

Public per-day reads strip the `hash` field and are edge-cached for ~60s. The full dump and all writes require **Bearer `ADMIN_TOKEN`**. Writes recompute the hash server-side, reject malformed bodies (400), and reject edits to **past UTC dates** (403).

| Method | Path    | Auth | Purpose |
|--------|---------|------|---------|
| GET    | `/schedule/today` | public | Today's row (UTC), hash stripped. |
| GET    | `/schedule/day?puzzle=<n>` (or `?date=YYYY-MM-DD`) | public | One day's row, hash stripped. 403 for future days. |
| GET    | `/schedule` | bearer | Full schedule `{ version, salt, entries[] }`. Used by the admin UI. |
| GET    | `/schedule/entry/<date>` | bearer | One row including `hash`. |
| POST   | `/schedule/entry` | bearer | Body `{ date, itemId, hints? }`. Upserts one row; omitting `hints` keeps the existing ones. Busts the day's cache. |
| PUT    | `/schedule` | bearer | Replace the whole schedule (used by `npm run push:schedule` to seed). Validates every entry. |

There is no authentication on `/visit`; the counter is public by design. Abuse could inflate counts; for a small puzzle game this is usually acceptable.

### Player state (`PLAYER_STORE`)

`localStorage` is origin-scoped, so without a server copy every returning player would start at zero the day the game moves to its own domain — and streaks are the whole retention mechanism. This endpoint is that copy.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST   | `/player/sync`  | public | Body `{ v: 1, visitorId, daily?, endless?, endlessNextRound? }`. Merges the submitted state into the stored one and returns the merged result plus `changed` and `updatedAt`. All three state fields are optional — sending none is a **pull**. |
| GET    | `/player/stats` | bearer | Coverage snapshot across all shards: `{ players, updated1d, updated7d, updated30d, bytes, maxBytes, shards }`. |

**One endpoint, always merge-and-return.** The merge (`src/playerState.ts`, shared with the client so the two can't drift) is commutative, associative and idempotent, so a sync carrying no local changes *is* a pull. `POST` rather than `GET /player/:id` keeps the visitor id out of request logs and out of any cache key.

**The merge is additive and never replaces.** This matters: `storage.ts`'s `ensureSchema()` wipes local state on a schema bump, so a client can legitimately submit an empty history for a player who has months of it. The server keeps everything and hands it back, which turns a schema bump from data loss into a round trip. Histories are unioned by puzzle number (a win beats a loss for the same puzzle), re-sorted, and the aggregate is recomputed by replaying the same fold the client uses — client-submitted `played`/`won`/`currentStreak` are never trusted. `bestStreak` is monotone so a truncated history can't cost anyone their record.

**Write budget.** State is stored canonically, so string equality is a valid "did anything change?" test and an unchanged sync writes nothing at all. A first page load — before the player has finished anything — creates no row, which keeps the private-mode UUID churn off the books. In practice that's ~1 write per player per day.

**How much to trust it.** Same posture as `/visit`: unauthenticated, and **the visitor UUID is effectively the password**. Anyone holding one can read and merge into that player's stats. UUIDv4 makes guessing infeasible, and inflated numbers only affect the attacker's own stats since there is no leaderboard — but **nothing sensitive may ever go in this blob**. There is deliberately no rate limit: a replayed body merges to no change and writes nothing, so the write-skip *is* the rate limit. Growth is bounded instead by per-record validation, a 1200-record cap per bucket, a body-size cap, and an admission cap of 20,000 rows per shard (existing players always keep syncing).

Rows are sharded 16 ways on the first hex nibble of the visitor id — uniform for UUIDv4. Rows are *cumulative* ids rather than active players, so a single instance would need re-sharding within a couple of years, and moving rows between Durable Objects later has no safe rollback.

### Example: export daily uniques

```bash
export WORKER="https://something-of-isaac-stats.<you>.workers.dev"
export TOKEN="your-admin-token"   # same as wrangler secret ADMIN_TOKEN

curl -sS -G "$WORKER/stats/history" \
  --data-urlencode "from=2026-01-01" \
  --data-urlencode "to=2026-12-31" \
  -H "Authorization: Bearer $TOKEN" | jq .
```
