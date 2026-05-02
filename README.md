# Something of Isaac

A daily Wordle-like puzzle for *The Binding of Isaac*. Guess today's collectible with as few hints as possible.

## How to play

You see one hint about today's item. Type a guess — name, pickup quote, effect, item pool, or a snippet of the description all match. If wrong, the next hint is revealed automatically. Seven hints, then the day is over. Lower score (fewer hints used) is better. New puzzle every day at 00:00 UTC.

## Run locally

```sh
npm install
npm run build:data   # one-time: build items.json + quotes.json + schedule.json
npm run dev          # http://localhost:5173/
```

Deployed at `https://<user>.github.io/something-of-isaac/`. Production build path is `/something-of-isaac/`; override via `VITE_BASE` if you rename the repo or set up a custom domain.

## Credits

This is a fan project. Not affiliated with Edmund McMillen, Nicalis, or the official Binding of Isaac team.

- Item data derived primarily from [Platinum God](https://platinumgod.co.uk/repentance) — a one-time scrape merged with [Isaaconnect](https://github.com/AlexisL61/Isaaconnect)'s ID list.
- Sprites currently hot-linked from [isaacguru.com](https://isaacguru.com); run `npm run download:sprites` to bundle locally.
- Inspired by the r/bindingofisaac post _"Try to guess the Item with the least amount of Tips!"_ by u/LeonGamerRoll.
- Seeded-RNG and share-string patterns ported from [Isaaconnect](https://github.com/AlexisL61/Isaaconnect) (GPLv3).

## License

GPLv3 — inherited from Isaaconnect (whose seed helpers this project reuses).
