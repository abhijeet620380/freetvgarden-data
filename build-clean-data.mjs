// Clean channel data builder for freetvgarden.com
// Fetches iptv-org's public channel/stream/logo/feed data, health-checks
// every stream URL, removes anything that doesn't respond, dedupes ALL
// mirrors and feed variants down to exactly ONE row per channel (with a
// final defensive pass to guarantee it, even if the upstream dataset has
// duplicate channel IDs), and writes the result as M3U files in the exact
// format/paths the site already parses:
//   iptv/countries/{cc}.m3u
//   iptv/categories/{cat}.m3u
//   iptv/index.m3u
// Run on a schedule via the GitHub Actions workflow in this repo.

import fs from "fs/promises";
import path from "path";

const API = "https://iptv-org.github.io/api";
const OUT_DIR = "iptv";
const CHECK_TIMEOUT_MS = 6000;
const CONCURRENCY = 40;

// ---------------------------------------------------------------------
// Curated official YouTube Live channels (verified manually — do not add
// unverified IDs here). To add more: open
// https://www.youtube.com/channel/{ID}/live in a browser and confirm it's
// really the official channel's live stream before adding it below.
// ---------------------------------------------------------------------
const YOUTUBE_LIVE = [
  { name: "Al Jazeera English", country: "QA", category: "News", channelId: "UCNye-wNBqNL5ZzHSJj3l8Bg" },
  { name: "Sky News Australia", country: "AU", category: "News", channelId: "UCO0akufu9MOzyz3nvGIXAAw" }
];

function ytEmbedUrl(channelId) {
  return `https://www.youtube.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1`;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return r.json();
}

async function checkStream(url, referrer, userAgent) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const headers = {};
  if (referrer) headers["Referer"] = referrer;
  if (userAgent) headers["User-Agent"] = userAgent;
  try {
    let res;
    try {
      res = await fetch(url, { method: "HEAD", headers, signal: controller.signal, redirect: "follow" });
    } catch {
      res = null;
    }
    if (!res || res.status >= 400) {
      res = await fetch(url, {
        method: "GET",
        headers: { ...headers, Range: "bytes=0-2048" },
        signal: controller.signal,
        redirect: "follow"
      });
    }
    return res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function esc(s) {
  return String(s || "").replace(/"/g, "'").replace(/\r?\n/g, " ");
}

function buildExtinf(ch) {
  return `#EXTINF:-1 tvg-id="${esc(ch.id)}" tvg-country="${esc(ch.country)}" tvg-language="${esc(ch.language)}" tvg-logo="${esc(ch.logo)}" group-title="${esc(ch.group)}",${esc(ch.name)}`;
}

function toM3U(list) {
  return ["#EXTM3U", ...list.flatMap(ch => [buildExtinf(ch), ch.url])].join("\n") + "\n";
}

async function main() {
  console.log("Fetching iptv-org data...");
  const [channels, streams, categoriesData, logos, feeds, languagesData] = await Promise.all([
    fetchJSON(`${API}/channels.json`),
    fetchJSON(`${API}/streams.json`),
    fetchJSON(`${API}/categories.json`),
    fetchJSON(`${API}/logos.json`),
    fetchJSON(`${API}/feeds.json`),
    fetchJSON(`${API}/languages.json`)
  ]);

  const channelById = new Map(channels.map(c => [c.id, c]));
  const categoryNameById = new Map(categoriesData.map(c => [c.id, c.name]));
  const languageNameByCode = new Map(languagesData.map(l => [l.code, l.name]));

  const logoByChannel = new Map();
  const logoByChannelInUse = new Map();
  for (const l of logos) {
    if (!l.channel || !l.url) continue;
    if (!logoByChannel.has(l.channel)) logoByChannel.set(l.channel, l.url);
    if (l.in_use) logoByChannelInUse.set(l.channel, l.url);
  }
  function getLogo(channelId) {
    return logoByChannelInUse.get(channelId) || logoByChannel.get(channelId) || "";
  }

  // Language moved to feeds.json (channels.json no longer has a
  // "languages" field — confirmed via iptv-org/api's own CHANGELOG).
  // Prefer the main feed's language; fall back to any feed for that
  // channel if no feed is marked is_main.
  const langByChannel = new Map();
  const langByChannelMain = new Map();
  for (const f of feeds) {
    if (!f.channel || !f.languages || !f.languages.length) continue;
    const code = f.languages[0];
    if (!langByChannel.has(f.channel)) langByChannel.set(f.channel, code);
    if (f.is_main) langByChannelMain.set(f.channel, code);
  }
  function getLanguage(channelId) {
    const code = langByChannelMain.get(channelId) || langByChannel.get(channelId);
    return code ? languageNameByCode.get(code) || "" : "";
  }

  // Dedupe fully by CHANNEL ONLY — one row per channel, period. All
  // mirror/feed variants for a channel become fallback candidates
  // internally; only the first one that actually passes the health
  // check gets published.
  const groups = new Map(); // key: channel id -> array of stream entries
  for (const s of streams) {
    if (!s.channel || !s.url) continue;
    const ch = channelById.get(s.channel);
    if (!ch || ch.closed) continue;
    if (s.label === "Geo-blocked") continue;
    if (!groups.has(s.channel)) groups.set(s.channel, []);
    groups.get(s.channel).push(s);
  }

  const groupEntries = [...groups.entries()];
  console.log(`Checking ${groupEntries.length} channels (concurrency ${CONCURRENCY})...`);
  let checkedCount = 0;

  const resolved = await mapWithConcurrency(groupEntries, CONCURRENCY, async ([channelId, candidateStreams]) => {
    checkedCount++;
    if (checkedCount % 300 === 0) console.log(`  checked ${checkedCount}/${groupEntries.length} channels`);
    for (const s of candidateStreams) {
      const ok = await checkStream(s.url, s.referrer, s.user_agent);
      if (ok) {
        const ch = channelById.get(channelId);
        return {
          id: ch.id,
          name: ch.name,
          country: ch.country || "",
          language: getLanguage(ch.id),
          logo: getLogo(ch.id),
          group: (ch.categories && ch.categories[0] && categoryNameById.get(ch.categories[0])) || "General",
          categories: ch.categories || [],
          url: s.url
        };
      }
    }
    return null;
  });

  let alive = resolved.filter(Boolean);

  // Defensive final dedup by id. The grouping above already guarantees
  // uniqueness by construction, but if the upstream dataset ever contains
  // duplicate channel records sharing the same id, this closes that off
  // completely rather than relying on the grouping step alone.
  const seenIds = new Set();
  alive = alive.filter(ch => {
    if (seenIds.has(ch.id)) return false;
    seenIds.add(ch.id);
    return true;
  });

  console.log(`${alive.length}/${groupEntries.length} channels had at least one working stream.`);

  for (const yt of YOUTUBE_LIVE) {
    alive.push({
      id: `yt-${yt.channelId}`,
      name: yt.name,
      country: yt.country,
      language: "",
      logo: "",
      group: yt.category,
      categories: [],
      url: ytEmbedUrl(yt.channelId)
    });
  }

  const byCountry = {};
  for (const ch of alive) {
    const cc = (ch.country || "un").toLowerCase();
    (byCountry[cc] = byCountry[cc] || []).push(ch);
  }
  await fs.mkdir(path.join(OUT_DIR, "countries"), { recursive: true });
  for (const [cc, list] of Object.entries(byCountry)) {
    await fs.writeFile(path.join(OUT_DIR, "countries", `${cc}.m3u`), toM3U(list));
  }

  const byCategory = {};
  for (const ch of alive) {
    const cats = ch.categories.length ? ch.categories.map(id => categoryNameById.get(id) || id) : [ch.group];
    for (const catName of cats) {
      const key = String(catName).toLowerCase().replace(/\s+/g, "-");
      (byCategory[key] = byCategory[key] || []).push(ch);
    }
  }
  await fs.mkdir(path.join(OUT_DIR, "categories"), { recursive: true });
  for (const [cat, list] of Object.entries(byCategory)) {
    await fs.writeFile(path.join(OUT_DIR, "categories", `${cat}.m3u`), toM3U(list));
  }

  await fs.writeFile(path.join(OUT_DIR, "index.m3u"), toM3U(alive));

  await fs.writeFile(
    path.join(OUT_DIR, "status.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        channelsChecked: groupEntries.length,
        aliveChannels: alive.length - YOUTUBE_LIVE.length,
        youtubeChannelsAdded: YOUTUBE_LIVE.length,
        totalPublished: alive.length,
        channelsWithLogo: alive.filter(c => c.logo).length,
        channelsWithLanguage: alive.filter(c => c.language).length,
        channelsWithoutCountry: alive.filter(c => !c.country).length
      },
      null,
      2
    )
  );

  console.log("Done.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
