# Daily stats + schedule worker

This folder is a **Cloudflare Worker** that does two jobs:

1. **Daily stats** — a **Durable Object** stores one bucket per UTC day: unique visitor count (by anonymous UUID) and optional aggregate counts by country (Cloudflare geo on first visit only).
2. **Schedule** — a **KV namespace** (`SCHEDULE_KV`) is the single source of truth for the daily puzzle: which collectible is the answer each UTC day, plus optional hand-written hints. The game fetches today's row from here; `public/data/schedule.json` in the repo is only an offline fallback.

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

### Example: export daily uniques

```bash
export WORKER="https://something-of-isaac-stats.<you>.workers.dev"
export TOKEN="your-admin-token"   # same as wrangler secret ADMIN_TOKEN

curl -sS -G "$WORKER/stats/history" \
  --data-urlencode "from=2026-01-01" \
  --data-urlencode "to=2026-12-31" \
  -H "Authorization: Bearer $TOKEN" | jq .
```
