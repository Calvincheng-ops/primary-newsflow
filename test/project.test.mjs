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
