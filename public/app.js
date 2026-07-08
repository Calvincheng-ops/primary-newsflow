"use strict";

const state = {
  data: null,
  cat: "all",
  q: "",
  tiers: new Set([1, 2, 3]),
};

const $ = (s) => document.querySelector(s);
const feedEl = $("#feed");
const tabsEl = $("#tabs");
const statsEl = $("#stats");
const emptyEl = $("#empty");

function timeAgo(ts) {
  if (!ts) return "时间未知";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") return esc(url.href);
  } catch {}
  return "#";
}

function tierLabel(t) {
  return t === 1 ? "顶级机构" : t === 2 ? "通讯社" : "头部机构";
}

function render() {
  const { data } = state;
  const cats = data.categories;
  const q = state.q.trim().toLowerCase();

  const items = data.items.filter((it) => {
    if (state.cat !== "all" && it.category !== state.cat) return false;
    if (!state.tiers.has(it.tier)) return false;
    if (q) {
      const hay = (it.title + " " + it.sourceName + " " + it.sourceNameEn + " " + (it.summary || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  statsEl.textContent = `共 ${items.length} 条 · 来自 ${data.stats.sourcesOk} 个在线一级源`;

  emptyEl.hidden = items.length > 0;
  feedEl.innerHTML = items
    .map((it) => {
      const cat = cats[it.category] || it.category;
      return `<li class="item">
        <div class="item-top">
          <span class="badge t${it.tier}">${tierLabel(it.tier)}</span>
          <span class="src">${esc(it.sourceName)}</span>
          <span class="region">${esc(it.region || "")}</span>
          <span class="cat-pill">${esc(cat)}</span>
          <span class="time">${timeAgo(it.date)}</span>
        </div>
        <a class="title" href="${safeUrl(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        ${it.summary ? `<p class="summary">${esc(it.summary)}</p>` : ""}
      </li>`;
    })
    .join("");
}

function buildTabs() {
  const { data } = state;
  const cats = data.categories;
  const perCat = data.stats.perCat || {};
  const entries = [["all", "全部"]].concat(Object.entries(cats));
  tabsEl.innerHTML = entries
    .map(([key, label]) => {
      const n = key === "all" ? data.items.length : perCat[key] || 0;
      return `<button class="tab ${key === state.cat ? "active" : ""}" data-cat="${key}">${label}<span class="n">${n}</span></button>`;
    })
    .join("");
  tabsEl.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.cat = b.dataset.cat;
      tabsEl.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
      render();
    })
  );
}

function buildSourceNav() {
  const { data } = state;
  const cats = data.categories;
  const groups = {};
  for (const s of data.sources) {
    (groups[s.category] ||= []).push(s);
  }
  const html = Object.entries(cats)
    .filter(([k]) => groups[k])
    .map(([k, label]) => {
      const list = groups[k]
        .sort((a, b) => a.tier - b.tier)
        .map(
          (s) =>
            `<a class="snav-item ${s.ok ? "" : "dead"}" href="${safeUrl(s.home)}" target="_blank" rel="noopener" title="${esc(s.nameEn)}${s.ok ? "" : " · 当前抓取异常"}">
              <span class="dot"></span>${esc(s.name)}</a>`
        )
        .join("");
      return `<div class="snav-group"><h3>${label}</h3><div class="snav-list">${list}</div></div>`;
    })
    .join("");
  $("#sourceNav").innerHTML = html;
}

function hookControls() {
  $("#search").addEventListener("input", (e) => {
    state.q = e.target.value;
    render();
  });
  document.querySelectorAll(".tierbox").forEach((cb) =>
    cb.addEventListener("change", () => {
      state.tiers = new Set(
        [...document.querySelectorAll(".tierbox:checked")].map((x) => Number(x.value))
      );
      render();
    })
  );
  $("#refresh").addEventListener("click", load);
}

async function load() {
  try {
    const res = await fetch("./data.json?_=" + Date.now());
    const data = await res.json();
    state.data = data;
    const gen = new Date(data.generatedAt);
    $("#updated").textContent = "更新于 " + gen.toLocaleString("zh-CN", { hour12: false });
    $("#footnote").textContent = data.metaNote || "";
    buildTabs();
    buildSourceNav();
    render();
  } catch (e) {
    statsEl.textContent = "数据加载失败：" + e.message;
  }
}

hookControls();
load();
