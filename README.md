# Something of Isaac

A daily Wordle-like puzzle for *The Binding of Isaac*: guess today's collectible with as few hints as possible.

**Play:** [somethingofisaac.com](https://somethingofisaac.com/)

Inspired by [this r/bindingofisaac thread](https://www.reddit.com/r/bindingofisaac/comments/1t12aqm/try_to_guess_the_item_with_the_least_amount_of/).

## How to play

One hint is shown. Type a guess — name, pickup quote, effect, pool or description all match. Wrong guess → next hint. Six hints, then an optional four-tile final round. Fewer hints = better score. New puzzle at 00:00 UTC.

**Endless mode** (`?endless=1`, or the ∞ footer link): round N of a fixed permutation of all items, same for everyone. Separate stats, never touches the daily streak. No mid-round save — a reload restarts the round.

## How it works

- **Static site** (Vite + TypeScript). Pushing `main` deploys to GitHub Pages at somethingofisaac.com (see [Deploy](#deploy)).
- **Cloudflare Worker** (`worker/`, free tier): the daily schedule (KV), player counts and player state (Durable Objects), and a feedback form that forwards to Telegram. See `worker/README.md`.
- **Runs unattended.** The schedule is generated ~719 days ahead with no repeats, and every one of the 718 items has a pre-generated hint ladder. Nothing needs touching day to day.

### Which hints the game shows

`hintsForPuzzle` in `src/hints.ts`, first match wins:

1. `hints` on the day's schedule row in the worker — what you write with `npm run admin`.
2. `customHints` on the item in `items.json` (legacy, one item).
3. The item's ladder in `public/data/ladders.json` — generated, covers all items. **This is what plays on any day you didn't author.** Endless mode always uses it.
4. Auto hints from item metadata — unreachable in practice.

## Day-to-day

```sh
npm install
npm run dev      # http://localhost:5173/
npm run admin    # local UI: set the answer item / write hints for today or a future UTC day
```

**Authoring hints** with `npm run admin` saves straight to the worker; the live site picks it up within ~60s, no deploy. Past UTC days are read-only.

**Fixing a bad generated ladder:** either author that day's hints in the admin (overrides the ladder), or delete the item's entry from `ladders.json`, run `npm run build:ladders`, and deploy.

### Deploy

| Target | How |
|---|---|
| **Production** — `somethingofisaac.com` | push to `main` (GitHub Pages, custom domain from `public/CNAME`) |
| Worker | `npm run deploy:stats` |

The old URL, `avelouk.com/something-of-isaac/`, is a static bridge page in the Quartz repo (`content/something-of-isaac/index.html`): it syncs the player's state, then `location.replace()`s to the new domain with `#soi=<visitor id>` so streaks survive the move. It is kept permanently — a 301 can't run JS, so it could never hand the id over. Set the `VITE_STATS_WORKER_URL` repo Variable so builds know the worker URL.

## Data pipeline

All generated; nothing in `public/data/` is hand-written. Run in this order after a game update or a hint-quality change. Each script is incremental and safe to re-run.

| Step | Command | Writes | Notes |
|---|---|---|---|
| 1 | `npm run build:items` | `items.json`, `quotes.json` | Scrapes [Platinum God](https://platinumgod.co.uk/repentance), aligns IDs/sprites to an [Isaaconnect](https://github.com/AlexisL61/Isaaconnect) snapshot. |
| 2 | `npm run refresh:wiki` | patches `items.json`; `scripts/wiki-extra.json` | Corrects quality/description/DLC/quote from [wiki.gg](https://bindingofisaacrebirth.wiki.gg) (Platinum God drifts), and collects unlock/effects/notes/trivia for the ladder generator. |
| 3 | `npm run selfhost:sprites` | `public/data/sprites/*.webp` | Only if IDs changed. |
| 4 | `npm run describe:sprites` | `scripts/sprite-descriptions.json` | Claude describes each sprite *without* being told the name (needs `ffmpeg`). ~20 items whose name *is* the drawing (Scissors, Stapler…) are rejected on purpose. |
| 5 | `npm run build:ladders` | `public/data/ladders.json` | Claude writes hints 2–6 per item from the wiki facts + sprite description, few-shot on your hand-written ladders pulled from the worker. Hint 1 is templated. Validated for length and name leakage (the item's distinctive name words are banned, substring-matched — function words like "and"/"for" are exempt). |
| 6 | `npm run build:schedule` | `public/data/schedule.json` | Every item once per cycle, none within 100 days. Past days and authored hints preserved. |
| 7 | `npm run push:schedule` | worker KV | Seeds/replaces the live schedule. |

Steps 4–5 need a logged-in `claude` CLI and ride out usage-limit windows with backoff (up to ~7h); if one gives up, re-run it. `build:ladders` also needs `WORKER_URL` and `ADMIN_TOKEN` in `.env.local`. Both scripts end with `Done: N/718` — re-run until N is 718 (ladders) or ~700 (sprites; the rest are the intentional rejects).

## Player state sync

Streaks and endless position sync to the worker (`POST /player/sync`), keyed by the same anonymous UUID as the visit counter. Silent and best-effort; the game runs on `localStorage` alone if the worker is unreachable. The merge (`src/playerState.ts`, shared with the worker) is additive and never replaces, so a `SCHEMA_VERSION` wipe is a round trip, not data loss.

The UUID itself lives in `localStorage`, so server state is only recoverable while the id survives:

| Scenario | Recovers? |
|---|---|
| `SCHEMA_VERSION` bump | yes — `ensureSchema()` spares `soi-visitor-id` |
| Domain move via `#soi=<uuid>` fragment handoff (`adoptVisitorIdFromUrl`) | yes |
| "Clear cookies and site data", new device, Safari ITP after 7 idle days | no |

Cross-device recovery would need a user-visible recovery code; left out deliberately since the UUID is effectively a password.

## One-time setup

**Worker.** `npx wrangler login`, then:

```sh
npx wrangler kv namespace create SCHEDULE_KV --config worker/wrangler.toml   # paste id into wrangler.toml
openssl rand -hex 32                                                  # keep this
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml     # paste it
npm run deploy:stats
```

Then create `.env.local` (gitignored) for the admin server and scripts:

```
WORKER_URL=https://something-of-isaac-stats.<you>.workers.dev
ADMIN_TOKEN=<same token>
```

Seed the schedule: `npm run build:schedule && npm run push:schedule`. The repo is safe to keep public — without the token the worker returns 401.

**Feedback → Telegram.** The footer's REPORT A PROBLEM form posts to `/feedback`, which forwards to a Telegram chat (nothing stored; 1000 chars, 50/day cap). Create a bot via [@BotFather](https://t.me/BotFather), message it once, read your chat id from `https://api.telegram.org/bot<token>/getUpdates`, then:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/wrangler.toml
npx wrangler secret put TELEGRAM_CHAT_ID --config worker/wrangler.toml
npm run deploy:stats
```

**GitHub Actions.** Variable `VITE_STATS_WORKER_URL`; for production sync, variable `SYNC_TARGET_REPO` (optionally `SYNC_TARGET_BRANCH`, `SYNC_TARGET_DIR`, default `content/something-of-isaac`) and secret `SYNC_GITHUB_TOKEN`.

## Credits & license

Fan project, not affiliated with Edmund McMillen, Nicalis or the official team. Item data from [Platinum God](https://platinumgod.co.uk/repentance) and [wiki.gg](https://bindingofisaacrebirth.wiki.gg); IDs and initial sprite URLs from [Isaaconnect](https://github.com/AlexisL61/Isaaconnect), whose seeded-RNG and share-string helpers are reused. **GPLv3**, inherited from Isaaconnect.
