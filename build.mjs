import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Parser from "rss-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const OUT_DIR = join(ROOT, "public");
const CACHE_DIR = join(ROOT, ".cache");
const TRANSLATION_CACHE_PATH = join(CACHE_DIR, "translations.json");
const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 15000;
const TRANSLATE_TIMEOUT_MS = 10000;
const MAX_AGE_DAYS = 10;
const MAX_ITEMS_PER_SOURCE = 25;
const FETCH_CONCURRENCY = 8;
const SOURCE_FETCH_ATTEMPTS = 2;
const TRANSLATE_CONCURRENCY = 5;
const MAX_TRANSLATIONS_PER_BUILD = Number(process.env.MAX_TRANSLATIONS_PER_BUILD || 800);
const TRANSLATION_ENABLED = process.env.TRANSLATION_ENABLED !== "0";
const MIN_SOURCE_SUCCESS_RATE = Number(process.env.MIN_SOURCE_SUCCESS_RATE || 0.65);
const MIN_TOTAL_ITEMS = Number(process.env.MIN_TOTAL_ITEMS || 100);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const CURL_UA = "Mozilla/5.0";


async function fetchResponse(url, { timeout = FETCH_TIMEOUT_MS, accept = "*/*" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function curlFetchText(url, { timeout = FETCH_TIMEOUT_MS, accept = "*/*" } = {}) {
  const { stdout } = await execFileAsync(
    "curl",
    [
      "--fail",
      "--location",
      "--compressed",
      "--silent",
      "--show-error",
      "--max-time",
      String(Math.max(1, Math.ceil(timeout / 1000))),
      "--user-agent",
      CURL_UA,
      "--header",
      `Accept: ${accept}`,
      url,
    ],
    { encoding: "utf8", maxBuffer: 12 * 1024 * 1024 },
  );
  return stdout;
}

async function fetchText(url, options = {}) {
  let nativeError;
  try {
    const res = await fetchResponse(url, options);
    const text = await res.text();
    const expectsXml = String(options.accept || "").includes("xml");
    const looksLikeHtmlChallenge = expectsXml && /^\s*(?:<!doctype html|<html\b)/iu.test(text);
    if (!looksLikeHtmlChallenge) return text;
    nativeError = new Error("received an HTML challenge instead of a feed");
  } catch (error) {
    nativeError = error;
  }

  try {
    // curl honors the HTTP(S)_PROXY variables installed by `proxy_on` and also
    // provides a different HTTP/TLS client fingerprint for challenge-prone feeds.
    return await curlFetchText(url, options);
  } catch (curlError) {
    throw new Error(`${nativeError?.message || "fetch failed"}; curl fallback: ${curlError.message}`);
  }
}

function normTitle(value) {
  return (value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/u.test(value || "");
}

function htmlDecode(value) {
  return (value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return htmlDecode((value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function toDate(item) {
  const value = item.isoDate || item.pubDate || item.date || null;
  if (!value) return null;
  const normalized = String(value).trim();
  const shortYear = normalized.match(/^(\d{2})-(\d{2})-(\d{2})[ T]+(\d{1,2}):(\d{2})/u);
  if (shortYear) {
    const [, yy, month, day, hour, minute] = shortYear;
    return Date.UTC(2000 + Number(yy), Number(month) - 1, Number(day), Number(hour), Number(minute));
  }
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function keywordMatchesText(text, keyword) {
  const normalizedText = String(text || "").toLowerCase();
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();
  if (!normalizedKeyword) return false;

  // CJK terms and multi-word phrases are safe to match as literal substrings. Short
  // Latin tokens such as "ai" need ASCII boundaries so they do not match words
  // such as "said", "entertainment", or "email".
  if (/[^\x00-\x7f]/u.test(normalizedKeyword) || /\s/u.test(normalizedKeyword)) {
    return normalizedText.includes(normalizedKeyword);
  }

  const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalizedText);
}

function itemMatchesSourceFilter(item, src) {
  if (!Array.isArray(src.includeKeywords) || src.includeKeywords.length === 0) return true;
  const fields = Array.isArray(src.filterFields) && src.filterFields.length
    ? src.filterFields
    : ["title", "summary"];
  const haystack = fields.map((field) => item[field] || "").join(" ");
  return src.includeKeywords.some((keyword) => keywordMatchesText(haystack, keyword));
}

function toNewsItem(raw, src, tierWeight) {
  return {
    title: (raw.title || "").trim(),
    link: (raw.link || "").trim(),
    date: toDate(raw),
    summary: (raw.contentSnippet || raw.summary || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260),
    sourceId: src.id,
    sourceName: src.name,
    sourceNameEn: src.nameEn,
    category: src.category,
    tier: src.tier,
    region: src.region,
    lang: src.lang || "en",
    section: src.section || "world",
    _tierWeight: tierWeight,
  };
}

function parseCdcMedia(body, src, tierWeight) {
  const payload = JSON.parse(body);
  if (!Array.isArray(payload?.results)) throw new Error("Invalid CDC media API response");

  return payload.results
    .filter((entry) => entry?.name && (entry.targetUrl || entry.sourceUrl))
    .slice(0, MAX_ITEMS_PER_SOURCE)
    .map((entry) =>
      toNewsItem(
        {
          title: entry.name,
          link: entry.targetUrl || entry.sourceUrl,
          date: entry.datePublished || entry.dateContentUpdated || entry.dateModified,
          summary: entry.description || entry.subTitle || "",
        },
        src,
        tierWeight,
      ),
    );
}

function parseAnthropicNews(html, src, tierWeight) {
  const items = [];
  const seen = new Set();
  const anchorRe = /<a\s+[^>]*href="(\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const path = match[1];
    if (seen.has(path)) continue;
    const block = match[2];
    const time = block.match(/<time[^>]*>([\s\S]*?)<\/time>/i)?.[1] || null;
    const heading =
      block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ||
      block.match(/<span[^>]*class="[^"]*(?:title|headline)[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const summary = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    const title = stripTags(heading);
    if (!title) continue;
    seen.add(path);
    items.push(
      toNewsItem(
        {
          title,
          link: new URL(path, src.home).href,
          date: time ? stripTags(time) : null,
          summary: stripTags(summary),
        },
        src,
        tierWeight,
      ),
    );
    if (items.length >= MAX_ITEMS_PER_SOURCE) break;
  }
  return items;
}

async function processSource(src, tiers) {
  const result = { id: src.id, ok: false, count: 0, error: null, items: [] };

  for (let attempt = 1; attempt <= SOURCE_FETCH_ATTEMPTS; attempt++) {
    try {
      const body = await fetchText(src.url, {
        timeout: src.timeoutMs || FETCH_TIMEOUT_MS,
        accept:
          src.type === "html"
            ? "text/html,application/xhtml+xml"
            : src.type === "json"
              ? "application/json,*/*"
              : "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*",
      });
      const tierWeight = tiers[String(src.tier)]?.weight ?? 50;
      let items;

      if (src.parser === "anthropic-news") {
        items = parseAnthropicNews(body, src, tierWeight);
      } else if (src.parser === "cdc-media") {
        items = parseCdcMedia(body, src, tierWeight);
      } else {
        // rss-parser keeps mutable XML parser state. A parser per feed avoids
        // cross-feed corruption while sources are processed concurrently.
        const feedParser = new Parser({ timeout: src.timeoutMs || FETCH_TIMEOUT_MS });
        const feed = await feedParser.parseString(body);
        items = (feed.items || [])
          .slice(0, MAX_ITEMS_PER_SOURCE)
          .map((item) => toNewsItem(item, src, tierWeight));
      }

      items = items
        .filter((item) => item.title && item.link)
        .filter((item) => itemMatchesSourceFilter(item, src));

      if (items.length === 0 && src.type === "html") throw new Error("No usable items");
      result.ok = true;
      result.count = items.length;
      result.error = null;
      result.items = items;
      return result;
    } catch (error) {
      result.error = error?.name === "AbortError" ? "request timeout" : error?.message || String(error);
      if (attempt < SOURCE_FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }

  return result;
}

async function runPool(tasks, worker, concurrency) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, tasks.length || 1) }, async () => {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await worker(tasks[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

function score(item, now) {
  const base = item._tierWeight;
  if (!item.date) return base;
  const ageHours = Math.max(0, (now - item.date) / 36e5);
  const recency = Math.max(0, 40 * (1 - ageHours / (7 * 24)));
  return base + recency;
}

async function loadTranslationCache() {
  try {
    const data = JSON.parse(await readFile(TRANSLATION_CACHE_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function translateToChinese(text) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: "zh-CN",
    dt: "t",
    q: text.slice(0, 600),
  });
  const response = await fetchResponse(
    `https://translate.googleapis.com/translate_a/single?${params}`,
    { timeout: TRANSLATE_TIMEOUT_MS, accept: "application/json,text/plain,*/*" },
  );
  const payload = await response.json();
  const translated = Array.isArray(payload?.[0])
    ? payload[0].map((part) => part?.[0] || "").join("").trim()
    : "";
  if (!translated || normTitle(translated) === normTitle(text)) {
    throw new Error("empty translation");
  }
  return translated;
}

async function addChineseTranslations(itemsBySection) {
  const stats = { enabled: TRANSLATION_ENABLED, candidates: 0, cached: 0, translated: 0, failed: 0 };
  if (!TRANSLATION_ENABLED) return stats;

  const cache = await loadTranslationCache();
  const candidates = Object.values(itemsBySection)
    .flat()
    .filter((item) => item.lang !== "zh" && !containsChinese(item.title))
    .slice(0, MAX_TRANSLATIONS_PER_BUILD);
  stats.candidates = candidates.length;

  const pending = [];
  for (const item of candidates) {
    const cached = cache[item.title];
    if (cached?.zh) {
      item.titleZh = cached.zh;
      stats.cached++;
    } else {
      pending.push(item);
    }
  }

  await runPool(
    pending,
    async (item) => {
      try {
        const zh = await translateToChinese(item.title);
        item.titleZh = zh;
        cache[item.title] = { zh, updatedAt: new Date().toISOString() };
        stats.translated++;
      } catch {
        stats.failed++;
      }
    },
    TRANSLATE_CONCURRENCY,
  );

  const compactCache = Object.fromEntries(
    Object.entries(cache)
      .sort((a, b) => String(b[1]?.updatedAt || "").localeCompare(String(a[1]?.updatedAt || "")))
      .slice(0, 6000),
  );
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(TRANSLATION_CACHE_PATH, JSON.stringify(compactCache), "utf8");
  return stats;
}

async function main() {
  const registry = JSON.parse(await readFile(join(ROOT, "sources.json"), "utf8"));
  const { sources, categories, sections, meta, navLinks } = registry;
  const tiers = meta.tiers;
  const now = Date.now();
  const cutoff = now - MAX_AGE_DAYS * 24 * 36e5;

  console.log(`Fetching ${sources.length} sources across ${Object.keys(sections).length} sections...`);
  const results = await runPool(sources, (source) => processSource(source, tiers), FETCH_CONCURRENCY);

  const ok = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  console.log(`OK: ${ok.length}  FAILED: ${failed.length}`);
  for (const result of failed) console.log(`  ✗ ${result.id}: ${result.error}`);

  const itemsBySection = Object.fromEntries(Object.keys(sections).map((section) => [section, []]));
  const seenGlobal = new Set();
  let totalItems = 0;

  for (const result of results) {
    const source = sources.find((candidate) => candidate.id === result.id);
    const section = source?.section || "world";

    for (const item of result.items) {
      if (!item.date && !source?.allowUndated) continue;
      if (item.date && item.date < cutoff) continue;
      const key = normTitle(item.title) || item.link;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);

      item.score = Math.round(score(item, now) * 10) / 10;
      delete item._tierWeight;
      if (itemsBySection[section]) itemsBySection[section].push(item);
      totalItems++;
    }
  }

  for (const items of Object.values(itemsBySection)) {
    items.sort((a, b) => b.score - a.score || (b.date || 0) - (a.date || 0));
  }

  console.log("Translating foreign headlines to concise Chinese...");
  const translation = await addChineseTranslations(itemsBySection);
  console.log(
    `Translations: candidates=${translation.candidates} cached=${translation.cached} new=${translation.translated} failed=${translation.failed}`,
  );

  const sourceStatus = results.map((result) => {
    const source = sources.find((candidate) => candidate.id === result.id);
    return {
      id: result.id,
      name: source.name,
      nameEn: source.nameEn,
      home: source.home,
      category: source.category,
      tier: source.tier,
      region: source.region,
      section: source.section,
      ok: result.ok,
      count: result.count,
      error: result.error,
    };
  });

  const perSec = Object.fromEntries(
    Object.entries(itemsBySection).map(([section, items]) => [section, items.length]),
  );
  const perCat = {};
  for (const item of Object.values(itemsBySection).flat()) {
    perCat[item.category] = (perCat[item.category] || 0) + 1;
  }

  const sourceSuccessRate = sources.length ? ok.length / sources.length : 0;
  const health = {
    ok: sourceSuccessRate >= MIN_SOURCE_SUCCESS_RATE && totalItems >= MIN_TOTAL_ITEMS,
    sourceSuccessRate: Math.round(sourceSuccessRate * 1000) / 1000,
    minimumSourceSuccessRate: MIN_SOURCE_SUCCESS_RATE,
    minimumTotalItems: MIN_TOTAL_ITEMS,
  };

  const data = {
    generatedAt: new Date(now).toISOString(),
    categories,
    sections,
    tiers,
    metaNote: meta.note,
    stats: {
      total: totalItems,
      sourcesOk: ok.length,
      sourcesFailed: failed.length,
      perSec,
      perCat,
      translated: translation.cached + translation.translated,
    },
    health,
    translation,
    sources: sourceStatus,
    itemsBySection,
    navLinks: navLinks || [],
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "data.json"), JSON.stringify(data), "utf8");
  console.log(
    `Wrote public/data.json items=${totalItems} sections=${Object.entries(perSec)
      .map(([section, count]) => `${section}:${count}`)
      .join(" ")} generatedAt=${data.generatedAt}`,
  );

  if (!health.ok) {
    console.error(
      `Build health gate failed: successRate=${health.sourceSuccessRate}, totalItems=${totalItems}`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
