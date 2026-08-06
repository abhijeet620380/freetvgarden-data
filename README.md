# freetvgarden-data

The clean, health-checked channel dataset that powers freetvgarden.com —
built the same way Famelack's `famelack-data` repo works: a scheduled job
fetches raw data from iptv-org, checks every stream is actually alive,
removes anything that isn't, mixes in a small curated list of official
YouTube Live channels, and publishes the result here for the website to
read directly — instead of the site checking anything itself at request time.

## Setup (one-time)

1. Create a new **public** GitHub repo (name it whatever you like — this
   README assumes `freetvgarden-data`).
2. Copy everything in this folder into that repo (`scripts/`,
   `.github/workflows/`, this README).
3. Push to the `main` branch.
4. Go to the repo's **Actions** tab and manually run
   "Update Clean Channel Data" once (via "Run workflow") to generate the
   first `iptv/` folder — after that it runs automatically every 6 hours.
5. Once `iptv/index.m3u` exists in the repo, update the `CLEAN_CDN`
   constant in `worker.js` and `index.html` (see comments there) to point
   at your repo, e.g.:
   `https://cdn.jsdelivr.net/gh/YOUR_USERNAME/freetvgarden-data@main/iptv`

## What it does

- Fetches `channels.json` + `streams.json` + `categories.json` from
  iptv-org's public API
- Skips anything already labeled "Geo-blocked" by iptv-org
- Sends a lightweight HEAD (or ranged GET, if HEAD isn't supported) request
  to every remaining stream URL with a 6-second timeout, 40 at a time
- Drops anything that doesn't respond
- Adds a small curated list of official YouTube Live channels
  (`scripts/build-clean-data.mjs` — only manually-verified channel IDs)
- Writes the result as `iptv/countries/{cc}.m3u`, `iptv/categories/{cat}.m3u`,
  and `iptv/index.m3u` — same file layout and M3U format the site already
  parses, so no site-side parsing logic needs to change

## Safety net

The site tries this repo's data **first**, and automatically falls back to
fetching directly from iptv-org if this repo is ever unreachable or a
specific file is missing — so nothing on the live site can break because of
this pipeline, even if a workflow run fails.

## Adding more YouTube Live channels

Only add a channel ID after manually confirming it at
`https://www.youtube.com/channel/{ID}/live` in a browser — don't guess IDs
from search results, they're easy to get wrong.
