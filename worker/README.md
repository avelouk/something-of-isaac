# Worker

One Cloudflare Worker (free tier) behind the game. Four jobs:

| Job | Storage | Why |
|---|---|---|
| **Schedule** — answer item + optional hand-written hints per UTC day | KV `SCHEDULE_KV` | Small document edited by one person; 60s edge cache is fine. `public/data/schedule.json` in the repo is only an offline fallback. |
| **Daily stats** — unique visitors, pageviews, countries per UTC day | Durable Object `DailyRoom` | KV has no atomic counters; a DO serialises all writes for a day. |
| **Player state** — streak history + endless position per anonymous UUID | Durable Object `PlayerStore`, 16 shards | So streaks survive a domain move. Not a cross-device backup (see root README). |
| **Feedback** — REPORT A PROBLEM form → Telegram | none | Telegram is the inbox. |

Setup (KV namespace, `ADMIN_TOKEN`, Telegram secrets, `.env.local`) is in the root README under *One-time setup*. Deploy with `npm run deploy:stats`; run locally with `npm run dev:stats` and `VITE_STATS_WORKER_URL=http://127.0.0.1:8787` for Vite. If the first deploy fails with code 10063, open *Workers & Pages* in the Cloudflare dashboard once to provision your `workers.dev` subdomain.

## Endpoints

Bearer = `Authorization: Bearer <ADMIN_TOKEN>`.

### Schedule

Public reads strip the anti-cheat `hash` and are cached ~60s. Writes recompute the hash, validate (400) and reject past UTC dates (403).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/schedule/today` | public | Today's row. |
| GET | `/schedule/day?puzzle=<n>` or `?date=YYYY-MM-DD` | public | One row; 403 for future days. |
| GET | `/schedule` | bearer | Full dump `{ version, salt, entries[] }` — used by the admin UI and `build:ladders`. |
| GET | `/schedule/entry/<date>` | bearer | One row with `hash`. |
| POST | `/schedule/entry` | bearer | `{ date, itemId, hints? }` upsert. Omit `hints` to keep, send six blanks to clear. Busts the day's cache. |
| PUT | `/schedule` | bearer | Replace everything (`npm run push:schedule`). |

### Stats

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/visit` | public | `{ visitorId? }`. Counts one pageview per call and one unique per visitor per UTC day. Missing/empty id still counts the pageview; malformed id → 400. Returns `{ unique, newVisitor }`. |
| GET | `/stats/history?from=&to=` | bearer | `{ days: [{ date, unique, pageviews, countries }] }`, max 400 days. `pageviews` is 0 before 2026-08-14. |

```sh
curl -sS -G "$WORKER_URL/stats/history" --data-urlencode from=2026-01-01 --data-urlencode to=2026-12-31 \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

How much to trust it: better than the Cloudflare beacon (a `workers.dev` host isn't on blocklists by name) but not ground truth — `support.html` never calls it, and the endpoint is unauthenticated with no per-visitor cap, so a replayed UUID inflates `pageviews`. Sanity-check before quoting numbers to an ad network.

### Player state

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/player/sync` | public | `{ v: 1, visitorId, daily?, endless?, endlessNextRound? }`. Merges into stored state, returns the merged result + `changed`, `updatedAt`. Sending no state fields is a pull. |
| GET | `/player/stats` | bearer | Coverage across shards: `{ players, updated1d, updated7d, updated30d, bytes, maxBytes, shards }`. |

Design notes, all deliberate:

- **One endpoint, always merge-and-return.** The merge (`src/playerState.ts`, shared with the client) is commutative, associative and idempotent. `POST` instead of `GET /player/:id` keeps the UUID out of logs and cache keys.
- **Additive, never replaces.** Histories are unioned by puzzle number (win beats loss), aggregates recomputed server-side from history — client-sent `played`/`won`/`currentStreak` are never trusted; `bestStreak` is monotone. A client wiped by a `SCHEMA_VERSION` bump pushes empty, gets everything back.
- **Write only on change.** State is stored canonically, so unchanged syncs write nothing and a first page load creates no row. ~1 write per player per day. This is also the rate limit: a replayed body is a no-op.
- **The UUID is the password.** UUIDv4, unguessable, but anyone holding one can read/merge that player's stats. Nothing sensitive may go in this blob. Bounded by per-record validation, 1200 records per bucket, a body-size cap and 20,000 rows per shard.
- **16 shards** on the first hex nibble, from day one — rows are cumulative ids, not active players, and re-sharding Durable Objects later has no safe rollback.

### Feedback

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/feedback` | public | Forwards the message (plus puzzle number and country) to Telegram. 1000-char cap, 50 reports per UTC day. 503 if `TELEGRAM_*` secrets are unset. |
