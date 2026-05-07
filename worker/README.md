# Daily stats worker

This folder is a **Cloudflare Worker** with a **Durable Object** that stores one bucket per UTC day: unique visitor count (by anonymous UUID) and optional aggregate counts by country (Cloudflare geo on first visit only).

## Why not KV?

Workers KV does not give you atomic counters or a reliable way to count “unique keys” for thousands of visitors. A Durable Object runs all writes for a given day in one place, so the number stays consistent.

## One-time setup

1. Create a Cloudflare account (free tier is enough for modest traffic).
2. In the dashboard, open **Workers & Pages** once. That provisions your **`workers.dev` subdomain** (required to deploy). If `wrangler deploy` fails with **code 10063**, you skipped this step.
3. Install CLI (from repo root): `npm install`
4. Log in: `npx wrangler login`
5. Deploy: `npm run deploy:stats`

First deploy applies the `[[migrations]]` entry in `wrangler.toml` (SQLite-backed Durable Object — required on **Workers Free**).

If you ever deployed this worker with the older `new_classes` migration successfully on a paid plan, talk to Cloudflare docs before switching; Free tier cannot use that backend.

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

## Endpoint

| Method | Path    | Purpose |
|--------|---------|---------|
| POST   | `/visit` | Body: `{ "visitorId": "<uuid>" }`. Counts at most once per visitor per UTC day. Returns `{ unique, newVisitor }`. |

On each **new** visitor that UTC day, the Worker increments per-country buckets using Cloudflare geo (stored only inside the Durable Object — nothing reads them yet).

There is no authentication; the counter is public by design. Abuse could inflate counts; for a small puzzle game this is usually acceptable.
