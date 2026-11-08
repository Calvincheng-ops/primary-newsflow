// Headline translation for the hourly refresh.
//
// GitHub-hosted runners often cannot complete the unofficial
// translate.googleapis.com?client=gtx and lingva.ml requests (fast 429/403).
// Those failures used to be swallowed, the build still exited 0, and the 90%
// coverage test then blocked every scheduled publish. This module tries a
// short provider chain, keeps titles already translated in a previous feed,
// and reports an explicit outage when every live provider is blocked.

// Public key shipped in Google's Translate Element loader. It is not a
// repository credential; override it with GOOGLE_TRANSLATE_WIDGET_KEY.
const DEFAULT_WIDGET_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
const WIDGET_ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
const GTX_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const CLOUD_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const LINGVA_ENDPOINT = "https://lingva.ml/api/v1/auto/zh";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export const TRANSLATION_COVERAGE_TARGET = 0.9;

export function normTitle(value) {
  return (value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

export function containsChinese(value) {
  return /[\u3400-\u9fff]/u.test(value || "");
}

export function htmlDecode(value) {
  return (value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function cleanTranslation(source, translated) {
  const value = htmlDecode(String(translated || "")).replace(/\s+/g, " ").trim();
  if (!value || !containsChinese(value)) return null;
  if (normTitle(value) === normTitle(source)) return null;
  return value;
}

function providerError(label, { outage = false, status = 0 } = {}) {
  const error = new Error(label);
  error.label = label;
  error.outage = outage;
  error.status = status;
  return error;
}

function isTransportOutage(status) {
  return status === 0 || status === 408 || status === 429 || status === 401 || status === 403 || status >= 500;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, options) {
  try {
    return await fn();
  } catch (error) {
    const retryable = error?.outage && (error.status === 0 || error.status === 429 || error.status >= 500);
    if (!retryable) throw error;
    await delay(options.retryDelayMs ?? 350);
    return fn();
  }
}

async function request(options, id, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try {
    const response = await options.fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await response.text();
    if (!response.ok) {
      throw providerError(`${id}:${response.status}`, {
        outage: isTransportOutage(response.status),
        status: response.status,
      });
    }
    if (/^\s*</u.test(text)) {
      throw providerError(`${id}:html`, { outage: true, status: response.status || 200 });
    }
    return text;
  } catch (error) {
    if (error?.label) throw error;
    const aborted = error?.name === "AbortError";
    throw providerError(`${id}:${aborted ? "timeout" : "network"}`, { outage: true, status: 0 });
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text, id) {
  try {
    return JSON.parse(text);
  } catch {
    throw providerError(`${id}:bad-response`, { outage: true, status: 200 });
  }
}

async function runBatched(items, options, id, translateBatch) {
  const translations = new Array(items.length).fill(null);
  const batchSize = Math.max(1, options.batchSize ?? 40);
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const slice = items.slice(offset, offset + batchSize);
    try {
      const batch = await withRetry(() => translateBatch(slice, options), options);
      if (!Array.isArray(batch) || batch.length !== slice.length) {
        throw providerError(`${id}:bad-response`, { outage: true, status: 200 });
      }
      batch.forEach((value, index) => {
        translations[offset + index] = value;
      });
    } catch (error) {
      if (error?.outage) {
        return { translations, outage: true, label: error.label || `${id}:error` };
      }
    }
  }
  return { translations, outage: false, label: "" };
}

async function runPool(items, options, translateOne) {
  const translations = new Array(items.length).fill(null);
  let outage = null;
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(options.fallbackConcurrency ?? 3, items.length || 1));

  async function worker() {
    while (!outage) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        translations[index] = await withRetry(() => translateOne(items[index].title, options), options);
      } catch (error) {
        if (error?.outage) {
          outage = error;
          return;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { translations, outage: Boolean(outage), label: outage?.label || "" };
}

async function officialBatch(items, options) {
  const texts = items.map((item) => item.title.slice(0, 600));
  const url = `${CLOUD_ENDPOINT}?key=${encodeURIComponent(options.apiKey)}`;
  const text = await request(options, "google-cloud", url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": UA,
    },
    body: JSON.stringify({ q: texts, target: "zh-CN", format: "text" }),
  });
  const rows = parseJson(text, "google-cloud")?.data?.translations;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw providerError("google-cloud:bad-response", { outage: true, status: 200 });
  }
  return rows.map((row) => row?.translatedText ?? "");
}

async function widgetBatch(items, options) {
  const texts = items.map((item) => escapeHtml(item.title.slice(0, 600)));
  const text = await request(options, "google-widget", WIDGET_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json+protobuf",
      "x-goog-api-key": options.widgetKey,
      accept: "*/*",
      "user-agent": UA,
      referer: "https://translate.google.com/",
    },
    body: JSON.stringify([[texts, "auto", "zh-CN"], "te_lib"]),
  });
  const rows = parseJson(text, "google-widget")?.[0];
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw providerError("google-widget:bad-response", { outage: true, status: 200 });
  }
  return rows.map((row) => (typeof row === "string" ? row : ""));
}

async function gtxOne(title, options) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: "zh-CN",
    dt: "t",
    q: title.slice(0, 600),
  });
  const text = await request(options, "google-gtx", `${GTX_ENDPOINT}?${params}`, {
    method: "GET",
    headers: { accept: "application/json,text/plain,*/*", "user-agent": UA },
  });
  const rows = parseJson(text, "google-gtx")?.[0];
  if (!Array.isArray(rows)) {
    throw providerError("google-gtx:bad-response", { outage: true, status: 200 });
  }
  return rows.map((part) => part?.[0] || "").join("").trim();
}

async function myMemoryOne(title, options) {
  const params = new URLSearchParams({
    q: title.slice(0, 500),
    langpair: "en|zh-CN",
  });
  if (options.myMemoryEmail) params.set("de", options.myMemoryEmail);
  const text = await request(options, "mymemory", `${MYMEMORY_ENDPOINT}?${params}`, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": UA },
  });
  const payload = parseJson(text, "mymemory");
  const translated = String(payload?.responseData?.translatedText || "");
  if (payload?.quotaFinished || /MYMEMORY WARNING/i.test(translated) || payload?.responseStatus === 429) {
    throw providerError("mymemory:quota", { outage: true, status: 403 });
  }
  if (payload?.responseStatus && payload.responseStatus !== 200) {
    throw providerError(`mymemory:${payload.responseStatus}`, {
      outage: isTransportOutage(payload.responseStatus),
      status: payload.responseStatus,
    });
  }
  return translated;
}

async function lingvaOne(title, options) {
  const url = `${LINGVA_ENDPOINT}/${encodeURIComponent(title.slice(0, 500))}`;
  const text = await request(options, "lingva", url, {
    method: "GET",
    headers: { accept: "application/json,text/plain,*/*", "user-agent": UA },
  });
  return String(parseJson(text, "lingva")?.translation || "");
}

function createProviders(settings) {
  const providers = [];
  if (settings.apiKey) providers.push({ id: "google-cloud", run: (items, options) => runBatched(items, options, "google-cloud", officialBatch) });
  if (settings.widgetKey) providers.push({ id: "google-widget", run: (items, options) => runBatched(items, options, "google-widget", widgetBatch) });
  providers.push({ id: "google-gtx", run: (items, options) => runPool(items, options, gtxOne) });
  providers.push({
    id: "mymemory",
    run: async (items, options) => {
      const limit = options.myMemoryLimit ?? 40;
      if (limit <= 0) {
        return { translations: new Array(items.length).fill(null), outage: true, label: "mymemory:budget" };
      }
      const attempted = items.slice(0, limit);
      const outcome = await runPool(attempted, options, myMemoryOne);
      const translations = new Array(items.length).fill(null);
      outcome.translations.forEach((value, index) => {
        translations[index] = value;
      });
      if (outcome.outage) return { translations, outage: true, label: outcome.label };
      if (items.length > limit) return { translations, outage: true, label: "mymemory:budget" };
      return { translations, outage: false, label: "" };
    },
  });
  providers.push({ id: "lingva", run: (items, options) => runPool(items, options, lingvaOne) });
  return providers;
}

function resolveSettings(options) {
  return {
    enabled: options.enabled !== false,
    cache: options.cache && typeof options.cache === "object" ? options.cache : {},
    maxTranslations: options.maxTranslations ?? 800,
    apiKey: String(options.apiKey ?? process.env.GOOGLE_TRANSLATE_API_KEY ?? "").trim(),
    widgetKey: String(options.widgetKey ?? process.env.GOOGLE_TRANSLATE_WIDGET_KEY ?? DEFAULT_WIDGET_KEY).trim(),
    myMemoryEmail: String(options.myMemoryEmail ?? process.env.MYMEMORY_EMAIL ?? "").trim(),
    fetchImpl: options.fetchImpl || fetch,
    timeoutMs: options.timeoutMs ?? 10000,
    batchSize: Math.max(1, options.batchSize ?? 40),
    myMemoryLimit: options.myMemoryLimit ?? 40,
    fallbackConcurrency: options.fallbackConcurrency ?? 3,
    retryDelayMs: options.retryDelayMs ?? 350,
    now: options.now || (() => new Date().toISOString()),
  };
}

export function seedTranslationCache(cache, feed) {
  if (!cache || typeof cache !== "object" || !feed || typeof feed !== "object") return 0;
  const generatedAt = typeof feed.generatedAt === "string" ? feed.generatedAt : "1970-01-01T00:00:00.000Z";
  const groups = feed.itemsBySection && typeof feed.itemsBySection === "object" ? Object.values(feed.itemsBySection) : [];
  let seeded = 0;
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (!item || item.lang === "zh" || containsChinese(item.title)) continue;
      const zh = cleanTranslation(item.title, item.titleZh);
      if (!zh || cache[item.title]?.zh) continue;
      cache[item.title] = { zh, updatedAt: generatedAt, seeded: true };
      seeded++;
    }
  }
  return seeded;
}

export async function translateForeignHeadlines(items, options = {}) {
  const settings = resolveSettings(options);
  const stats = {
    enabled: settings.enabled,
    candidates: 0,
    cached: 0,
    translated: 0,
    failed: 0,
    degraded: false,
    coverage: 1,
    providersUsed: [],
    failureSummary: "",
    message: "",
  };
  if (!settings.enabled) return stats;

  const candidates = (Array.isArray(items) ? items : [])
    .filter((item) => item && item.lang !== "zh" && !containsChinese(item.title))
    .slice(0, settings.maxTranslations);
  stats.candidates = candidates.length;

  const pending = [];
  for (const item of candidates) {
    const zh = cleanTranslation(item.title, settings.cache[item.title]?.zh);
    if (zh) {
      item.titleZh = zh;
      stats.cached++;
    } else {
      pending.push(item);
    }
  }

  const warnings = [];
  let remaining = pending;
  for (const provider of createProviders(settings)) {
    if (remaining.length === 0) break;
    const outcome = await provider.run(remaining, settings);
    const next = [];
    remaining.forEach((item, index) => {
      const zh = cleanTranslation(item.title, outcome.translations?.[index]);
      if (!zh) {
        next.push(item);
        return;
      }
      item.titleZh = zh;
      settings.cache[item.title] = { zh, updatedAt: settings.now(), provider: provider.id };
      stats.translated++;
      if (!stats.providersUsed.includes(provider.id)) stats.providersUsed.push(provider.id);
    });
    if (outcome.outage && outcome.label && next.length > 0) {
      warnings.push(`${outcome.label}×${next.length}`);
    }
    remaining = next;
  }

  stats.failed = remaining.length;
  const covered = stats.cached + stats.translated;
  stats.coverage = stats.candidates === 0 ? 1 : Math.round((covered / stats.candidates) * 1000) / 1000;
  stats.failureSummary = warnings.join(", ");
  stats.degraded =
    stats.candidates > 0 &&
    stats.coverage < TRANSLATION_COVERAGE_TARGET &&
    stats.failed > 0 &&
    warnings.length > 0;
  if (stats.degraded) {
    const keyNote = settings.apiKey
      ? "GOOGLE_TRANSLATE_API_KEY is set but Cloud Translation did not cover this feed. Confirm the key has Cloud Translation API access."
      : "Add GitHub Actions secret GOOGLE_TRANSLATE_API_KEY (Cloud Translation API v2) to translate new headlines from scheduled runners.";
    const percent = Math.round(stats.coverage * 1000) / 10;
    stats.message =
      `Translation coverage ${covered}/${stats.candidates} (${percent}%). ` +
      `Headline translation providers failed (${stats.failureSummary}). ` +
      `Cached Chinese titles were kept and the feed will still publish. ${keyNote}`;
  }
  return stats;
}
