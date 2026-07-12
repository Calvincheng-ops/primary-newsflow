import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const registry = JSON.parse(await readFile(new URL("../sources.json", import.meta.url), "utf8"));
const data = JSON.parse(await readFile(new URL("../public/data.json", import.meta.url), "utf8"));

test("source registry has unique, valid references", () => {
  const ids = registry.sources.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length, "source ids must be unique");
  for (const source of registry.sources) {
    assert.ok(registry.sections[source.section], `${source.id} has an unknown section`);
    assert.ok(registry.categories[source.category], `${source.id} has an unknown category`);
    assert.doesNotThrow(() => new URL(source.url), `${source.id} has an invalid URL`);
  }
});

test("generated feed satisfies the core coverage and health gates", () => {
  assert.equal(data.health.ok, true);
  assert.ok(data.stats.total >= 100);
  assert.ok(data.stats.perSec.ai >= 40, "AI feed should contain useful daily coverage");
  assert.ok(data.stats.perSec.china >= 40, "China feed should contain useful daily coverage");
  assert.ok(data.stats.perSec.world >= 80, "World feed should contain useful daily coverage");
});

test("foreign headlines receive Chinese short translations while preserving original links", () => {
  const foreign = Object.values(data.itemsBySection)
    .flat()
    .filter((item) => item.lang !== "zh" && !/[\u3400-\u9fff]/u.test(item.title))
    .slice(0, 300);
  const translated = foreign.filter((item) => item.titleZh);
  assert.ok(foreign.length > 0);
  assert.ok(translated.length / foreign.length >= 0.9, "at least 90% of sampled foreign headlines should be translated");
  for (const item of translated) {
    assert.notEqual(item.titleZh, item.title);
    const url = new URL(item.link);
    assert.ok(["http:", "https:"].includes(url.protocol));
    assert.notEqual(url.hostname, "translate.google.com", "cards must link to the original publisher");
  }
});

function keywordMatchesText(text, keyword) {
  const normalizedText = String(text || "").toLowerCase();
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();
  if (/[^\x00-\x7f]/u.test(normalizedKeyword) || /\s/u.test(normalizedKeyword)) {
    return normalizedText.includes(normalizedKeyword);
  }
  const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalizedText);
}

test("general-interest AI sources only admit title-matched stories", () => {
  const filteredSources = new Map(
    registry.sources
      .filter((source) => source.section === "ai" && source.filterFields?.includes("title"))
      .map((source) => [source.id, source]),
  );
  assert.ok(filteredSources.size > 0);

  for (const item of data.itemsBySection.ai) {
    const source = filteredSources.get(item.sourceId);
    if (!source) continue;
    assert.ok(
      source.includeKeywords.some((keyword) => keywordMatchesText(item.title, keyword)),
      `${source.id} admitted an AI item without a title keyword: ${item.title}`,
    );
  }
});

test("daily feed excludes stale or unexplained undated stories", () => {
  const sourceById = new Map(registry.sources.map((source) => [source.id, source]));
  const cutoff = Date.parse(data.generatedAt) - 10 * 24 * 60 * 60 * 1000;
  for (const item of Object.values(data.itemsBySection).flat()) {
    if (!item.date) {
      assert.equal(sourceById.get(item.sourceId)?.allowUndated, true, `${item.sourceId} emitted an undated item`);
      continue;
    }
    assert.ok(item.date >= cutoff, `${item.sourceId} emitted a stale item: ${item.title}`);
  }

  const chineseChinaItems = data.itemsBySection.china.filter(
    (item) => item.lang === "zh" || /[\u3400-\u9fff]/u.test(item.title),
  );
  assert.ok(chineseChinaItems.length >= 40, "China section should have substantial current Chinese-language coverage");
});

test("large feeds render incrementally and expose per-section source health", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(app, /const PAGE_SIZE = 60/);
  assert.match(app, /filtered\.slice\(0, state\.visibleCount\)/);
  assert.match(app, /function renderSourceHealth\(\)/);
  assert.match(html, /id="loadMoreBtn"/);
  assert.match(html, /id="sourceHealth"/);
});


test("curl fallback decompresses feeds and blocked FDA source is replaced by the official CDC API", async () => {
  const build = await readFile(new URL("../build.mjs", import.meta.url), "utf8");
  assert.match(build, /"--compressed"/);
  assert.doesNotMatch(build, /stay-informed\/rss-feeds\/press-releases/);

  const cdc = registry.sources.find((source) => source.id === "cdc");
  assert.ok(cdc, "official CDC source should be configured");
  assert.equal(cdc.type, "json");
  assert.equal(cdc.parser, "cdc-media");
  assert.equal(new URL(cdc.url).hostname, "tools.cdc.gov");
});

test("redesigned frontend exposes two persistent information views and density control", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");

  assert.match(html, /id="viewConsoleBtn"/);
  assert.match(html, /id="viewEditorialBtn"/);
  assert.match(html, /id="densityBtn"/);
  assert.match(app, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(app, /localStorage\.setItem\(STORAGE_KEY/);
  assert.match(css, /\.mode-editorial \.feed-container/);
  assert.match(css, /\.density-comfortable \.news-card/);
});

test("news cards remain direct original links in the redesigned renderer", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /href="\$\{safeUrl\(item\.link\)\}"/);
  assert.match(app, /target="_blank"/);
  assert.doesNotMatch(app, /translate\.google\.com/);
});
