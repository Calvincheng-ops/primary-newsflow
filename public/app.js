"use strict";

// ===== State =====
const state = {
  data: null,
  section: "ai",
  q: "",
  catFilter: "all",
  tiers: new Set([1, 2, 3]),
  visibleCount: 60,
};

const PAGE_SIZE = 60;

// ===== DOM refs =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const sbNav = $("#sbNav");
const sbUpdated = $("#sbUpdated");
const sectionTitle = $("#sectionTitle");
const sectionDesc = $("#sectionDesc");
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
const loadMoreBtn = $("#loadMoreBtn");
const sourceHealth = $("#sourceHealth");

// ===== Helpers =====
function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") return esc(url.href);
  } catch {}
  return "#";
}

function tierLabel(t) {
  return t === 1 ? "T1 顶级机构" : t === 2 ? "T2 通讯社" : "T3 头部机构";
}

// ===== Sidebar Navigation =====
function buildSidebar() {
  const { data } = state;
  const sections = data.sections;
  const perSec = data.stats.perSec || {};

  const order = ["ai", "china", "world", "nav"];
  sbNav.innerHTML = order
    .map((key) => {
      const sec = sections[key];
      if (!sec) return "";
      const n = key === "nav" ? "" : `<span class="nav-count">${perSec[key] || 0}</span>`;
      const active = key === state.section ? " active" : "";
      return `<button class="sb-nav-item${active}" data-section="${key}">
        <span class="nav-indicator"></span>
        <span class="nav-icon">${sec.icon}</span>
        <span>${sec.label}</span>
        ${n}
      </button>`;
    })
    .join("");

  sbNav.querySelectorAll(".sb-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.section = btn.dataset.section;
      state.q = "";
      state.catFilter = "all";
      state.visibleCount = PAGE_SIZE;
      searchInput.value = "";
      switchSection();
    });
  });
}

function switchSection() {
  const { data } = state;
  const sec = data.sections[state.section];

  sectionTitle.textContent = sec.label;
  sectionDesc.textContent = sec.desc || "";

  sbNav.querySelectorAll(".sb-nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.section === state.section);
  });

  const isNav = state.section === "nav";
  toolbar.style.display = isNav ? "none" : "";
  feedContainer.style.display = isNav ? "none" : "";
  navGrid.classList.toggle("active", isNav);
  emptyState.hidden = true;

  feedStatus.hidden = isNav;
  loadMoreBtn.hidden = true;
  sourceHealth.hidden = isNav;

  if (isNav) {
    renderNavGrid();
  } else {
    buildFilterChips();
    renderFeed();
    renderSourceHealth();
  }
  renderStats();
  updateSearchPlaceholder();

  // Close mobile sidebar
  sidebar.classList.remove("open");
  $("#sidebarOverlay")?.classList.remove("active");
}

function updateSearchPlaceholder() {
  const map = { ai: "搜索 AI 论文/产品/政策…", china: "搜索中国政经/社会新闻…", world: "搜索标题 / 机构 / 关键词…" };
  searchInput.placeholder = map[state.section] || "搜索…";
}

// ===== Stats Bar =====
function renderStats() {
  const { data } = state;
  const perSec = data.stats.perSec || {};
  const isNav = state.section === "nav";

  if (isNav) {
    statsBar.innerHTML = "";
    return;
  }

  const n = perSec[state.section] || 0;
  const sectionSources = data.sources.filter((s) => s.section === state.section);
  const okSources = sectionSources.filter((s) => s.ok).length;
  const translated = (data.itemsBySection[state.section] || []).filter((item) => item.titleZh).length;

  statsBar.innerHTML = `
    <div class="stat-card">
      <span class="stat-num">${n}</span>
      <span class="stat-label">条信息</span>
    </div>
    <div class="stat-card">
      <span class="stat-num">${okSources}</span>
      <span class="stat-label">/ ${sectionSources.length} 个信源在线</span>
    </div>
    <div class="stat-card">
      <span class="stat-num">${translated}</span>
      <span class="stat-label">条外文中文短译</span>
    </div>
    <div class="stat-card stat-note">
      <span class="translation-dot"></span>
      <span class="stat-label">机器短译 · 点击卡片阅读原文</span>
    </div>
  `;
}

// ===== Filter Chips =====
function buildFilterChips() {
  const { data } = state;
  const items = data.itemsBySection[state.section] || [];
  const categories = data.categories;

  const catCounts = {};
  const cats = new Set();
  for (const it of items) {
    catCounts[it.category] = (catCounts[it.category] || 0) + 1;
    cats.add(it.category);
  }

  const entries = [["all", "全部", items.length]];
  for (const c of cats) {
    entries.push([c, categories[c] || c, catCounts[c] || 0]);
  }

  filterChips.innerHTML = entries
    .map(([key, label, n]) => {
      const active = key === state.catFilter ? " active" : "";
      return `<span class="chip${active}" data-cat="${key}">${label} <small>${n}</small></span>`;
    })
    .join("");

  filterChips.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.catFilter = chip.dataset.cat;
      state.visibleCount = PAGE_SIZE;
      filterChips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
      renderFeed();
    });
  });
}

// ===== Feed Rendering =====
function renderFeed() {
  const { data } = state;
  const items = data.itemsBySection[state.section] || [];
  const categories = data.categories;
  const q = state.q.trim().toLowerCase();

  const filtered = items.filter((it) => {
    if (state.catFilter !== "all" && it.category !== state.catFilter) return false;
    if (!state.tiers.has(it.tier)) return false;
    if (q) {
      const hay = (it.title + " " + (it.titleZh || "") + " " + it.sourceName + " " + it.sourceNameEn + " " + (it.summary || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  emptyState.hidden = filtered.length > 0;

  const visible = filtered.slice(0, state.visibleCount);
  feedStatus.textContent = filtered.length
    ? `正在显示 ${visible.length} / ${filtered.length} 条`
    : "没有匹配结果";
  loadMoreBtn.hidden = visible.length >= filtered.length;
  loadMoreBtn.textContent = `加载更多（剩余 ${Math.max(0, filtered.length - visible.length)} 条）`;

  feedContainer.innerHTML = visible
    .map((it) => {
      const cat = categories[it.category] || it.category;
      const hasTranslation = Boolean(it.titleZh && it.titleZh !== it.title);
      const title = hasTranslation
        ? `<div class="nc-title nc-title-zh">${esc(it.titleZh)}</div><div class="nc-original-title"><span>原文</span>${esc(it.title)}</div>`
        : `<div class="nc-title">${esc(it.title)}</div>`;
      const summary = it.summary
        ? `<div class="nc-summary${hasTranslation ? " nc-summary-original" : ""}">${hasTranslation ? "原文摘要 · " : ""}${esc(it.summary)}</div>`
        : "";
      const translatedBadge = hasTranslation ? `<span class="nc-translated">中译</span>` : "";
      return `<a class="news-card" href="${safeUrl(it.link)}" target="_blank" rel="noopener" aria-label="打开原文：${esc(it.title)}">
        <div class="nc-content">
          <div class="nc-meta">
            <span class="nc-tier t${it.tier}">${tierLabel(it.tier)}</span>
            <span class="nc-source">${esc(it.sourceName)}</span>
            <span class="nc-region">${esc(it.region || "")}</span>
            <span class="nc-cat">${esc(cat)}</span>
            ${translatedBadge}
            <span class="nc-time">${timeAgo(it.date)}</span>
          </div>
          ${title}
          ${summary}
        </div>
      </a>`;
    })
    .join("");
}


// ===== Source Health =====
function renderSourceHealth() {
  const sectionSources = state.data.sources.filter((source) => source.section === state.section);
  const online = sectionSources.filter((source) => source.ok).length;
  const failed = sectionSources.length - online;

  const tags = sectionSources
    .map((source) => {
      const stateClass = source.ok ? "" : " dead";
      const count = Number.isFinite(source.count) ? `${source.count} 条` : "";
      const detail = source.ok ? `${count || "在线"}` : `抓取失败：${source.error || "未知错误"}`;
      return `<a class="src-tag${stateClass}" href="${safeUrl(source.home)}" target="_blank" rel="noopener" title="${esc(detail)}">
        <span class="src-dot"></span>
        <span>${esc(source.name)}</span>
        <small>${esc(count)}</small>
      </a>`;
    })
    .join("");

  sourceHealth.innerHTML = `
    <summary>
      <span>信源状态</span>
      <strong>${online}/${sectionSources.length} 在线</strong>
      ${failed ? `<em>${failed} 个异常</em>` : ""}
      <span class="source-health-hint">展开查看</span>
    </summary>
    <div class="src-grid">${tags}</div>`;
}

// ===== Nav Grid (实时导航) =====
function renderNavGrid() {
  const navLinks = (state.data && state.data.navLinks) || [];

  navGrid.innerHTML = navLinks
    .map((group) => {
      const links = (group.items || [])
        .map(
          (l) => `<a class="nav-link-card" href="${safeUrl(l.url)}" target="_blank" rel="noopener">
            <div class="nl-name">${esc(l.name)}</div>
            <div class="nl-desc">${esc(l.desc)}</div>
            <div class="nl-domain">${esc(new URL(l.url).hostname)}</div>
          </a>`
        )
        .join("");
      return `<div class="nav-group">
        <div class="nav-group-title">${esc(group.cat)}</div>
        <div class="nav-links">${links}</div>
      </div>`;
    })
    .join("");
}

// ===== Search =====
searchInput.addEventListener("input", (e) => {
  state.q = e.target.value;
  state.visibleCount = PAGE_SIZE;
  renderFeed();
});

loadMoreBtn.addEventListener("click", () => {
  state.visibleCount += PAGE_SIZE;
  renderFeed();
});

// ===== Refresh =====
$("#refreshBtn").addEventListener("click", loadData);

// ===== Mobile menu =====
menuToggle.addEventListener("click", () => {
  sidebar.classList.toggle("open");
  let overlay = $("#sidebarOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sidebarOverlay";
    overlay.className = "sidebar-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", () => {
      sidebar.classList.remove("open");
      overlay.classList.remove("active");
    });
  }
  overlay.classList.toggle("active", sidebar.classList.contains("open"));
});

// ===== Keyboard shortcuts =====
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const keys = { "1": "ai", "2": "china", "3": "world", "4": "nav" };
  const sec = keys[e.key];
  if (sec && state.data) {
    state.section = sec;
    state.q = "";
    state.catFilter = "all";
    state.visibleCount = PAGE_SIZE;
    searchInput.value = "";
    switchSection();
  }
  if (e.key === "/") { e.preventDefault(); searchInput.focus(); }
});

// ===== Data Loading =====
async function loadData() {
  try {
    const res = await fetch("./data.json?_=" + Date.now());
    const data = await res.json();
    state.data = data;

    const gen = new Date(data.generatedAt);
    sbUpdated.textContent = "更新 " + gen.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

    buildSidebar();
    switchSection();
  } catch (e) {
    statsBar.innerHTML = `<div class="stat-card"><span style="color:var(--red)">数据加载失败: ${esc(e.message)}</span></div>`;
  }
}

// ===== Init =====
loadData();
