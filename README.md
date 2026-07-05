# Something of Isaac

A daily Wordle-like puzzle for *The Binding of Isaac*. Guess today's collectible with as few hints as possible.

**Play:** [avelouk.com/something-of-isaac](https://avelouk.com/something-of-isaac/)

Inspired by [this r/bindingofisaac thread](https://www.reddit.com/r/bindingofisaac/comments/1t12aqm/try_to_guess_the_item_with_the_least_amount_of/) — *“Try to guess the Item with the least amount of Tips!”*

## How to play

You see one hint about today's item. Type a guess — name, pickup quote, effect, item pool, or a snippet of the description all match. If wrong, the next hint is revealed automatically. Six text hints, then an optional four-tile final round if you still have not guessed. Lower score (fewer hints used) is better. New puzzle every day at 00:00 UTC.

## Daily schedule & hints

The schedule lives in the **backend**. The worker's **`SCHEDULE_KV`** namespace is the single source of truth: each UTC day is one row — `date`, item id, optional **`hints`** (six strings), and a stable anti-cheat hash. The deployed game fetches just today's row from `GET /schedule/day?puzzle=<n>`; **`public/data/schedule.json`** is shipped only as an **offline fallback** if the worker is unreachable.

**Generating the schedule:** **`npm run build:schedule`** rewrites `schedule.json` with **no duplicate items** — every item appears once per ~719-day cycle, then the pool reshuffles and loops, and no item recurs within **100 days**. Everything from launch through *today* (UTC) is preserved **verbatim** (item + hints); only the future is regenerated. Authored hints survive regeneration because the generator merges the live backend (`GET /schedule`) onto the base before writing. Push the result to the backend with **`npm run push:schedule`** (`PUT /schedule`).

**Authoring items & hints:** run **`npm run admin`** (local-only UI on `127.0.0.1`) to pick a date (today or future UTC only), change the **answer item**, and edit the six hints. Past UTC dates are read-only (the worker rejects them with 403). The UI loads from and saves directly to the worker (`GET /api/schedule` → worker `GET /schedule`; `POST /api/save` → worker `POST /schedule/entry`), so both item and hints persist and changes appear on the live site within ~60s (cache TTL) — no git push or redeploy. See **Schedule store (one-time worker setup)** below.

**Which hints the game shows** (`hintsForPuzzle` in `src/hints.ts`), in order:

1. **`hints` on that day’s schedule row** — custom copy you added via admin.
2. Else **`customHints` on the item** in `items.json` (legacy per-item overrides).
3. Else **auto-generated** six-step ladder from item metadata (quality, type, pools, DLC, first description sentence, pickup quote from `quotes.json`).

## Endless mode

**`?endless=1`** (or the ∞ footer link) plays round N of a fixed pseudo-random permutation of all items — same sequence for every player, no repeats within a full cycle. Hints come from **`public/data/ladders.json`**, a pre-generated 6-hint ladder per item; anything missing falls back to the auto-generated metadata ladder. Endless rounds never touch daily progress, stats, or streaks (nothing is persisted; "NEXT ITEM →" reloads with the next round).

**Generating ladders:** **`npm run build:ladders`** fills every gap in `ladders.json` using the `claude` CLI (headless), few-shot prompted with the hand-authored hints pulled live from the worker so the style matches: one narrowing fact per hint — oblique effect property → name/trivia association → unlock method (from the wiki's Cargo achievement table, via `scripts/wiki-extra.json`) → identifying effect → sprite giveaway. Hint 1 is templated from item metadata (always accurate); hints 2–6 are generated, then validated (6 hints, length caps, no item-name leakage) with a retry pass. The script is incremental — re-run it after adding items (`refresh:wiki` first, it writes `wiki-extra.json`) and it only generates what's missing. Requires `WORKER_URL`/`ADMIN_TOKEN` in `.env.local` and a logged-in `claude` CLI.

## Run locally

```sh
npm install
npm run build:items  # one-time: items.json + quotes.json (see below)
npm run dev          # http://localhost:5173/
npm run admin        # optional: edit the backend schedule (item + hints)
```

You can also deploy a static build elsewhere (e.g. GitHub Pages at `https://<user>.github.io/something-of-isaac/`); set **`VITE_BASE`** if the base path differs. The share-to-clipboard line ends with the public URL **`https://avelouk.com/something-of-isaac/`** (see `SHARE_SITE_URL` in `src/share.ts`).

## Daily stats (optional)

The game can show **how many distinct browsers played today** (UTC) using a **Cloudflare Worker** next to GitHub Pages: one anonymous UUID in `localStorage`, `POST` once per page load, footer line updates when **`VITE_STATS_WORKER_URL`** is set at build time.

We use a **SQLite-backed Durable Object** (required on **Workers Free**; same `ctx.storage` API you already use) so the counter stays consistent under concurrency; details and deploy steps are in **`worker/README.md`**.

- Deploy the worker: **`npm run deploy:stats`** (after **`npx wrangler login`** once).
- Local worker: **`npm run dev:stats`**, then run Vite with `VITE_STATS_WORKER_URL=http://127.0.0.1:8787`.
- **GitHub Actions:** add repository **Variable** **`VITE_STATS_WORKER_URL`** (same URL as the deployed worker) so production builds include it.

The worker exposes **`POST /visit`** to browsers (returns today’s unique player count). For **daily totals by UTC date** since you started logging, use **`GET /stats/history`** with the same **`ADMIN_TOKEN`** as schedule writes — see **`worker/README.md`**.

### Schedule store (one-time worker setup)

The same worker holds the daily schedule (item id + hints per UTC date) in the **`SCHEDULE_KV`** namespace. Per-day reads (`/schedule/day`, `/schedule/today`) are public and edge-cached for 60s and strip the hash; the full dump (`GET /schedule`) and all writes (`POST /schedule/entry`, `PUT /schedule`) are bearer-token gated.

1. Create the KV namespace and paste its id into `worker/wrangler.toml`:
   ```sh
   npx wrangler kv namespace create SCHEDULE_KV --config worker/wrangler.toml
   ```
2. Generate a random admin token and store it as a worker secret:
   ```sh
   openssl rand -hex 32                                         # copy the output
   npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml   # paste it
   ```
3. Deploy the worker: **`npm run deploy:stats`**.
4. Create **`.env.local`** in the repo root (already gitignored) for the admin server and `push:schedule`:
   ```sh
   WORKER_URL=https://something-of-isaac-stats.<your-subdomain>.workers.dev
   ADMIN_TOKEN=<same token you put as the worker secret>
   ```
5. Seed the store from the generated file: **`npm run build:schedule`** then **`npm run push:schedule`**.

After this, **`npm run admin`** reads from and writes straight to the worker. The repo is safe to keep public: a fork that runs the admin gets a 401 from the worker because they don't have the token.

### Feedback → Telegram (one-time setup)

The footer's **REPORT A PROBLEM** link opens a one-textarea modal that `POST`s to the worker's **`/feedback`**, which forwards the message to a Telegram chat (with puzzle number and country). Nothing is stored — Telegram is the inbox. Length-capped at 1000 chars plus a soft cap of 50 reports per UTC day (KV counter) so the endpoint can't be used to flood your phone. If the secrets are unset the endpoint returns 503 and the modal shows "FAILED".

1. Create a bot: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Send your new bot any message (this opens the chat), then get your chat id from
   `https://api.telegram.org/bot<token>/getUpdates` (look for `"chat":{"id":...}`).
3. Store both as worker secrets and redeploy:
   ```sh
   npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/wrangler.toml
   npx wrangler secret put TELEGRAM_CHAT_ID --config worker/wrangler.toml
   npm run deploy:stats
   ```

## How `items.json` is built

Item metadata is **not** hand-written. It is generated by `scripts/build-items.ts`:

1. **Platinum God** — The script fetches the [Repentance cheat sheet](https://platinumgod.co.uk/repentance) (HTML) and parses each collectible `<li class="textbox">`: item ID, name, quality, type, item pools, pickup line, description, DLC hints from CSS classes, etc. Trinkets are skipped.

2. **Isaaconnect** — IDs and sprite URLs are aligned to a local [Isaaconnect](https://github.com/AlexisL61/Isaaconnect) `items.json` snapshot (see `ISAACONNECT_ITEMS` in `build-items.ts`). Only items that appear in that list are kept so IDs and art stay consistent.

3. **wiki.gg refresh** — **`npm run refresh:wiki`** patches the volatile fields from the [Binding of Isaac wiki](https://bindingofisaacrebirth.wiki.gg) (actively maintained, unlike Platinum God which drifts): quality, description, DLC tag, pickup quote, and active-item recharge (appended to the description). Items are joined by in-game id via the wiki infoboxes, so page titles never need to match. Run it after `build:items`, and re-run `build:ladders` afterwards since the hints are generated from these descriptions.

3. **Output** — The script writes:
   - `public/data/items.json` — one entry per item (pickup quote stripped out for size).
   - `public/data/quotes.json` — map of item id → pickup quote (used for search + hints).

After a game update, re-run **`npm run build:items`**, then refresh sprites if IDs changed:

```sh
npm run selfhost:sprites   # download missing sprites from current `img` URLs, then set img → data/sprites/{id}.webp
```

Or step by step: **`npm run download:sprites`**, then **`npm run localize:sprites`**. Commit `items.json`, `quotes.json`, and `public/data/sprites/`.

## Credits

This is a fan project. Not affiliated with Edmund McMillen, Nicalis, or the official Binding of Isaac team.

- Item data derived primarily from [Platinum God](https://platinumgod.co.uk/repentance), merged with [Isaaconnect](https://github.com/AlexisL61/Isaaconnect) for IDs and initial sprite URLs. Sprites are **self-hosted** under `public/data/sprites/` after `download:sprites` + `localize:sprites` (see above).
- Reddit inspiration: [Try to guess the item with the least amount of…](https://www.reddit.com/r/bindingofisaac/comments/1t12aqm/try_to_guess_the_item_with_the_least_amount_of/).
- Seeded-RNG and share-string patterns ported from [Isaaconnect](https://github.com/AlexisL61/Isaaconnect) (GPLv3).

## License

GPLv3 — inherited from Isaaconnect (whose seed helpers this project reuses).
