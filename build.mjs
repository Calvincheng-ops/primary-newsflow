import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Parser from "rss-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const OUT_DIR = join(ROOT, "public");

const FETCH_TIMEOUT_MS = 15000;
const MAX_AGE_DAYS = 10;
const MAX_ITEMS_PER_SOURCE = 25;
const CONCURRENCY = 8;
const UA =
  "Mozilla/5.0 (compatible; PrimaryNewsflowBot/1.0; +https://github.com/) newsflow";

// Optional proxy for local runs behind GFW. Set HTTPS_PROXY / ALL_PROXY.
let dispatcher = null;
const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy;
if (proxyUrl) {
  try {
    const { ProxyAgent } = await import("undici");
    dispatcher = new ProxyAgent(proxyUrl);
    console.log(`[proxy] using ${proxyUrl}`);
  } catch {
    console.warn("[proxy] undici not available, proxy ignored");
  }
}

const parser = new Parser({ timeout: FETCH_TIMEOUT_MS });

async function fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function normTitle(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

function toDate(item) {
  const d = item.isoDate || item.pubDate || item.date || null;
  if (!d) return null;
  const ms = Date.parse(d);
  return Number.isNaN(ms) ? null : ms;
}

async function processSource(src, tiers) {
  const result = { id: src.id, ok: false, count: 0, error: null };
  try {
    const xml = await fetchText(src.url);
    const feed = await parser.parseString(xml);
    const tierWeight = tiers[String(src.tier)]?.weight ?? 50;
    const items = (feed.items || [])
      .slice(0, MAX_ITEMS_PER_SOURCE)
      .map((it) => {
        const ts = toDate(it);
        return {
          title: (it.title || "").trim(),
          link: (it.link || "").trim(),
          date: ts,
          summary: (it.contentSnippet || it.summary || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 220),
          sourceId: src.id,
          sourceName: src.name,
          sourceNameEn: src.nameEn,
          category: src.category,
          tier: src.tier,
          region: src.region,
          _tierWeight: tierWeight,
        };
      })
      .filter((it) => it.title && it.link);
    result.ok = true;
    result.count = items.length;
    result.items = items;
    return result;
  } catch (e) {
    result.error = e.message || String(e);
    result.items = [];
    return result;
  }
}

async function runPool(tasks, worker, concurrency) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await worker(tasks[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

function score(item, now) {
  const base = item._tierWeight;
  if (!item.date) return base; // undated: rank by authority only
  const ageH = (now - item.date) / 36e5;
  const recency = Math.max(0, 40 * (1 - ageH / (7 * 24)));
  return base + recency;
}

async function main() {
  const reg = JSON.parse(await readFile(join(ROOT, "sources.json"), "utf8"));
  const { sources, categories, meta } = reg;
  const tiers = meta.tiers;
  const now = Date.now();
  const cutoff = now - MAX_AGE_DAYS * 24 * 36e5;

  console.log(`Fetching ${sources.length} primary sources...`);
  const results = await runPool(sources, (s) => processSource(s, tiers), CONCURRENCY);

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(`OK: ${ok.length}  FAILED: ${failed.length}`);
  for (const f of failed) console.log(`  ✗ ${f.id}: ${f.error}`);

  // gather + dedupe
  const seen = new Set();
  let all = [];
  for (const r of results) {
    for (const it of r.items) {
      if (it.date && it.date < cutoff) continue;
      const key = normTitle(it.title) || it.link;
      if (seen.has(key)) continue;
      seen.add(key);
      it.score = Math.round(score(it, now) * 10) / 10;
      delete it._tierWeight;
      all.push(it);
    }
  }
  all.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.date || 0) - (a.date || 0);
  });

  const sourceStatus = results.map((r) => {
    const s = sources.find((x) => x.id === r.id);
    return { id: r.id, name: s.name, nameEn: s.nameEn, home: s.home, category: s.category, tier: s.tier, region: s.region, ok: r.ok, count: r.count };
  });

  const perCat = {};
  for (const it of all) perCat[it.category] = (perCat[it.category] || 0) + 1;

  const data = {
    generatedAt: new Date(now).toISOString(),
    categories,
    tiers,
    metaNote: meta.note,
    stats: { total: all.length, sourcesOk: ok.length, sourcesFailed: failed.length, perCat },
    sources: sourceStatus,
    items: all,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "data.json"), JSON.stringify(data), "utf8");
  console.log(`Wrote public/data.json  items=${all.length}  generatedAt=${data.generatedAt}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
