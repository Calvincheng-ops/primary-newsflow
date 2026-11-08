import test from "node:test";
import assert from "node:assert/strict";
import { seedTranslationCache, translateForeignHeadlines } from "../translate.mjs";

function createFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const result = await responder(url, init, calls.length);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return result.body ?? "";
      },
    };
  };
  return { fetchImpl, calls };
}

function widgetBody(translations) {
  return JSON.stringify([translations, translations.map(() => "en")]);
}

function gtxBody(translation) {
  return JSON.stringify([[[translation, "source", null, null, 3]]]);
}

const quiet = {
  retryDelayMs: 0,
  fallbackConcurrency: 1,
  batchSize: 10,
  myMemoryLimit: 10,
  timeoutMs: 1000,
  apiKey: "",
  widgetKey: "test-widget-key",
  myMemoryEmail: "",
};

test("cached headlines are reused without calling a provider", async () => {
  const cache = { "Fed holds rates": { zh: "美联储维持利率", updatedAt: "2026-11-03T00:00:00.000Z" } };
  const items = [{ title: "Fed holds rates", lang: "en", link: "https://www.federalreserve.gov/" }];
  const { fetchImpl, calls } = createFetch(() => {
    throw new Error("provider should not be called");
  });
  const stats = await translateForeignHeadlines(items, { ...quiet, cache, fetchImpl });
  assert.equal(calls.length, 0);
  assert.equal(stats.cached, 1);
  assert.equal(stats.translated, 0);
  assert.equal(stats.failed, 0);
  assert.equal(stats.degraded, false);
  assert.equal(items[0].titleZh, "美联储维持利率");
});

test("widget batches return decoded Chinese titles", async () => {
  const items = [
    { title: "AT&T invests in fiber", lang: "en" },
    { title: "WHO warns of rising measles cases", lang: "en" },
  ];
  const cache = {};
  const { fetchImpl, calls } = createFetch(() => ({
    body: widgetBody(["AT&amp;T 投资光纤", "世卫组织警告麻疹病例上升"]),
  }));
  const stats = await translateForeignHeadlines(items, { ...quiet, cache, fetchImpl, now: () => "2026-11-08T00:00:00.000Z" });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, "translate-pa.googleapis.com");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body[0][0], ["AT&amp;T invests in fiber", "WHO warns of rising measles cases"]);
  assert.equal(body[1], "te_lib");
  assert.equal(items[0].titleZh, "AT&T 投资光纤");
  assert.equal(items[1].titleZh, "世卫组织警告麻疹病例上升");
  assert.equal(stats.translated, 2);
  assert.equal(stats.coverage, 1);
  assert.equal(stats.degraded, false);
  assert.deepEqual(stats.providersUsed, ["google-widget"]);
  assert.equal(cache["AT&T invests in fiber"].zh, "AT&T 投资光纤");
});

test("an HTML challenge falls through to the legacy gtx endpoint", async () => {
  const items = [{ title: "NASA launches a satellite", lang: "en" }];
  const { fetchImpl, calls } = createFetch((url) => {
    if (String(url).includes("translate-pa.googleapis.com")) {
      return { status: 200, body: "<html><title>Sorry...</title></html>" };
    }
    return { body: gtxBody("美国宇航局发射卫星") };
  });
  const stats = await translateForeignHeadlines(items, { ...quiet, cache: {}, fetchImpl });
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), [
    "translate-pa.googleapis.com",
    "translate.googleapis.com",
  ]);
  assert.equal(items[0].titleZh, "美国宇航局发射卫星");
  assert.equal(stats.degraded, false);
  assert.match(stats.failureSummary, /google-widget:html×1/);
  assert.deepEqual(stats.providersUsed, ["google-gtx"]);
});

test("a rate-limited widget is retried once and then the chain moves on", async () => {
  const items = [
    { title: "Oil prices rise after a pipeline outage", lang: "en" },
    { title: "Parliament debates the housing bill", lang: "en" },
  ];
  const { fetchImpl, calls } = createFetch((url) => {
    const href = String(url);
    if (href.includes("translate-pa.googleapis.com")) return { status: 429, body: "slow down" };
    if (href.includes("translate.googleapis.com/translate_a")) return { body: gtxBody("已翻译") };
    throw new Error(`unexpected provider ${href}`);
  });
  const stats = await translateForeignHeadlines(items, { ...quiet, cache: {}, fetchImpl });
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), [
    "translate-pa.googleapis.com",
    "translate-pa.googleapis.com",
    "translate.googleapis.com",
    "translate.googleapis.com",
  ]);
  assert.equal(stats.translated, 2);
  assert.equal(stats.failed, 0);
  assert.equal(stats.degraded, false);
  assert.match(stats.failureSummary, /google-widget:429/);
});

test("a total provider outage is explicit and keeps the original headlines", async () => {
  const items = [
    { title: "First foreign headline", lang: "en", link: "https://example.com/a" },
    { title: "Second foreign headline", lang: "en", link: "https://example.com/b" },
    { title: "Third foreign headline", lang: "fr", link: "https://example.com/c" },
    { title: "Fourth foreign headline", lang: "en", link: "https://example.com/d" },
  ];
  const { fetchImpl, calls } = createFetch(() => ({ status: 429, body: "blocked" }));
  const stats = await translateForeignHeadlines(items, { ...quiet, cache: {}, fetchImpl });
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), [
    "translate-pa.googleapis.com",
    "translate-pa.googleapis.com",
    "translate.googleapis.com",
    "translate.googleapis.com",
    "api.mymemory.translated.net",
    "api.mymemory.translated.net",
    "lingva.ml",
    "lingva.ml",
  ]);
  assert.equal(stats.translated, 0);
  assert.equal(stats.failed, 4);
  assert.equal(stats.degraded, true);
  assert.match(stats.failureSummary, /google-widget:429×4/);
  assert.match(stats.failureSummary, /google-gtx:429×4/);
  assert.match(stats.failureSummary, /lingva:429×4/);
  assert.match(stats.message, /GOOGLE_TRANSLATE_API_KEY/);
  assert.match(stats.message, /Cached Chinese titles were kept/);
  for (const item of items) assert.equal(item.titleZh, undefined);
});

test("Cloud Translation API is preferred when GOOGLE_TRANSLATE_API_KEY is set", async () => {
  const secret = "test-cloud-key";
  const items = [{ title: "Bank of Japan keeps policy unchanged", lang: "en" }];
  const { fetchImpl, calls } = createFetch(() => ({
    body: JSON.stringify({ data: { translations: [{ translatedText: "日本央行维持政策不变" }] } }),
  }));
  const stats = await translateForeignHeadlines(items, { ...quiet, cache: {}, fetchImpl, apiKey: secret });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, "translation.googleapis.com");
  assert.match(calls[0].url, /key=test-cloud-key/);
  assert.equal(items[0].titleZh, "日本央行维持政策不变");
  assert.equal(JSON.stringify(stats).includes(secret), false);
  assert.deepEqual(stats.providersUsed, ["google-cloud"]);
});

test("an unusable widget translation falls through to gtx", async () => {
  const items = [{ title: "Students protest the tuition increase", lang: "en" }];
  const { fetchImpl, calls } = createFetch((url) => {
    if (String(url).includes("translate-pa.googleapis.com")) {
      return { body: widgetBody(["Students protest the tuition increase"]) };
    }
    return { body: gtxBody("学生抗议学费上涨") };
  });
  const stats = await translateForeignHeadlines(items, { ...quiet, cache: {}, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(items[0].titleZh, "学生抗议学费上涨");
  assert.equal(stats.failed, 0);
  assert.equal(stats.degraded, false);
});

test("Chinese sources and an empty translation mode do not call providers", async () => {
  const items = [
    { title: "国务院召开常务会议", lang: "zh" },
    { title: "Already 中文 headline", lang: "en" },
  ];
  const { fetchImpl, calls } = createFetch(() => {
    throw new Error("provider should not be called");
  });
  const skipped = await translateForeignHeadlines(items, { ...quiet, cache: {}, fetchImpl });
  assert.equal(skipped.candidates, 0);
  assert.equal(calls.length, 0);

  const disabled = await translateForeignHeadlines(
    [{ title: "Hello from abroad", lang: "en" }],
    { ...quiet, enabled: false, fetchImpl },
  );
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.candidates, 0);
  assert.equal(calls.length, 0);
});

test("previous feed seeds translations that the next build reuses when providers are down", async () => {
  const cache = { "Kept title": { zh: "已有译文", updatedAt: "2026-11-08T00:00:00.000Z" } };
  const seeded = seedTranslationCache(cache, {
    generatedAt: "2026-11-03T00:43:16.395Z",
    itemsBySection: {
      world: [
        { title: "Fed holds rates", titleZh: "美联储维持利率", lang: "en" },
        { title: "Kept title", titleZh: "不应覆盖", lang: "en" },
        { title: "No Chinese", titleZh: "hello", lang: "en" },
      ],
      china: [{ title: "中国标题", titleZh: "不需要", lang: "zh" }],
    },
  });
  assert.equal(seeded, 1);
  assert.equal(cache["Fed holds rates"].zh, "美联储维持利率");
  assert.equal(cache["Kept title"].zh, "已有译文");
  assert.equal(cache["No Chinese"], undefined);

  const items = [
    { title: "Fed holds rates", lang: "en" },
    { title: "Brand new headline", lang: "en" },
  ];
  const { fetchImpl } = createFetch(() => ({ status: 403, body: "<html>blocked</html>" }));
  const stats = await translateForeignHeadlines(items, { ...quiet, cache, fetchImpl });
  assert.equal(items[0].titleZh, "美联储维持利率");
  assert.equal(items[1].titleZh, undefined);
  assert.equal(stats.cached, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.coverage, 0.5);
  assert.equal(stats.degraded, true);
  assert.match(stats.message, /GOOGLE_TRANSLATE_API_KEY/);
});
