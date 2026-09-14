/**
 * Shop Analyzer service worker — real competitor price watches + notifications
 */

const DEFAULT_INTERVAL_MIN = 60; // 1 hour

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const { watchIntervalMin } = await chrome.storage.local.get("watchIntervalMin");
  const mins = watchIntervalMin || DEFAULT_INTERVAL_MIN;
  chrome.alarms.create("price-watch", { periodInMinutes: mins });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "price-watch") return;
  try {
    await runWatchCheck("alarm");
  } catch (e) {
    console.error("watch check failed", e);
    await chrome.storage.local.set({
      watchLastError: String(e.message || e),
      watchLastCheckAt: Date.now(),
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "RUN_WATCH_CHECK") {
    runWatchCheck("manual")
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async
  }
  if (msg?.type === "SET_WATCH_INTERVAL") {
    const mins = Math.max(15, Number(msg.minutes) || DEFAULT_INTERVAL_MIN);
    chrome.storage.local.set({ watchIntervalMin: mins });
    chrome.alarms.create("price-watch", { periodInMinutes: mins });
    sendResponse({ ok: true, minutes: mins });
    return false;
  }
});

function isProLicense(key) {
  const k = String(key || "").trim().toUpperCase();
  if (k.length < 12) return false;
  return ["SA-PRO-", "SA-LIFE-", "SA-YR-"].some((p) => k.startsWith(p));
}

async function runWatchCheck(reason) {
  const { watchList, licenseKey, planOverride } = await chrome.storage.local.get([
    "watchList",
    "licenseKey",
    "planOverride",
  ]);
  const isPro = planOverride === "pro" || isProLicense(licenseKey);
  if (reason === "alarm" && !isPro) {
    await chrome.storage.local.set({
      watchLastCheckAt: Date.now(),
      watchLastReason: reason,
      watchLastError: null,
      watchLastResult: { checked: 0, changes: 0, skipped: "free_plan" },
    });
    return { checked: 0, changes: 0, skipped: "free_plan" };
  }

  if (!watchList?.length) {
    await chrome.storage.local.set({
      watchLastCheckAt: Date.now(),
      watchLastReason: reason,
      watchLastError: null,
      watchLastResult: { checked: 0, changes: 0 },
    });
    return { checked: 0, changes: 0 };
  }

  // Group by competitor origin
  const byHost = new Map();
  for (const w of watchList) {
    const host = safeHost(w.compUrl);
    if (!host) continue;
    if (!byHost.has(host)) byHost.set(host, { url: w.compUrl, items: [] });
    byHost.get(host).items.push(w);
  }

  let checked = 0;
  const changes = [];
  const updatedList = watchList.map((w) => ({ ...w }));

  for (const [, group] of byHost) {
    let catalog = null;
    try {
      catalog = await scrapeShopInBackground(group.url);
    } catch (e) {
      console.warn("scrape failed", group.url, e);
      continue;
    }
    if (!catalog?.products?.length) continue;

    for (const item of group.items) {
      const match = findBestProduct(catalog.products, item.compName || item.ownName);
      if (!match) continue;
      checked++;
      const prev = item.lastSeenCompPrice != null ? item.lastSeenCompPrice : item.compPrice;
      const next = match.price;
      const idx = updatedList.findIndex((x) => x.key === item.key);
      if (idx < 0) continue;

      updatedList[idx] = {
        ...updatedList[idx],
        lastSeenCompPrice: next,
        lastCheckedAt: Date.now(),
        lastCompNameFound: match.name,
      };

      if (prev > 0 && Math.abs(next - prev) / prev >= 0.01) {
        const dir = next < prev ? "dropped" : "raised";
        const pct = ((next - prev) / prev) * 100;
        const change = {
          key: item.key,
          ownName: item.ownName,
          compName: match.name,
          compUrl: item.compUrl,
          from: prev,
          to: next,
          pct,
          dir,
          at: Date.now(),
        };
        changes.push(change);
        updatedList[idx].lastChange = change;
      }
    }
  }

  // Merge alerts (keep last 30)
  const { watchAlerts = [] } = await chrome.storage.local.get("watchAlerts");
  const alerts = [...changes, ...watchAlerts].slice(0, 30);

  await chrome.storage.local.set({
    watchList: updatedList,
    watchAlerts: alerts,
    watchLastCheckAt: Date.now(),
    watchLastReason: reason,
    watchLastError: null,
    watchLastResult: { checked, changes: changes.length },
    watchDue: false,
  });

  if (changes.length) {
    await notifyChanges(changes);
  }

  return { checked, changes: changes.length, details: changes };
}

async function notifyChanges(changes) {
  try {
    if (changes.length === 1) {
      const c = changes[0];
      await chrome.notifications.create(`watch-${c.key}-${c.at}`, {
        type: "basic",
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        title: "Competitor price change",
        message: `${c.ownName}: competitor ${c.dir} ${c.from.toFixed(2)} → ${c.to.toFixed(2)} (${c.pct >= 0 ? "+" : ""}${c.pct.toFixed(1)}%)`,
        priority: 1,
      });
    } else {
      await chrome.notifications.create(`watch-batch-${Date.now()}`, {
        type: "basic",
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        title: `${changes.length} competitor price changes`,
        message: changes
          .slice(0, 3)
          .map((c) => `${c.ownName}: ${c.from.toFixed(2)}→${c.to.toFixed(2)}`)
          .join(" · "),
        priority: 1,
      });
    }
  } catch (e) {
    console.warn("notification failed", e);
  }
}

function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

function normTitle(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findBestProduct(products, name) {
  const target = normTitle(name);
  if (!target) return null;
  let best = null;
  let bestScore = 0.35;
  for (const p of products) {
    const n = normTitle(p.name);
    if (n === target) return p;
    if (n.includes(target) || target.includes(n)) {
      const score = Math.min(n.length, target.length) / Math.max(n.length, target.length);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * Open a background tab, scrape catalog, close tab.
 */
async function scrapeShopInBackground(url) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitTabComplete(tabId, 25000);
    await sleep(1500);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeInPage,
      args: [4, 4],
    });
    const payload = results?.[0]?.result;
    if (!payload || payload.error) throw new Error(payload?.error || "Empty scrape");

    let products = [];
    if (payload.platform === "shopify") products = normalizeShopify(payload.raw);
    else if (payload.platform === "woocommerce") products = normalizeWoo(payload.raw);
    else if (payload.platform === "schema.org markup") products = normalizeJsonLd(payload.raw);
    else if (payload.platform === "dom-fallback") products = normalizeDom(payload.raw);

    return { shopUrl: url, platform: payload.platform, products };
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) {}
    }
  }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error("Page load timeout"));
        setTimeout(tick, 400);
      } catch (e) {
        reject(e);
      }
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---- in-page scraper (injected) ---- */
function scrapeInPage(maxShopifyPages, maxWooPages) {
  return (async () => {
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

    try {
      let all = [];
      for (let page = 1; page <= maxWooPages; page++) {
        const res = await fetch(
          `${location.origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`
        );
        if (!res.ok) break;
        const data = await res.json();
        if (!Array.isArray(data) || !data.length) break;
        all = all.concat(data);
        if (data.length < 100) break;
      }
      if (all.length) return { platform: "woocommerce", raw: all };
    } catch (_) {}

    try {
      const found = [];
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) {
          n.forEach(walk);
          return;
        }
        const t = n["@type"];
        if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) found.push(n);
        if (n["@graph"]) walk(n["@graph"]);
        if (n.itemListElement) walk(n.itemListElement);
        if (n.item) walk(n.item);
      };
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
          walk(JSON.parse(s.textContent));
        } catch (_) {}
      });
      if (found.length) return { platform: "schema.org markup", raw: found };
    } catch (_) {}

    try {
      const sels = [
        ".product-card",
        ".product-item",
        ".grid-product",
        "[data-product-id]",
        ".card-product",
        ".product-block",
        ".product",
      ];
      let nodes = [];
      for (const s of sels) {
        nodes = [...document.querySelectorAll(s)];
        if (nodes.length >= 3) break;
      }
      const cards = [];
      for (const node of nodes.slice(0, 100)) {
        const nameEl = node.querySelector(
          ".product-card__title,.product-item__title,.product__title,.card__heading,h2,h3,a[href*='/products/']"
        );
        const priceEl = node.querySelector(
          ".price,.product-price,.money,[data-product-price],.price__regular,.price-item"
        );
        const name = nameEl?.textContent?.trim();
        const m = (priceEl?.textContent || "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
        const price = m ? parseFloat(m[1]) : 0;
        if (name && price > 0) cards.push({ name, price });
      }
      if (cards.length) return { platform: "dom-fallback", raw: cards };
    } catch (_) {}

    return { error: "No product data found" };
  })();
}

function normalizeShopify(raw) {
  return raw
    .map((p) => {
      const v = p.variants?.[0] || {};
      const price = parseFloat(v.price ?? 0);
      return { name: p.title || "Untitled", price: isNaN(price) ? 0 : price };
    })
    .filter((p) => p.price > 0);
}

function normalizeWoo(raw) {
  return raw
    .map((p) => {
      const minor = p.prices?.currency_minor_unit ?? 2;
      const rawP = parseInt(p.prices?.price ?? "0", 10);
      return { name: p.name || "Untitled", price: rawP / 10 ** minor };
    })
    .filter((p) => p.price > 0);
}

function normalizeJsonLd(raw) {
  return raw
    .map((p) => {
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
      const price = offer?.price ?? offer?.priceSpecification?.price;
      return { name: p.name ?? "Unknown", price: price ? parseFloat(price) : 0 };
    })
    .filter((p) => p.price > 0);
}

function normalizeDom(raw) {
  return raw.map((p) => ({ name: p.name, price: p.price })).filter((p) => p.price > 0);
}
