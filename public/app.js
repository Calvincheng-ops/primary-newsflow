"use strict";

const PAGE_SIZE = 60;
const STORAGE_KEY = "primary-newsflow-preferences-v2";
const SECTION_ORDER = ["ai", "china", "world", "nav"];
const SECTION_CODES = { ai: "CH.01", china: "CH.02", world: "CH.03", nav: "CH.04" };

const state = {
  data: null,
  section: "ai",
  q: "",
  catFilter: "all",
  tiers: new Set([1, 2, 3]),
  visibleCount: PAGE_SIZE,
  mode: "console",
  density: "compact",
};

const $ = (selector) => document.querySelector(selector);
const sbNav = $("#sbNav");
const sbUpdated = $("#sbUpdated");
const sectionTitle = $("#sectionTitle");
const sectionDesc = $("#sectionDesc");
const sectionCode = $("#sectionCode");
const statsBar = $("#statsBar");
const searchInput = $("#searchInput");
const filterChips = $("#filterChips");
const feedContainer = $("#feedContainer");
const navGrid = $("#navGrid");
const emptyState = $("#emptyState");
const toolbar = $("#toolbar");
const menuToggle = $("#menuToggle");
const sidebar = $("#sidebar");
const feedStatus = $("#feedStatus");
const streamHead = $("#streamHead");
const loadMoreBtn = $("#loadMoreBtn");
const sourceHealth = $("#sourceHealth");
const globalStatus = $("#globalStatus");
const signalTicker = $("#signalTicker");
const densityLabel = $("#densityLabel");
const viewButtons = [...document.querySelectorAll(".view-btn")];

function esc(value) {
  return String(value || "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function safeUrl(value) {
  try {
    const url = new URL(value, location.href);
    return ["http:", "https:"].includes(url.protocol) ? esc(url.href) : "#";
  } catch {
    return "#";
  }
}

function timeAgo(timestamp) {
  if (!timestamp) return "时间未知";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 10) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function isFresh(timestamp) {
  return timestamp && Date.now() - timestamp < 2 * 60 * 60 * 1000;
}

function tierLabel(tier) {
  return tier === 1 ? "T1 PRIMARY" : tier === 2 ? "T2 WIRE" : "T3 LEAD";
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (["console", "editorial"].includes(saved.mode)) state.mode = saved.mode;
    if (["compact", "comfortable"].includes(saved.density)) state.density = saved.density;
  } catch {}
  applyPreferences(false);
}

function savePreferences() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: state.mode, density: state.density }));
}

function applyPreferences(shouldSave = true) {
  document.body.classList.toggle("mode-console", state.mode === "console");
  document.body.classList.toggle("mode-editorial", state.mode === "editorial");
  document.body.classList.toggle("density-compact", state.density === "compact");
  document.body.classList.toggle("density-comfortable", state.density === "comfortable");
  viewButtons.forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  densityLabel.textContent = state.density === "compact" ? "紧凑" : "舒展";
  if (shouldSave) savePreferences();
}

function buildSidebar() {
  const perSection = state.data.stats.perSec || {};
  sbNav.innerHTML = SECTION_ORDER.map((key, index) => {
    const section = state.data.sections[key];
    if (!section) return "";
    const active = state.section === key ? " active" : "";
    const count = key === "nav" ? "↗" : perSection[key] || 0;
    return `<button class="sb-nav-item${active}" type="button" data-section="${key}" aria-current="${active ? "page" : "false"}">
      <span class="nav-indicator"></span>
      <span class="nav-icon" aria-hidden="true">${section.icon}</span>
      <span class="nav-label">${esc(section.label)}<small class="nav-code">0${index + 1} / ${key.toUpperCase()}</small></span>
      <span class="nav-count">${count}</span>
    </button>`;
  }).join("");

  sbNav.querySelectorAll(".sb-nav-item").forEach((button) => {
    button.addEventListener("click", () => selectSection(button.dataset.section));
  });
}

function selectSection(section) {
  state.section = section;
  state.q = "";
  state.catFilter = "all";
  state.visibleCount = PAGE_SIZE;
  searchInput.value = "";
  switchSection();
}

function switchSection() {
  const section = state.data.sections[state.section];
  const isNav = state.section === "nav";
  sectionTitle.textContent = section.label;
  sectionDesc.textContent = section.desc || "";
  sectionCode.textContent = SECTION_CODES[state.section];

  sbNav.querySelectorAll(".sb-nav-item").forEach((button) => {
    const active = button.dataset.section === state.section;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });

  toolbar.hidden = isNav;
  streamHead.hidden = isNav;
  feedContainer.hidden = isNav;
  sourceHealth.hidden = isNav;
  navGrid.classList.toggle("active", isNav);
  emptyState.hidden = true;
  loadMoreBtn.hidden = true;

  if (isNav) renderNavGrid();
  else {
    buildFilterChips();
    renderFeed();
    renderSourceHealth();
  }
  renderStats();
  updateSearchPlaceholder();
  closeMobileMenu();
}

function updateSearchPlaceholder() {
  const placeholders = {
    ai: "检索模型、论文、产品、公司或政策…",
    china: "检索中国政经、社会或科技动态…",
    world: "检索全球事件、机构或关键词…",
  };
  searchInput.placeholder = placeholders[state.section] || "检索实时信号…";
}

function renderStats() {
  if (state.section === "nav") {
    statsBar.innerHTML = `
      <div class="stat-card" style="--meter:100%"><span class="stat-num">${state.data.navLinks.length}</span><span class="stat-label">导航频道</span></div>
      <div class="stat-card" style="--meter:100%"><span class="stat-num">DIRECT</span><span class="stat-label">直达实时页面</span></div>
      <div class="stat-card" style="--meter:100%"><span class="stat-num">24/7</span><span class="stat-label">持续可访问</span></div>
      <div class="stat-card stat-note"><span class="translation-dot"></span><span class="stat-label">精选新闻、金融和事件监测入口</span></div>`;
    return;
  }

  const items = state.data.itemsBySection[state.section] || [];
  const sources = state.data.sources.filter((source) => source.section === state.section);
  const online = sources.filter((source) => source.ok).length;
  const translated = items.filter((item) => item.titleZh).length;
  const sourceRate = sources.length ? Math.round((online / sources.length) * 100) : 0;
  const translationRate = items.length ? Math.round((translated / items.length) * 100) : 0;
  statsBar.innerHTML = `
    <div class="stat-card" style="--meter:${Math.min(100, items.length / 4)}%"><span class="stat-num">${items.length}</span><span class="stat-label">ACTIVE SIGNALS / 实时信息</span></div>
    <div class="stat-card" style="--meter:${sourceRate}%"><span class="stat-num">${online}<small> / ${sources.length}</small></span><span class="stat-label">SOURCES ONLINE / 信源在线</span></div>
    <div class="stat-card" style="--meter:${translationRate}%"><span class="stat-num">${translated}</span><span class="stat-label">ZH BRIEFS / 中文短译</span></div>
    <div class="stat-card stat-note"><span class="translation-dot"></span><span class="stat-label">VERIFIED ORIGIN · 点击任意信号直达发布机构原文</span></div>`;
}

function buildFilterChips() {
  const items = state.data.itemsBySection[state.section] || [];
  const counts = new Map();
  items.forEach((item) => counts.set(item.category, (counts.get(item.category) || 0) + 1));
  const entries = [["all", "全部信号", items.length], ...counts.entries()].map(([key, value, maybeCount]) => {
    if (key === "all") return [key, value, maybeCount];
    return [key, state.data.categories[key] || key, value];
  });
  filterChips.innerHTML = entries.map(([key, label, count]) => `
    <button class="chip${key === state.catFilter ? " active" : ""}" type="button" data-cat="${esc(key)}" aria-pressed="${key === state.catFilter}">${esc(label)} <small>${count}</small></button>`).join("");
  filterChips.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.catFilter = chip.dataset.cat;
      state.visibleCount = PAGE_SIZE;
      buildFilterChips();
      renderFeed();
    });
  });
}

function renderFeed() {
  const items = state.data.itemsBySection[state.section] || [];
  const query = state.q.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (state.catFilter !== "all" && item.category !== state.catFilter) return false;
    if (!state.tiers.has(Number(item.tier))) return false;
    if (!query) return true;
    const searchable = [item.title, item.titleZh, item.sourceName, item.sourceNameEn, item.summary, item.region].join(" ").toLowerCase();
    return searchable.includes(query);
  });

  const visible = filtered.slice(0, state.visibleCount);
  emptyState.hidden = filtered.length > 0;
  feedStatus.textContent = filtered.length ? `${visible.length} / ${filtered.length} 条已解码` : "0 条匹配信号";
  loadMoreBtn.hidden = visible.length >= filtered.length;
  loadMoreBtn.querySelector("span").textContent = `载入下一批信号 · 剩余 ${Math.max(0, filtered.length - visible.length)} 条`;

  feedContainer.innerHTML = visible.map((item) => renderStory(item)).join("");
}

function renderStory(item) {
  const category = state.data.categories[item.category] || item.category;
  const translated = Boolean(item.titleZh && item.titleZh !== item.title);
  const primaryTitle = translated ? item.titleZh : item.title;
  const original = translated ? `<div class="nc-original-title"><span>ORIGINAL</span>${esc(item.title)}</div>` : "";
  const summary = item.summary ? `<div class="nc-summary">${translated ? "原文摘要 · " : ""}${esc(item.summary)}</div>` : "";
  const fresh = isFresh(item.date) ? `<span class="nc-fresh">● NEW SIGNAL</span>` : `<span></span>`;
  return `<a class="news-card t${Number(item.tier) || 3}" href="${safeUrl(item.link)}" target="_blank" rel="noopener noreferrer" aria-label="打开原文：${esc(item.title)}">
    <div class="signal-index"><i></i></div>
    <div class="nc-source-rail">
      <div class="nc-source">${esc(item.sourceName)}</div>
      <div class="nc-source-en">${esc(item.sourceNameEn || item.sourceId)}</div>
      <div class="nc-rail-meta">
        <span class="nc-tier">${tierLabel(Number(item.tier))}</span>
        <span class="nc-region">${esc(item.region || "GLOBAL")}</span>
        <span class="nc-cat">${esc(category)}</span>
        ${translated ? `<span class="nc-translated">中译</span>` : ""}
      </div>
    </div>
    <div class="nc-content">
      <div class="nc-title">${esc(primaryTitle)}</div>
      ${original}${summary}
    </div>
    <div class="nc-time-rail">
      <span class="nc-time">${timeAgo(item.date)}</span>
      ${fresh}
      <span class="nc-open" aria-hidden="true">↗</span>
    </div>
  </a>`;
}

function renderSourceHealth() {
  const sources = state.data.sources.filter((source) => source.section === state.section);
  const online = sources.filter((source) => source.ok).length;
  const failed = sources.length - online;
  const tags = sources.map((source) => {
    const count = Number.isFinite(source.count) ? `${source.count} 条` : "";
    const detail = source.ok ? count || "在线" : `抓取失败：${source.error || "未知错误"}`;
    return `<a class="src-tag${source.ok ? "" : " dead"}" href="${safeUrl(source.home)}" target="_blank" rel="noopener" title="${esc(detail)}"><span class="src-dot"></span><span>${esc(source.name)}</span><small>${esc(count)}</small></a>`;
  }).join("");
  sourceHealth.innerHTML = `<summary><span>SOURCE MATRIX / 信源矩阵</span><strong>${online}/${sources.length} ONLINE</strong>${failed ? `<em>${failed} DEGRADED</em>` : ""}<span class="source-health-hint">展开查看节点</span></summary><div class="src-grid">${tags}</div>`;
}

function renderNavGrid() {
  navGrid.innerHTML = (state.data.navLinks || []).map((group, groupIndex) => {
    const links = (group.items || []).map((link, index) => {
      let domain = "";
      try { domain = new URL(link.url).hostname.replace(/^www\./, ""); } catch {}
      return `<a class="nav-link-card" href="${safeUrl(link.url)}" target="_blank" rel="noopener"><div class="nl-name">${String(groupIndex + 1).padStart(2, "0")}.${String(index + 1).padStart(2, "0")} / ${esc(link.name)} ↗</div><div class="nl-desc">${esc(link.desc)}</div><div class="nl-domain">${esc(domain)}</div></a>`;
    }).join("");
    return `<section class="nav-group"><div class="nav-group-title">DIRECTORY / ${esc(group.cat)}</div><div class="nav-links">${links}</div></section>`;
  }).join("");
}

function closeMobileMenu() {
  sidebar.classList.remove("open");
  menuToggle.setAttribute("aria-expanded", "false");
  $("#sidebarOverlay")?.classList.remove("active");
}

function toggleMobileMenu() {
  sidebar.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(sidebar.classList.contains("open")));
  let overlay = $("#sidebarOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sidebarOverlay";
    overlay.className = "sidebar-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", closeMobileMenu);
  }
  overlay.classList.toggle("active", sidebar.classList.contains("open"));
}

function updateClock() {
  const now = new Date();
  $("#liveClock").textContent = `${now.toLocaleTimeString("zh-CN", { hour12: false })} CST`;
}

async function loadData() {
  const refresh = $("#refreshBtn");
  refresh.disabled = true;
  refresh.classList.add("loading");
  try {
    const response = await fetch(`./data.json?_=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    const generated = new Date(state.data.generatedAt);
    sbUpdated.textContent = `LAST SYNC / ${generated.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`;
    globalStatus.textContent = `${state.data.stats.sourcesOk}/${state.data.stats.sourcesOk + state.data.stats.sourcesFailed} SOURCES · ${state.data.stats.total} SIGNALS · ${state.data.stats.translated} ZH BRIEFS`;
    signalTicker.textContent = `PRIMARY NEWSFLOW / ${state.data.stats.total} VERIFIED ITEMS / ${state.data.stats.sourcesOk} SOURCES ONLINE / DIRECT-TO-ORIGIN LINKS / MACHINE-ASSISTED ZH BRIEFS`;
    buildSidebar();
    switchSection();
  } catch (error) {
    statsBar.innerHTML = `<div class="stat-card"><span class="stat-num" style="color:var(--red)">OFFLINE</span><span class="stat-label">数据加载失败 · ${esc(error.message)}</span></div>`;
  } finally {
    refresh.disabled = false;
    refresh.classList.remove("loading");
  }
}

searchInput.addEventListener("input", (event) => {
  state.q = event.target.value;
  state.visibleCount = PAGE_SIZE;
  renderFeed();
});
loadMoreBtn.addEventListener("click", () => {
  state.visibleCount += PAGE_SIZE;
  renderFeed();
});
$("#refreshBtn").addEventListener("click", loadData);
menuToggle.addEventListener("click", toggleMobileMenu);
viewButtons.forEach((button) => button.addEventListener("click", () => {
  state.mode = button.dataset.mode;
  applyPreferences();
}));
$("#densityBtn").addEventListener("click", () => {
  state.density = state.density === "compact" ? "comfortable" : "compact";
  applyPreferences();
});

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea, select")) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  const shortcuts = { "1": "ai", "2": "china", "3": "world", "4": "nav" };
  if (shortcuts[event.key] && state.data) selectSection(shortcuts[event.key]);
  if (event.key === "/") {
    event.preventDefault();
    searchInput.focus();
  }
  if (event.key.toLowerCase() === "v") {
    state.mode = state.mode === "console" ? "editorial" : "console";
    applyPreferences();
  }
});

loadPreferences();
updateClock();
setInterval(updateClock, 1000);
loadData();
