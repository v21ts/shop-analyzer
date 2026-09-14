/**
 * Shop Analyzer v1.9 — competitive pricing intelligence
 * High-end client-side implementation
 */

const CONFIG = {
  maxShopifyPages: 6,
  maxWooPages: 5,
  matchMinScore: 0.286,
  matchAutoConfirm: 0.52,
  stopWords: new Set(["the","a","an","and","or","for","with","of","in","to","by","set","pack","new","sale","der","die","das","und","oder","ein","eine","mit","von","zu","im","am","aus","il","la","lo","gli","le","di","da","per","bio","ml","g"]),
};


/* ---------- Plans / freemium ---------- */
const PLAN_LIMITS = {
  free: {
    competitors: 1,
    matchesShown: 15,
    watchlist: 3,
    scheduledWatch: false,
    aiPerDay: 3,
  },
  pro: {
    competitors: 25,
    matchesShown: 500,
    watchlist: 50,
    scheduledWatch: true,
    aiPerDay: 9999,
  },
};

/** Simple offline license check — replace with server validation when you sell at scale */
const VALID_LICENSE_PREFIXES = ["SA-PRO-", "SA-LIFE-", "SA-YR-"];

function isValidLicenseFormat(key) {
  const k = String(key || "").trim().toUpperCase();
  if (k.length < 12 || k.length > 64) return false;
  if (!VALID_LICENSE_PREFIXES.some(p => k.startsWith(p))) return false;
  // checksum: sum of char codes % 97 === last 2 digits as int (optional soft check)
  const body = k.replace(/[^A-Z0-9]/g, "");
  if (body.length < 10) return false;
  return true;
}

async function getPlan() {
  const { licenseKey, planOverride } = await chrome.storage.local.get(["licenseKey", "planOverride"]);
  if (planOverride === "pro") return "pro";
  if (licenseKey && isValidLicenseFormat(licenseKey)) return "pro";
  return "free";
}

async function getLimits() {
  const plan = await getPlan();
  return { plan, ...(PLAN_LIMITS[plan] || PLAN_LIMITS.free) };
}

async function refreshPlanUI() {
  const { plan, ...lim } = await getLimits();
  const badge = qs("plan-badge");
  if (badge) {
    badge.textContent = plan === "pro" ? "Pro" : "Free";
    badge.className = "badge" + (plan === "pro" ? " green" : "");
  }
  const summary = qs("plan-summary");
  if (summary) {
    summary.textContent = plan === "pro"
      ? `Pro · up to ${lim.competitors} competitors · ${lim.watchlist} watches · scheduled alerts`
      : `Free · ${lim.competitors} competitor · ${lim.matchesShown} moves · ${lim.watchlist} watches · ${lim.aiPerDay} AI/day`;
  }
  qs("plan-free-box")?.classList.toggle("hidden", plan === "pro");
  qs("plan-upgrade-box")?.classList.add("hidden");
  qs("plan-pro-box")?.classList.toggle("hidden", plan !== "pro");
  if (plan === "pro") {
    qs("plan-free-box")?.classList.add("hidden");
  }
  // scheduled interval only for pro
  const iv = qs("watch-interval");
  if (iv) iv.disabled = plan !== "pro";
}

async function activateLicense() {
  const input = qs("license-key");
  const key = (input?.value || "").trim();
  if (!isValidLicenseFormat(key)) {
    setStatus("license-status", "Invalid key format. Use the key from your purchase email (SA-PRO-…).", "error");
    return;
  }
  await chrome.storage.local.set({ licenseKey: key.toUpperCase() });
  setStatus("license-status", "Pro activated — thank you!", "ok");
  await refreshPlanUI();
  renderMoves();
  renderWatchList();
}

async function deactivateLicense() {
  await chrome.storage.local.remove(["licenseKey", "planOverride"]);
  await refreshPlanUI();
  setStatus("license-status", "Back on Free plan", "ok");
}

async function countAiToday() {
  const { aiUsage } = await chrome.storage.local.get("aiUsage");
  const day = new Date().toISOString().slice(0, 10);
  if (!aiUsage || aiUsage.day !== day) return 0;
  return aiUsage.count || 0;
}

async function bumpAiUsage() {
  const day = new Date().toISOString().slice(0, 10);
  const { aiUsage } = await chrome.storage.local.get("aiUsage");
  const count = (aiUsage && aiUsage.day === day) ? (aiUsage.count || 0) + 1 : 1;
  await chrome.storage.local.set({ aiUsage: { day, count } });
  return count;
}


const SYSTEM_PROMPT = `You are a senior e-commerce pricing strategist. You receive:
1. Merchant catalog (prices, compare-at, ratings)
2. Competitor catalogs
3. User-confirmed product matches with price deltas and suggested prices
4. Pre-computed competitive snapshot (avg gap, % overpriced, etc.)
5. Optional previous price snapshot

Produce 3–6 prioritized, specific recommendations.

Rules:
- Cite real numbers from the data in every recommendation.
- Prefer confirmed matches and the competitive snapshot.
- Impact = RANGE only (e.g. "6–12%"). Metric: conversion_rate | revenue | aov. Unit: percent | usd_per_month.
- One-sentence basis. Confidence: high | medium | low (be honest).
- If data is thin, say so.

Return ONLY valid JSON, no markdown:
{
  "recommendations": [
    {
      "scope": "shop" | "product",
      "product_ref": "<name or null>",
      "title": "<short>",
      "detail": "<1-2 sentences with numbers>",
      "estimated_impact": {
        "metric": "conversion_rate" | "revenue" | "aov",
        "range_low": <number>,
        "range_high": <number>,
        "unit": "percent" | "usd_per_month",
        "basis": "<sentence>"
      },
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;

/* ---------- State ---------- */
let lastOwnData = null;
let competitors = [];
let autoMatches = [];
let confirmedKeys = new Set();
let previousSnapshot = null;
let currentInsights = null;
let watchList = []; // [{ key, ownName, ownPrice, compPrice, suggest, shopUrl, notedAt }]
let manualOwnPick = null;
let activeCategories = null; // null = all, Set of category keys when filtering

document.addEventListener("DOMContentLoaded", init);

const MODELS = {
  grok: [
    { id: "grok-4.3", label: "Grok 4.3 — fast & capable" },
    { id: "grok-4.5", label: "Grok 4.5 — strong reasoning" },
    { id: "grok-4.6", label: "Grok 4.6 — frontier" },
  ],
  claude: [
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fast & cheap" },
    { id: "claude-sonnet-5", label: "Sonnet 5 — balanced" },
    { id: "claude-opus-5", label: "Opus 5 — highest quality" },
  ],
  openai: [
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini — fast & cheap" },
    { id: "gpt-4.1", label: "GPT-4.1 — strong analysis" },
    { id: "gpt-5-mini", label: "GPT-5 Mini — efficient" },
    { id: "gpt-5", label: "GPT-5 — flagship" },
  ],
  gemini: [
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite — cheapest" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — balanced" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — deep analysis" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash — newer fast" },
  ],
  deepseek: [
    { id: "deepseek-flash", label: "DeepSeek Flash — fast & cheap" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro — stronger" },
  ],
};

const PROVIDER_META = {
  claude: { keyField: "claudeKey", label: "Claude" },
  grok: { keyField: "xaiKey", label: "Grok" },
  openai: { keyField: "openaiKey", label: "OpenAI" },
  gemini: { keyField: "geminiKey", label: "Gemini" },
  deepseek: { keyField: "deepseekKey", label: "DeepSeek" },
};

async function init() {
  const stored = await chrome.storage.local.get([
    "claudeKey", "xaiKey", "openaiKey", "geminiKey", "deepseekKey",
    "apiKey", "provider", "model", "lastAnalysis", "strategy"
  ]);
  // Migrate old single apiKey → claudeKey
  if (stored.apiKey && !stored.claudeKey) {
    await chrome.storage.local.set({ claudeKey: stored.apiKey });
    stored.claudeKey = stored.apiKey;
  }
  if (stored.claudeKey) showKeySaved("claude");
  if (stored.xaiKey) showKeySaved("xai");
  if (stored.openaiKey) showKeySaved("openai");
  if (stored.geminiKey) showKeySaved("gemini");
  if (stored.deepseekKey) showKeySaved("deepseek");

  const provider = stored.provider || "grok";
  qs("provider-select").value = provider;
  fillModels(provider, stored.model);
  if (stored.strategy) qs("strategy").value = stored.strategy;
  if (stored.lastAnalysis) {
    previousSnapshot = stored.lastAnalysis;
    // Restore UI so panel stays useful after tab switches / reopen
    try {
      const a = stored.lastAnalysis;
      if (a.own) {
        lastOwnData = a.own;
        competitors = a.competitors || [];
        autoMatches = a.autoMatches || [];
        confirmedKeys = new Set(a.confirmedKeys || []);
        currentInsights = a.insights || null;
        renderKPIs(computeKPIs(a.own.products));
        renderProducts(a.own.products);
        renderCompList();
        renderCategoryFilter();
        if (competitors.length) {
          renderMoves();
          renderManualPair();
          computeAndRenderInsights();
          renderTruth();
        }
        qs("competitor-section")?.classList.remove("hidden");
        qs("ai-section")?.classList.remove("hidden");
        setStatus("status", `Restored · ${a.own.products.length} products · ${timeAgo(a.savedAt || a.own.scrapedAt)}`, "ok");
      }
    } catch (e) {
      console.warn("Could not restore analysis", e);
    }
  }

  ["claude", "xai", "openai", "gemini", "deepseek"].forEach(p => {
    bind(`save-${p}-key`, () => saveProviderKey(p));
    bind(`change-${p}-key`, () => {
      qs(`${p}-key-saved`)?.classList.add("hidden");
      qs(`${p}-key-setup`)?.classList.remove("hidden");
    });
  });
  bind("analyze-btn", runAnalysis);
  bind("add-comp-btn", addCompetitor);
  bind("recommend-btn", runRecommendations);
  bind("select-all-matches", () => setAllMatches(true));
  bind("select-none-matches", () => setAllMatches(false));
  bind("export-csv", exportCSV);
  bind("export-report", exportReport);
  bind("clear-data", clearSavedData);

  qs("provider-select").addEventListener("change", e => {
    const p = e.target.value;
    chrome.storage.local.set({ provider: p });
    fillModels(p);
  });
  qs("model-select").addEventListener("change", e => chrome.storage.local.set({ model: e.target.value }));
  qs("strategy").addEventListener("change", e => {
    const v = e.target.value;
    chrome.storage.local.set({ strategy: v });
    qs("custom-sim")?.classList.toggle("hidden", v !== "custom");
    renderMoves();
    computeAndRenderInsights();
    renderTruth();
  });
  const range = qs("custom-pct");
  if (range) {
    range.addEventListener("input", () => {
      const v = parseInt(range.value, 10);
      qs("custom-pct-label").textContent = (v > 0 ? "+" : "") + v + "%";
      renderMoves();
      computeAndRenderInsights();
      renderTruth();
    });
  }
  bind("export-fix", exportFix);
  bind("watch-check-now", runWatchCheckNow);
  bind("show-upgrade", () => {
    qs("plan-upgrade-box")?.classList.remove("hidden");
    qs("plan-free-box")?.classList.add("hidden");
  });
  bind("hide-upgrade", () => {
    qs("plan-upgrade-box")?.classList.add("hidden");
    qs("plan-free-box")?.classList.remove("hidden");
  });
  bind("activate-license", activateLicense);
  bind("deactivate-license", deactivateLicense);
  refreshPlanUI();
  qs("watch-interval")?.addEventListener("change", async (e) => {
    const lim = await getLimits();
    if (!lim.scheduledWatch) {
      setStatus("watch-status", "Scheduled checks are Pro. Use Check now on Free, or upgrade.", "error");
      e.target.value = "360";
      return;
    }
    const minutes = parseInt(e.target.value, 10) || 360;
    chrome.runtime.sendMessage({ type: "SET_WATCH_INTERVAL", minutes });
    chrome.storage.local.set({ watchIntervalMin: minutes });
  });
  bind("filter-all", () => {
    if (!lastOwnData) return;
    activeCategories = new Set(collectCategories(lastOwnData.products).map(e => e[0]));
    renderCategoryFilter();
    rebuildMatches();
    renderManualPair();
  });
  bind("filter-none", () => {
    activeCategories = new Set();
    renderCategoryFilter();
    rebuildMatches();
    renderManualPair();
  });
  const persistMargin = () => {
    chrome.storage.local.set({
      costPct: qs("cost-pct")?.value || "",
      minMargin: qs("min-margin")?.value || "30",
    });
    renderMoves();
    renderTruth();
  };
  qs("cost-pct")?.addEventListener("input", persistMargin);
  qs("min-margin")?.addEventListener("input", persistMargin);
  chrome.storage.local.get(["watchList", "costPct", "minMargin"]).then(s => {
    watchList = s.watchList || [];
    if (s.costPct != null && qs("cost-pct")) qs("cost-pct").value = s.costPct;
    if (s.minMargin != null && qs("min-margin")) qs("min-margin").value = s.minMargin;
    renderWatchList();
  });
}

function fillModels(provider, preferred) {
  const sel = qs("model-select");
  const list = MODELS[provider] || MODELS.grok;
  sel.innerHTML = list.map(m => `<option value="${m.id}">${m.label}</option>`).join("");
  if (preferred && list.some(m => m.id === preferred)) sel.value = preferred;
  else sel.value = list[0].id;
  chrome.storage.local.set({ model: sel.value });
}

function bind(id, fn) { const el = qs(id); if (el) el.addEventListener("click", fn); }
function qs(id) { return document.getElementById(id); }

/* ---------- API keys ---------- */
async function saveProviderKey(which) {
  const input = qs(`${which}-key`);
  if (!input) return;
  const key = input.value.trim();
  if (!key) { input.placeholder = "Paste your key first"; return; }
  if (which === "claude" && !key.startsWith("sk-ant-")) {
    setStatus("status", "Claude key should start with sk-ant-", "error");
    return;
  }
  const storeMap = {
    claude: "claudeKey", xai: "xaiKey", openai: "openaiKey",
    gemini: "geminiKey", deepseek: "deepseekKey",
  };
  await chrome.storage.local.set({ [storeMap[which]]: key });
  showKeySaved(which);
}
function showKeySaved(which) {
  const setup = qs(`${which}-key-setup`);
  const saved = qs(`${which}-key-saved`);
  if (setup) setup.classList.add("hidden");
  if (saved) saved.classList.remove("hidden");
}

/* ---------- Analyze own shop ---------- */
async function runAnalysis() {
  setStatus("status", "Scraping catalog…", "loading");
  try {
    const data = await scrapeActiveTab();
    data.scrapedAt = Date.now();
    lastOwnData = data;
    showHistoryNote(data);
    activeCategories = null;
    renderKPIs(computeKPIs(data.products));
    renderProducts(data.products);
    renderCategoryFilter();
    qs("competitor-section")?.classList.remove("hidden");
    qs("ai-section")?.classList.remove("hidden");
    setStatus("status", `${data.products.length} products · ${data.platform} · ${timeAgo(data.scrapedAt)}`, "ok");
    rebuildMatches();
    await persistAnalysis();
  } catch (err) {
    setStatus("status", err.message, "error");
  }
}

function showHistoryNote(data) {
  const note = qs("history-note");
  if (!note) return;
  if (!previousSnapshot?.own || previousSnapshot.own.shopUrl !== data.shopUrl) {
    note?.classList.add("hidden");
    return;
  }
  const prevMap = new Map(previousSnapshot.own.products.map(p => [normTitle(p.name), p.price]));
  let changed = 0, up = 0, down = 0;
  for (const p of data.products) {
    const prev = prevMap.get(normTitle(p.name));
    if (prev != null && Math.abs(prev - p.price) > 0.009) {
      changed++;
      if (p.price > prev) up++; else down++;
    }
  }
  note.textContent = changed
    ? `vs last run: ${changed} price changes (${up}↑ ${down}↓)`
    : "No price changes vs last analysis";
  note?.classList.remove("hidden");
}

/* ---------- Competitors ---------- */
async function addCompetitor() {
  const input = qs("comp-url");
  let url = input.value.trim();
  if (!url) { setStatus("comp-status", "Enter a URL", "error"); return; }
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const lim = await getLimits();
  if (competitors.length >= lim.competitors) {
    setStatus("comp-status", `Free plan: max ${lim.competitors} competitor. Upgrade to Pro for more.`, "error");
    qs("plan-upgrade-box")?.classList.remove("hidden");
    qs("plan-free-box")?.classList.add("hidden");
    return;
  }

  const btn = qs("add-comp-btn");
  btn.disabled = true;
  setStatus("comp-status", "Opening tab & scraping…", "loading");

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitTab(tabId, 20000);
    await sleep(1400);
    const data = await scrapeTab(tabId);
    data.scrapedAt = Date.now();
    const host = hostOf(data.shopUrl);
    competitors = competitors.filter(c => hostOf(c.shopUrl) !== host);
    competitors.push(data);
    input.value = "";
    renderCompList();
    rebuildMatches();
    await persistAnalysis();
    setStatus("comp-status", `${data.products.length} products from ${host}`, "ok");
  } catch (err) {
    setStatus("comp-status", err.message, "error");
  } finally {
    if (tabId != null) try { await chrome.tabs.remove(tabId); } catch (_) {}
    btn.disabled = false;
  }
}

function renderCompList() {
  const list = qs("comp-list");
  list.innerHTML = "";
  competitors.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `
      <div>
        <div style="font-weight:560">${esc(hostOf(c.shopUrl))}</div>
        <div class="meta">${c.products.length} products · ${esc(c.platform)} · ${timeAgo(c.scrapedAt)}</div>
      </div>
      <button class="secondary small" data-i="${i}">Remove</button>`;
    el.querySelector("button").onclick = () => {
      competitors.splice(i, 1);
      renderCompList();
      rebuildMatches();
      persistAnalysis();
    };
    list.appendChild(el);
  });
}

/* ---------- Matching ---------- */
function matchKey(m) {
  return `${m.ownName}|||${m.compUrl}|||${m.compName}`;
}

function collectCategories(products) {
  const counts = new Map();
  for (const p of products || []) {
    const cats = (p.categories && p.categories.length) ? p.categories : ["(Uncategorized)"];
    for (const c of cats) counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function ownProductsFiltered() {
  if (!lastOwnData) return [];
  const all = lastOwnData.products || [];
  if (!activeCategories || activeCategories.size === 0) {
    // empty set = nothing selected
    if (activeCategories && activeCategories.size === 0) return [];
    return all;
  }
  return all.filter(p => {
    const cats = p.categories || [];
    if (!cats.length) return activeCategories.has("(Uncategorized)");
    return cats.some(c => activeCategories.has(c));
  });
}

function updateFilterCount() {
  const el = qs("filter-count");
  if (!el || !lastOwnData) return;
  el.textContent = `${ownProductsFiltered().length} / ${lastOwnData.products.length} products in focus`;
}

function renderCategoryFilter() {
  const card = qs("filter-card");
  const box = qs("filter-chips");
  if (!card || !box || !lastOwnData) return;
  const entries = collectCategories(lastOwnData.products);
  card.classList.remove("hidden");
  if (activeCategories == null) {
    activeCategories = new Set(entries.map(e => e[0]));
  }
  box.innerHTML = entries.map(([name, n]) => {
    const on = activeCategories.has(name);
    return `<button type="button" class="chip${on ? " on" : ""}" data-cat="${String(name).replace(/"/g, "&quot;")}">${esc(clip(name, 28))}<span class="n">${n}</span></button>`;
  }).join("");
  box.querySelectorAll(".chip").forEach(btn => {
    btn.onclick = () => {
      const cat = btn.getAttribute("data-cat");
      if (activeCategories.has(cat)) activeCategories.delete(cat);
      else activeCategories.add(cat);
      renderCategoryFilter();
      rebuildMatches();
      renderManualPair();
      updateFilterCount();
    };
  });
  updateFilterCount();
}

function rebuildMatches() {
  if (!lastOwnData || !competitors.length) {
    qs("comparison-wrap")?.classList.add("hidden");
    qs("insights-card")?.classList.add("hidden");
    autoMatches = [];
    currentInsights = null;
    renderMoves();
    return;
  }
  autoMatches = findMatches(ownProductsFiltered(), competitors);
  const next = new Set();
  for (const m of autoMatches) {
    const k = matchKey(m);
    if (confirmedKeys.has(k) || m.score >= CONFIG.matchAutoConfirm) next.add(k);
  }
  confirmedKeys = next;
  renderMoves();
  renderManualPair();
  computeAndRenderInsights();
  renderTruth();
  qs("ai-section")?.classList.remove("hidden");
}

function getConfirmed() {
  return autoMatches.filter(m => confirmedKeys.has(matchKey(m)));
}

function suggestedPrice(compPrice, strategy, ownPrice) {
  const s = strategy || qs("strategy")?.value || "undercut5";
  let price;
  if (s === "undercut5") price = compPrice * 0.95;
  else if (s === "undercut10") price = compPrice * 0.90;
  else if (s === "premium5") price = compPrice * 1.05;
  else if (s === "premium10") price = compPrice * 1.10;
  else if (s === "custom") {
    const pct = parseInt(qs("custom-pct")?.value || "-5", 10);
    price = compPrice * (1 + pct / 100);
  } else price = compPrice; // median

  const floor = marginFloor(ownPrice);
  if (floor != null && price < floor) return floor;
  return price;
}

/** @returns {number|null} minimum allowed sell price based on cost% and min margin */
function marginFloor(ownPrice) {
  if (ownPrice == null || !(ownPrice > 0)) return null;
  const costPctEl = qs("cost-pct");
  const marginEl = qs("min-margin");
  if (!costPctEl || costPctEl.value === "" || costPctEl.value == null) return null;
  const costPct = parseFloat(costPctEl.value);
  const minMargin = parseFloat(marginEl?.value || "30");
  if (isNaN(costPct) || costPct < 0 || costPct >= 100) return null;
  if (isNaN(minMargin) || minMargin < 0 || minMargin >= 100) return null;
  const cost = ownPrice * (costPct / 100);
  const floor = cost / (1 - minMargin / 100);
  return floor;
}

function isFloored(compPrice, strategy, ownPrice) {
  const s = strategy || qs("strategy")?.value || "undercut5";
  let raw;
  if (s === "undercut5") raw = compPrice * 0.95;
  else if (s === "undercut10") raw = compPrice * 0.90;
  else if (s === "premium5") raw = compPrice * 1.05;
  else if (s === "premium10") raw = compPrice * 1.10;
  else if (s === "custom") {
    const pct = parseInt(qs("custom-pct")?.value || "-5", 10);
    raw = compPrice * (1 + pct / 100);
  } else raw = compPrice;
  const floor = marginFloor(ownPrice);
  return floor != null && raw < floor - 0.009;
}

function moveReason(m, suggest) {
  const gap = m.ownPrice - suggest;
  if (Math.abs(gap) < 0.5) return "Already near the target — hold.";
  if (gap > 0) return `You're $${gap.toFixed(2)} above target. Lowering can recover conversion.`;
  return `You're $${Math.abs(gap).toFixed(2)} under target. Room to raise margin.`;
}

function renderMatchList() { renderMoves(); }

async function renderMoves() {
  const lim = await getLimits();
  const list = qs("moves-list");
  const card = qs("moves-card");
  const stratCard = qs("strategy-card");
  if (!list) return;

  if (!autoMatches.length) {
    card?.classList.remove("hidden");
    stratCard?.classList.add("hidden");
    const mc = qs("moves-count"); if (mc) mc.textContent = "0";
    list.innerHTML = `<div class="empty">No automatic matches yet.<br/>Use <strong>Pair products manually</strong> above if the names differ.</div>`;
    return;
  }
  card?.classList.remove("hidden");
  stratCard?.classList.remove("hidden");
  qs("comparison-wrap")?.classList.add("hidden");

  const confirmed = getConfirmed();
  const mc = qs("moves-count"); if (mc) mc.textContent = String(confirmed.length);
  const strategy = qs("strategy")?.value || "undercut5";
  list.innerHTML = "";

  // Sort: biggest absolute gap to target first among confirmed, then unconfirmed
  const ranked = [...autoMatches].sort((a, b) => {
    const sa = suggestedPrice(a.compPrice, strategy, a.ownPrice);
    const sb = suggestedPrice(b.compPrice, strategy, b.ownPrice);
    const ga = Math.abs(a.ownPrice - sa);
    const gb = Math.abs(b.ownPrice - sb);
    const ca = confirmedKeys.has(matchKey(a)) ? 1 : 0;
    const cb = confirmedKeys.has(matchKey(b)) ? 1 : 0;
    if (cb !== ca) return cb - ca;
    return gb - ga;
  });

  ranked.slice(0, lim.matchesShown).forEach(m => {
    const k = matchKey(m);
    const on = confirmedKeys.has(k);
    const suggest = suggestedPrice(m.compPrice, strategy, m.ownPrice);
    const gap = m.ownPrice - suggest;
    const actionClass = Math.abs(gap) < 0.5 ? "" : gap > 0 ? "down" : "up";
    const actionVerb = Math.abs(gap) < 0.5 ? "Hold" : gap > 0 ? "Lower to" : "Raise to";
    const watched = watchList.some(w => w.key === k);
    const floored = isFloored(m.compPrice, strategy, m.ownPrice);

    const el = document.createElement("div");
    el.className = "move" + (on ? "" : " dim");
    el.innerHTML = `
      <div class="top">
        <div>
          <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
            <input type="checkbox" ${on ? "checked" : ""} style="margin-top:3px;accent-color:var(--blue)" />
            <div class="name">${esc(clip(m.ownName, 48))}</div>
          </label>
        </div>
        <button class="star ${watched ? "on" : ""}" title="Watch" data-key="${esc(k)}">${watched ? "★" : "☆"}</button>
      </div>
      <div class="action ${actionClass}">
        <strong>${actionVerb} $${suggest.toFixed(2)}</strong>${floored ? ' <span class="floored">margin floor</span>' : ""}
        <div class="why">${esc(moveReason(m, suggest))}${floored ? " Floor applied so margin stays above your minimum." : ""}</div>
      </div>
      <div class="prices">
        Yours $${m.ownPrice.toFixed(2)} · Comp $${m.compPrice.toFixed(2)}
        · Δ ${m.delta >= 0 ? "+" : ""}$${m.delta.toFixed(2)} (${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(0)}%)
        · ${esc(hostOf(m.compUrl))} · match ${(m.score * 100).toFixed(0)}%
      </div>`;
    const cb = el.querySelector('input[type="checkbox"]');
    cb.onchange = () => {
      if (cb.checked) confirmedKeys.add(k); else confirmedKeys.delete(k);
      el.classList.toggle("dim", !cb.checked);
      qs("moves-count").textContent = String(getConfirmed().length);
      computeAndRenderInsights();
      renderTruth();
      persistAnalysis();
    };
    el.querySelector(".star").onclick = (e) => {
      e.preventDefault();
      toggleWatch(m, suggest);
    };
    list.appendChild(el);
  });
  renderTruth();
}

async function toggleWatch(m, suggest) {
  const k = matchKey(m);
  const idx = watchList.findIndex(w => w.key === k);
  if (idx >= 0) watchList.splice(idx, 1);
  else {
    const lim = await getLimits();
    if (watchList.length >= lim.watchlist) {
      setStatus("status", `Free plan: max ${lim.watchlist} watched items. Upgrade to Pro.`, "error");
      qs("plan-upgrade-box")?.classList.remove("hidden");
      qs("plan-free-box")?.classList.add("hidden");
      return;
    }
    watchList.push({
      key: k,
      ownName: m.ownName,
      ownPrice: m.ownPrice,
      compName: m.compName,
      compPrice: m.compPrice,
      lastSeenCompPrice: m.compPrice,
      suggest: suggest,
      shopUrl: lastOwnData?.shopUrl,
      compUrl: m.compUrl,
      notedAt: Date.now(),
    });
  }
  chrome.storage.local.set({ watchList });
  renderMoves();
  renderWatchList();
}


function renderManualPair() {
  const card = qs("manual-card");
  if (!card) return;
  if (!lastOwnData || !competitors.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const ownBox = qs("manual-own");
  const compBox = qs("manual-comp");
  if (!ownBox || !compBox) return;

  const already = new Set(autoMatches.map(m => normTitle(m.ownName)));
  const ownPool = ownProductsFiltered();
  ownBox.innerHTML = ownPool.map((p, i) => {
    const paired = already.has(normTitle(p.name));
    return `<button type="button" class="pickable${manualOwnPick === i ? " selected" : ""}" data-own="${i}" ${paired ? "disabled style=opacity:.45" : ""}>
      ${esc(clip(p.name, 36))}<span class="pr">$${p.price.toFixed(2)}</span>
    </button>`;
  }).join("");
  renderManualPair._ownPool = ownPool;

  const compProducts = [];
  competitors.forEach((c, ci) => {
    c.products.forEach((p, pi) => compProducts.push({ c, ci, p, pi }));
  });
  const usedComp = new Set(autoMatches.map(m => hostOf(m.compUrl) + "||" + normTitle(m.compName)));
  compBox.innerHTML = compProducts.map((row, idx) => {
    const key = hostOf(row.c.shopUrl) + "||" + normTitle(row.p.name);
    const used = usedComp.has(key);
    return `<button type="button" class="pickable" data-comp="${idx}" ${used ? "disabled style=opacity:.45" : ""}>
      ${esc(clip(row.p.name, 32))} <span style="color:var(--muted);font-size:10px">${esc(hostOf(row.c.shopUrl))}</span>
      <span class="pr">$${row.p.price.toFixed(2)}</span>
    </button>`;
  }).join("");

  ownBox.querySelectorAll("button[data-own]").forEach(btn => {
    btn.onclick = () => {
      manualOwnPick = parseInt(btn.dataset.own, 10);
      renderManualPair();
      setStatus("manual-status", "Now click a competitor product to pair", "ok");
    };
  });
  // store compProducts on function for second click
  renderManualPair._comp = compProducts;
  compBox.querySelectorAll("button[data-comp]").forEach(btn => {
    btn.onclick = () => {
      if (manualOwnPick == null) {
        setStatus("manual-status", "Select your product first", "error");
        return;
      }
      const row = renderManualPair._comp[parseInt(btn.dataset.comp, 10)];
      const own = (renderManualPair._ownPool || ownProductsFiltered())[manualOwnPick];
      if (!own || !row) return;
      const m = {
        ownName: own.name, ownPrice: own.price,
        compName: row.p.name, compPrice: row.p.price, compUrl: row.c.shopUrl,
        score: 1, delta: own.price - row.p.price,
        pct: row.p.price ? ((own.price - row.p.price) / row.p.price) * 100 : 0,
        manual: true,
      };
      // replace existing match for same own product if any
      autoMatches = autoMatches.filter(x => normTitle(x.ownName) !== normTitle(own.name));
      autoMatches.push(m);
      confirmedKeys.add(matchKey(m));
      manualOwnPick = null;
      setStatus("manual-status", `Paired “${clip(own.name, 24)}” ↔ “${clip(row.p.name, 24)}”`, "ok");
      renderMoves();
      renderManualPair();
      computeAndRenderInsights();
      renderTruth();
      persistAnalysis();
    };
  });

  const hint = qs("manual-hint");
  if (hint) {
    hint.textContent = autoMatches.length
      ? "Add more pairs if needed, or review recommended moves below."
      : "Names didn’t match automatically (common for craft products). Click your product, then the competitor’s equivalent.";
  }
}

function renderWatchList() {
  const card = qs("watch-card");
  const list = qs("watch-list");
  const empty = qs("watch-empty");
  if (!card) return;
  card.classList.remove("hidden");

  chrome.storage.local.get(["watchAlerts", "watchLastCheckAt", "watchLastResult", "watchLastError", "watchIntervalMin"]).then((s) => {
    const st = qs("watch-status");
    if (st) {
      if (s.watchLastError) setStatus("watch-status", s.watchLastError, "error");
      else if (s.watchLastCheckAt) {
        const r = s.watchLastResult || {};
        setStatus("watch-status", `Last check ${timeAgo(s.watchLastCheckAt)} · ${r.checked || 0} prices · ${r.changes || 0} changes`, "ok");
      } else {
        setStatus("watch-status", "Not checked yet — click Check now or wait for the schedule", "ok");
      }
    }
    const iv = qs("watch-interval");
    if (iv && s.watchIntervalMin) iv.value = String(s.watchIntervalMin);

    const alertsBox = qs("watch-alerts");
    if (alertsBox) {
      const alerts = (s.watchAlerts || []).slice(0, 5);
      alertsBox.innerHTML = alerts.map((c) => {
        const cls = c.dir === "dropped" ? "down" : "up";
        return `<div class="alert-row ${cls}">
          <strong>${esc(clip(c.ownName, 28))}</strong>
          competitor ${c.dir} $${Number(c.from).toFixed(2)} → $${Number(c.to).toFixed(2)}
          (${c.pct >= 0 ? "+" : ""}${Number(c.pct).toFixed(1)}%)
          <span style="color:var(--muted)"> · ${timeAgo(c.at)}</span>
        </div>`;
      }).join("");
    }
  });

  if (!watchList.length) {
    if (list) list.innerHTML = "";
    empty?.classList.remove("hidden");
    const wc = qs("watch-count"); if (wc) wc.textContent = "0";
    return;
  }
  empty?.classList.add("hidden");
  const wc = qs("watch-count"); if (wc) wc.textContent = String(watchList.length);
  if (!list) return;
  list.innerHTML = watchList.map((w, i) => {
    const seen = w.lastSeenCompPrice != null ? w.lastSeenCompPrice : w.compPrice;
    const ch = w.lastChange;
    let changeLine = "";
    if (ch) {
      changeLine = ` · <span style="color:${ch.dir === "dropped" ? "var(--green)" : "var(--red)"}">${ch.dir} to $${Number(ch.to).toFixed(2)}</span>`;
    }
    return `<div class="list-item">
      <div>
        <div style="font-weight:560">${esc(clip(w.ownName, 40))}</div>
        <div class="meta">Yours $${Number(w.ownPrice).toFixed(2)} · Comp $${Number(seen).toFixed(2)}${changeLine}
        ${w.lastCheckedAt ? " · checked " + timeAgo(w.lastCheckedAt) : ""}</div>
      </div>
      <button class="secondary small" data-i="${i}">Remove</button>
    </div>`;
  }).join("");
  list.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      watchList.splice(parseInt(btn.dataset.i, 10), 1);
      chrome.storage.local.set({ watchList });
      renderWatchList();
      renderMoves();
    };
  });
}

async function runWatchCheckNow() {
  setStatus("watch-status", "Checking competitor prices…", "loading");
  try {
    const res = await chrome.runtime.sendMessage({ type: "RUN_WATCH_CHECK" });
    if (!res?.ok) throw new Error(res?.error || "Check failed");
    const stored = await chrome.storage.local.get("watchList");
    watchList = stored.watchList || watchList;
    renderWatchList();
    setStatus("watch-status", `Checked ${res.checked || 0} · ${res.changes || 0} change(s)`, res.changes ? "ok" : "ok");
  } catch (e) {
    setStatus("watch-status", e.message, "error");
  }
}


function renderTruth() {
  const card = qs("truth-card");
  if (!card) return;
  const confirmed = getConfirmed();
  if (!confirmed.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const strategy = qs("strategy")?.value || "undercut5";
  const gaps = confirmed.map(m => {
    const s = suggestedPrice(m.compPrice, strategy, m.ownPrice);
    return ((m.ownPrice - s) / (s || 1)) * 100;
  });
  const avgGap = avg(gaps);
  const over = confirmed.filter((m, i) => gaps[i] > 2).length;
  const under = confirmed.filter((m, i) => gaps[i] < -2).length;
  const overPct = (over / confirmed.length) * 100;

  const big = qs("truth-big");
  const headline = qs("truth-headline");
  const sub = qs("truth-sub");
  const meta = qs("truth-meta");

  const sign = avgGap >= 0 ? "+" : "";
  if (big) {
    big.textContent = `${sign}${avgGap.toFixed(1)}%`;
    big.className = "big " + (avgGap > 3 ? "neg" : avgGap < -3 ? "pos" : "");
  }
  card.className = "truth " + (avgGap > 5 ? "bad" : avgGap < -5 ? "ok" : "warn");

  if (avgGap > 5) {
    if (headline) headline.textContent = "You're priced above the market";
    if (sub) sub.textContent = `On ${over} of ${confirmed.length} matched products you're higher than the target. Lowering key items can win back conversion.`;
  } else if (avgGap < -5) {
    if (headline) headline.textContent = "You're priced below the market";
    if (sub) sub.textContent = `You have room to raise prices on ${under} products without losing competitiveness.`;
  } else {
    if (headline) headline.textContent = "You're close to the market";
    if (sub) sub.textContent = `Most matched products sit near your target strategy. Fine-tune the outliers below.`;
  }
  if (meta) meta.textContent = `${confirmed.length} confirmed matches · ${overPct.toFixed(0)}% above target · strategy: ${strategyLabel(strategy)}`;
}

function strategyLabel(s) {
  const map = {
    median: "match median", undercut5: "undercut 5%", undercut10: "undercut 10%",
    premium5: "premium +5%", premium10: "premium +10%", custom: "custom",
  };
  return map[s] || s;
}

function exportFix() {
  const strategy = qs("strategy")?.value || "undercut5";
  const rows = [["Product", "Current price", "Suggested price", "Change $", "Change %", "Competitor price", "Competitor", "Action"]];
  for (const m of getConfirmed()) {
    const s = suggestedPrice(m.compPrice, strategy, m.ownPrice);
    const d = s - m.ownPrice;
    const action = Math.abs(d) < 0.5 ? "Hold" : d < 0 ? "Lower" : "Raise";
    rows.push([
      m.ownName, m.ownPrice.toFixed(2), s.toFixed(2), d.toFixed(2),
      m.ownPrice ? ((d / m.ownPrice) * 100).toFixed(1) : "0",
      m.compPrice.toFixed(2), hostOf(m.compUrl), action,
    ]);
  }
  downloadBlob(rowsToCSV(rows), "pricing-fixes.csv", "text/csv");
}

function setAllMatches(on) {
  confirmedKeys = on ? new Set(autoMatches.map(matchKey)) : new Set();
  renderMoves();
  computeAndRenderInsights();
  renderTruth();
  persistAnalysis();
}

/* ---------- Competitive insights (pure JS — no AI) ---------- */
function computeAndRenderInsights() {
  const confirmed = getConfirmed();
  const box = qs("insights");
  if (!confirmed.length) {
    currentInsights = null;
    if (box) box.innerHTML = `<div class="empty" style="grid-column:1/-1">Confirm matches to see competitive snapshot.</div>`;
    return;
  }

  const deltas = confirmed.map(m => m.delta);
  const pcts = confirmed.map(m => m.pct);
  const avgDelta = avg(deltas);
  const avgPct = avg(pcts);
  const over = confirmed.filter(m => m.delta > 0.5).length;
  const under = confirmed.filter(m => m.delta < -0.5).length;
  const overPct = (over / confirmed.length) * 100;
  const medianComp = median(confirmed.map(m => m.compPrice));
  const medianOwn = median(confirmed.map(m => m.ownPrice));

  currentInsights = {
    matchCount: confirmed.length,
    avgDelta, avgPct, over, under, overPct, medianComp, medianOwn,
  };

  if (!box) return;

  const posClass = avgPct > 3 ? "bad" : avgPct < -3 ? "ok" : "warn";
  const overClass = overPct > 55 ? "bad" : overPct < 35 ? "ok" : "warn";

  box.innerHTML = `
    <div class="insight ${posClass}">
      <div class="label">Avg price gap</div>
      <div class="value">${avgPct >= 0 ? "+" : ""}${avgPct.toFixed(1)}%</div>
      <div class="sub">${avgDelta >= 0 ? "+" : ""}$${avgDelta.toFixed(2)} vs competitors</div>
    </div>
    <div class="insight ${overClass}">
      <div class="label">Overpriced share</div>
      <div class="value">${overPct.toFixed(0)}%</div>
      <div class="sub">${over} of ${confirmed.length} matches higher</div>
    </div>
    <div class="insight">
      <div class="label">Your median</div>
      <div class="value">$${medianOwn.toFixed(2)}</div>
      <div class="sub">across matched SKUs</div>
    </div>
    <div class="insight">
      <div class="label">Comp median</div>
      <div class="value">$${medianComp.toFixed(2)}</div>
      <div class="sub">${under} matches cheaper than you</div>
    </div>`;
}



/* ---------- Scraping bridge ---------- */
async function scrapeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:")) {
    throw new Error("Open a shop page first (not a browser internal page)");
  }
  return scrapeTab(tab.id);
}

async function scrapeTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapeInPage,
    args: [5, 5],
  });
  const payload = results?.[0]?.result;
  if (!payload) throw new Error("Script returned nothing — page may block injection");
  if (payload.error) throw new Error(payload.error);

  let products = [];
  if (payload.platform === "shopify") products = normalizeShopify(payload.raw);
  else if (payload.platform === "woocommerce") products = normalizeWoo(payload.raw);
  else if (payload.platform === "schema.org markup") products = normalizeJsonLd(payload.raw);
  else if (payload.platform === "dom-fallback") products = normalizeDom(payload.raw);
  else products = [];

  // Deduplicate by normalized name
  const seen = new Set();
  products = products.filter(p => {
    const k = normTitle(p.name);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!products.length) throw new Error("No products with prices found on this page");

  let shopUrl = "";
  try {
    const t = await chrome.tabs.get(tabId);
    shopUrl = t.url || "";
  } catch (_) {}

  return {
    shopUrl,
    platform: payload.platform,
    products,
    scrapedAt: Date.now(),
  };
}

function scrapeInPage(maxShopifyPages, maxWooPages) {
  return (async () => {
    // Shopify pagination
    try {
      let all = [];
      for (let page = 1; page <= maxShopifyPages; page++) {
        const res = await fetch(`${location.origin}/products.json?limit=250&page=${page}`);
        if (!res.ok) break;
        const data = await res.json();
        const batch = data.products || [];
        if (!batch.length) break;
        all = all.concat(batch);
        if (batch.length < 250) break;
      }
      if (all.length) return { platform: "shopify", raw: all };
    } catch (_) {}

    try {
      const res = await fetch(`${location.origin}/collections/all/products.json?limit=250`);
      if (res.ok) {
        const data = await res.json();
        if (data.products?.length) return { platform: "shopify", raw: data.products };
      }
    } catch (_) {}

    // WooCommerce
    try {
      let all = [];
      for (let page = 1; page <= maxWooPages; page++) {
        const res = await fetch(`${location.origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
        if (!res.ok) break;
        const data = await res.json();
        if (!Array.isArray(data) || !data.length) break;
        all = all.concat(data);
        if (data.length < 100) break;
      }
      if (all.length) return { platform: "woocommerce", raw: all };
    } catch (_) {}

    // JSON-LD
    try {
      const found = [];
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        const t = n["@type"];
        if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) found.push(n);
        if (n["@graph"]) walk(n["@graph"]);
        if (n.itemListElement) walk(n.itemListElement);
        if (n.item) walk(n.item);
      };
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try { walk(JSON.parse(s.textContent)); } catch (_) {}
      });
      if (found.length) return { platform: "schema.org markup", raw: found };
    } catch (_) {}

    // DOM fallback
    try {
      const sels = [".product-card",".product-item",".grid-product","[data-product-id]",".card-product",".product-block",".product"];
      let nodes = [];
      for (const s of sels) {
        nodes = [...document.querySelectorAll(s)];
        if (nodes.length >= 3) break;
      }
      const cards = [];
      for (const node of nodes.slice(0, 100)) {
        const nameEl = node.querySelector(".product-card__title,.product-item__title,.product__title,.card__heading,h2,h3,a[href*='/products/']");
        const priceEl = node.querySelector(".price,.product-price,.money,[data-product-price],.price__regular,.price-item");
        const name = nameEl?.textContent?.trim();
        const m = (priceEl?.textContent || "").replace(/,/g,"").match(/(\d+(?:\.\d{1,2})?)/);
        const price = m ? parseFloat(m[1]) : 0;
        if (name && price > 0) cards.push({ name, price });
      }
      if (cards.length) return { platform: "dom-fallback", raw: cards };
    } catch (_) {}

    return { error: "No product data (Shopify JSON, collections, WooCommerce, JSON-LD, DOM all failed)." };
  })();
}

function normalizeShopify(raw) {
  return raw.map(p => {
    const v = p.variants?.[0] || {};
    const price = parseFloat(v.price ?? 0);
    const ca = v.compare_at_price ? parseFloat(v.compare_at_price) : null;
    const cats = [];
    if (p.product_type) cats.push(String(p.product_type));
    if (p.vendor) cats.push("Vendor: " + p.vendor);
    const tags = typeof p.tags === "string" ? p.tags.split(",").map(t => t.trim()).filter(Boolean) : (p.tags || []);
    tags.slice(0, 5).forEach(t => cats.push(t));
    return {
      name: p.title || "Untitled",
      price: isNaN(price) ? 0 : price,
      compareAt: ca && !isNaN(ca) ? ca : null,
      rating: null, reviewCount: null,
      vendor: p.vendor || null,
      variantCount: p.variants?.length || 1,
      categories: [...new Set(cats.map(c => c.trim()).filter(Boolean))],
      productType: p.product_type || "",
    };
  }).filter(p => p.price > 0);
}

function normalizeWoo(raw) {
  return raw.map(p => {
    const minor = p.prices?.currency_minor_unit ?? 2;
    const rawP = parseInt(p.prices?.price ?? "0", 10);
    const rawR = p.prices?.regular_price ? parseInt(p.prices.regular_price, 10) : null;
    const cats = (p.categories || []).map(c => c.name || c.slug).filter(Boolean);
    return {
      name: p.name || "Untitled",
      price: rawP / 10 ** minor,
      compareAt: rawR != null ? rawR / 10 ** minor : null,
      rating: p.average_rating ? parseFloat(p.average_rating) : null,
      reviewCount: p.review_count ?? null,
      vendor: null, variantCount: 1,
      categories: cats,
      productType: cats[0] || "",
    };
  }).filter(p => p.price > 0);
}

function normalizeJsonLd(raw) {
  return raw.map(p => {
    const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    const price = offer?.price ?? offer?.priceSpecification?.price;
    const rating = p.aggregateRating?.ratingValue;
    const rc = p.aggregateRating?.reviewCount ?? p.aggregateRating?.ratingCount;
    return {
      name: p.name ?? "Unknown",
      price: price ? parseFloat(price) : 0,
      compareAt: null,
      rating: rating ? parseFloat(rating) : null,
      reviewCount: rc ? parseInt(rc, 10) : null,
      vendor: p.brand?.name || null, variantCount: 1,
      categories: p.category ? [String(p.category)] : [],
      productType: p.category ? String(p.category) : "",
    };
  }).filter(p => p.price > 0);
}

function normalizeDom(raw) {
  return raw.map(p => ({
    name: p.name, price: p.price, compareAt: null,
    rating: null, reviewCount: null, vendor: null, variantCount: 1,
    categories: [], productType: "",
  })).filter(p => p.price > 0);
}

/* ---------- Matching algorithm (smarter) ---------- */
function normTitle(t) {
  return String(t || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(t) {
  return normTitle(t).split(" ").filter(w => w.length > 1 && !CONFIG.stopWords.has(w));
}
function titleSim(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let inter = 0;
  for (const w of ta) if (setB.has(w)) inter++;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  // Bonus if one title contains the other (after norm)
  const na = normTitle(a), nb = normTitle(b);
  const contain = na.includes(nb) || nb.includes(na) ? 0.12 : 0;
  return Math.min(1, jaccard + contain);
}

function findMatches(ownProducts, comps) {
  const matches = [];
  const used = new Set();
  for (const own of ownProducts) {
    let best = null, bestScore = CONFIG.matchMinScore;
    for (const comp of comps) {
      for (const cp of comp.products) {
        const key = comp.shopUrl + "||" + cp.name;
        if (used.has(key)) continue;
        // Price sanity: reject if > 4x apart (likely different products)
        if (own.price > 0 && cp.price > 0) {
          const ratio = Math.max(own.price, cp.price) / Math.min(own.price, cp.price);
          if (ratio > 4) continue;
        }
        const score = titleSim(own.name, cp.name);
        if (score > bestScore) {
          bestScore = score;
          best = {
            ownName: own.name, ownPrice: own.price,
            compName: cp.name, compPrice: cp.price, compUrl: comp.shopUrl,
            score,
            delta: own.price - cp.price,
            pct: cp.price ? ((own.price - cp.price) / cp.price) * 100 : 0,
          };
        }
      }
    }
    if (best) {
      matches.push(best);
      used.add(best.compUrl + "||" + best.compName);
    }
  }
  matches.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  return matches;
}

/* ---------- KPIs & product table ---------- */
function computeKPIs(products) {
  const prices = products.map(p => p.price).filter(p => p > 0);
  return {
    n: products.length,
    avg: prices.length ? avg(prices) : 0,
    min: prices.length ? Math.min(...prices) : 0,
    max: prices.length ? Math.max(...prices) : 0,
  };
}

function renderKPIs(k) {
  const el = qs("kpis");
  if (!el) return;
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="kpi"><strong>${k.n}</strong><span>products</span></div>
    <div class="kpi"><strong>$${k.avg.toFixed(0)}</strong><span>avg</span></div>
    <div class="kpi"><strong>$${k.min.toFixed(0)}</strong><span>min</span></div>
    <div class="kpi"><strong>$${k.max.toFixed(0)}</strong><span>max</span></div>`;
}

function renderProducts(products) {
  // Product table removed from v1.6 UI (Truth Moment + moves are the hero)
  const el = qs("products-card");
  if (el) el.classList.add("hidden");
}


function buildPrompt(own, comps, confirmed, insights, prev) {
  const ownLines = own.products.slice(0, 40).map((p, i) =>
    `${i+1}. "${p.name}" $${p.price.toFixed(2)}` +
    (p.compareAt > p.price ? ` (was $${p.compareAt.toFixed(2)})` : "") +
    (p.rating != null ? ` ★${p.rating}` : "")
  ).join("\n");

  let comp = "";
  for (const c of comps) {
    comp += `\n\nCompetitor ${hostOf(c.shopUrl)} (${c.products.length} SKUs):\n` +
      c.products.slice(0, 30).map((p, i) => `${i+1}. "${p.name}" $${p.price.toFixed(2)}`).join("\n");
  }

  let match = "";
  if (confirmed.length) {
    const strategy = qs("strategy").value;
    match = "\n\nConfirmed matches (with suggested price under strategy '" + strategy + "'):\n" +
      confirmed.slice(0, 30).map(m => {
        const s = suggestedPrice(m.compPrice, strategy, m.ownPrice);
        return `- "${m.ownName}" $${m.ownPrice.toFixed(2)} vs "${m.compName}" $${m.compPrice.toFixed(2)} (Δ ${m.delta>=0?"+":""}${m.delta.toFixed(2)} / ${m.pct>=0?"+":""}${m.pct.toFixed(1)}%) → suggest $${s.toFixed(2)}`;
      }).join("\n");
  }

  let snap = "";
  if (insights) {
    snap = `\n\nCompetitive snapshot: ${insights.matchCount} matches, avg gap ${insights.avgPct.toFixed(1)}% ($${insights.avgDelta.toFixed(2)}), ${insights.overPct.toFixed(0)}% of matches are priced higher than competitors, your median $${insights.medianOwn.toFixed(2)} vs comp median $${insights.medianComp.toFixed(2)}.`;
  }

  let hist = "";
  if (prev?.own?.shopUrl === own.shopUrl) {
    const prevMap = new Map(prev.own.products.map(p => [normTitle(p.name), p.price]));
    const ch = [];
    for (const p of own.products) {
      const old = prevMap.get(normTitle(p.name));
      if (old != null && Math.abs(old - p.price) > 0.01)
        ch.push(`"${p.name}" $${old.toFixed(2)} → $${p.price.toFixed(2)}`);
    }
    if (ch.length) hist = `\n\nRecent own-shop price changes:\n` + ch.slice(0, 15).join("\n");
  }

  return `Own shop: ${own.shopUrl}\n\nOwn catalog:\n${ownLines}${comp}${match}${snap}${hist}`;
}

async function runRecommendations() {
  const lim = await getLimits();
  const used = await countAiToday();
  if (used >= lim.aiPerDay) {
    setStatus("rec-status", `Free plan: ${lim.aiPerDay} AI recommendations per day. Upgrade to Pro or try tomorrow.`, "error");
    qs("plan-upgrade-box")?.classList.remove("hidden");
    qs("plan-free-box")?.classList.add("hidden");
    return;
  }

  const provider = qs("provider-select").value;
  const model = qs("model-select").value;
  const stored = await chrome.storage.local.get([
    "claudeKey", "xaiKey", "openaiKey", "geminiKey", "deepseekKey", "apiKey"
  ]);
  const keys = {
    claude: stored.claudeKey || stored.apiKey,
    grok: stored.xaiKey,
    openai: stored.openaiKey,
    gemini: stored.geminiKey,
    deepseek: stored.deepseekKey,
  };
  const apiKey = keys[provider];
  const label = (PROVIDER_META[provider] || {}).label || provider;

  if (!apiKey) {
    setStatus("rec-status", `Add your ${label} API key first`, "error");
    return;
  }
  if (!lastOwnData) {
    setStatus("rec-status", "Analyze a shop first", "error");
    return;
  }

  const confirmed = getConfirmed();
  setStatus("rec-status", `${label} is thinking… (${confirmed.length} matches)`, "loading");

  try {
    const userContent = buildPrompt(lastOwnData, competitors, confirmed, currentInsights, previousSnapshot);
    let raw;

    if (provider === "claude") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: model || "claude-sonnet-5",
          max_tokens: 2200,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        }),
      });
      if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 220)}`);
      const data = await res.json();
      raw = data.content?.[0]?.text;
    } else if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-2.5-flash"}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: { maxOutputTokens: 2200, temperature: 0.3 },
        }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 220)}`);
      const data = await res.json();
      raw = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
    } else {
      // OpenAI-compatible: Grok, OpenAI, DeepSeek
      const endpoints = {
        grok: "https://api.x.ai/v1/chat/completions",
        openai: "https://api.openai.com/v1/chat/completions",
        deepseek: "https://api.deepseek.com/chat/completions",
      };
      const res = await fetch(endpoints[provider], {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 2200,
          temperature: 0.3,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 220)}`);
      const data = await res.json();
      raw = data.choices?.[0]?.message?.content;
    }

    if (!raw) throw new Error("Empty response from " + label);
    const parsed = JSON.parse(String(raw).replace(/```json\s*|\s*```/g, "").trim());
    if (!Array.isArray(parsed.recommendations)) throw new Error("Bad JSON shape");
    renderRecs(parsed.recommendations);
    await bumpAiUsage();
    setStatus("rec-status", `via ${label}`, "ok");
  } catch (err) {
    setStatus("rec-status", err.message, "error");
  }
}

function renderRecs(recs) {
  const el = qs("recommendations");
  el.innerHTML = "";
  if (!recs.length) { el.innerHTML = `<div class="empty">No recommendations returned.</div>`; return; }
  for (const r of recs) {
    const imp = r.estimated_impact || {};
    const text = imp.unit === "percent"
      ? `${imp.range_low}–${imp.range_high}% ${(imp.metric||"").replace(/_/g," ")}`
      : `$${imp.range_low||0}–$${imp.range_high||0}/mo`;
    const card = document.createElement("div");
    card.className = "rec-card";
    card.innerHTML = `
      <h4>${esc(r.title || "Recommendation")}</h4>
      <p>${esc(r.detail || "")}</p>
      <p class="impact"><strong>${esc(text)}</strong>
        <span class="confidence confidence-${r.confidence||"low"}">${esc(r.confidence||"low")}</span>
      </p>
      <details><summary>Basis</summary><p>${esc(imp.basis || "—")}</p></details>`;
    el.appendChild(card);
  }
}

/* ---------- Persist / export ---------- */
async function persistAnalysis() {
  if (!lastOwnData) return;
  const payload = {
    own: lastOwnData,
    competitors,
    confirmedKeys: [...confirmedKeys],
    autoMatches,
    insights: currentInsights,
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ lastAnalysis: payload });
  previousSnapshot = payload;
}

async function clearSavedData() {
  await chrome.storage.local.remove(["lastAnalysis", "watchList", "watchDue", "watchAlerts", "watchLastCheckAt", "watchLastResult", "watchLastError"]);
  previousSnapshot = null;
  lastOwnData = null;
  competitors = [];
  autoMatches = [];
  confirmedKeys = new Set();
  currentInsights = null;
  ["kpis","competitor-section","ai-section","history-note","truth-card","moves-card","strategy-card","watch-card","filter-card","manual-card"]
    .forEach(id => qs(id)?.classList.add("hidden"));
  activeCategories = null;
  watchList = [];
  chrome.storage.local.set({ watchList: [] });
  qs("recommendations").innerHTML = "";
  setStatus("status", "Cleared", "ok");
}

function exportCSV() {
  const rows = [["Your product","Your $","Competitor product","Comp $","Delta $","Delta %","Suggest $","Host","Score"]];
  const strategy = qs("strategy").value;
  for (const m of getConfirmed()) {
    rows.push([
      m.ownName, m.ownPrice.toFixed(2), m.compName, m.compPrice.toFixed(2),
      m.delta.toFixed(2), m.pct.toFixed(1), suggestedPrice(m.compPrice, strategy, m.ownPrice).toFixed(2),
      hostOf(m.compUrl), (m.score*100).toFixed(0),
    ]);
  }
  downloadBlob(rowsToCSV(rows), "price-matches.csv", "text/csv");
}

function exportReport() {
  const report = {
    exportedAt: new Date().toISOString(),
    shop: lastOwnData?.shopUrl,
    platform: lastOwnData?.platform,
    productCount: lastOwnData?.products?.length,
    competitors: competitors.map(c => ({ url: c.shopUrl, products: c.products.length, platform: c.platform })),
    insights: currentInsights,
    strategy: qs("strategy").value,
    confirmedMatches: getConfirmed().map(m => ({
      ...m,
      suggested: suggestedPrice(m.compPrice, null, m.ownPrice),
    })),
  };
  downloadBlob(JSON.stringify(report, null, 2), "shop-analyzer-report.json", "application/json");
}

/* ---------- Utils ---------- */
function setStatus(id, text, kind) {
  const el = qs(id);
  el.className = "status" + (kind === "error" ? " error" : kind === "ok" ? " ok" : "");
  if (kind === "loading") {
    el.innerHTML = `<span class="spinner"></span> ${esc(text)}`;
  } else {
    el.textContent = text;
  }
}
function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function clip(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }
function hostOf(u) { try { return new URL(u).hostname; } catch { return u; } }
function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}
function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function rowsToCSV(rows) {
  return rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
}
function downloadBlob(content, name, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
function waitTab(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error("Page load timeout"));
        setTimeout(tick, 300);
      } catch (e) { reject(e); }
    };
    tick();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
