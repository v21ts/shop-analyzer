# Shop Analyzer

**Competitive pricing checks for Shopify & WooCommerce** — scrape your catalog, compare competitors, get margin-safe price moves, and watch for changes.

Chrome extension (Manifest V3) · Side panel UI · Free tier + Pro

---

## What it does

1. **Analyze** your store (Shopify, WooCommerce, and many schema.org storefronts)
2. **Add competitors** — catalogs are scraped in background tabs
3. **Match products** automatically or **pair manually** when names differ
4. See a clear **Truth Moment** score (are you overpriced?)
5. Apply a **pricing strategy** with an optional **margin floor**
6. **Export CSV** of suggested fixes, or **★ watch** competitor prices
7. Optional **AI recommendations** (bring your own API key)

---

## Install (developer / sideload)

1. Download the latest release zip (or clone this repo)
2. Chrome → `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select the extension folder (must contain `manifest.json`)
4. Pin the extension and open the **side panel**

> For the public listing, install from the [Chrome Web Store](#) once published.

---

## Plans

| | Free | Pro |
|--|------|-----|
| **Price** | $0 | **$14/mo** · **$99/yr** · lifetime **$159** (optional) |
| Competitors | 1 | Up to 25 |
| Recommended moves | 15 | 500 |
| Watchlist | 3 | 50 |
| Price checks | Manual only | Scheduled + notifications |
| AI (BYOK) | 3 runs/day | Unlimited |

After purchase, activate with a license key in the side panel (`SA-PRO-…` / `SA-YR-…` / `SA-LIFE-…`).

Full matrix: see [PRICING.md](./PRICING.md).

---

## Privacy

- Catalog analysis and settings stay in **your browser** (`chrome.storage.local`)
- No account required for Free
- AI is optional and uses **your** keys; data is sent only to the provider you choose

**Privacy Policy:** [privacy-policy.html](./privacy-policy.html)

*(When hosting on GitHub Pages, link the public URL, e.g. `https://YOUR_USER.github.io/shop-analyzer/privacy-policy.html` — use that same URL in the Chrome Web Store listing.)*

---

## Permissions (why)

| Permission | Why |
|------------|-----|
| `activeTab` / `scripting` / `tabs` | Analyze the current shop and scrape competitor URLs you add |
| `storage` | Save analyses, watchlist, settings, optional keys |
| `alarms` | Scheduled watch checks (Pro) |
| `notifications` | Alert when a competitor price changes |
| `sidePanel` | Keep the UI open while you browse |
| Host access | Storefronts you choose + optional AI APIs |

Details for the Chrome dashboard: [PERMISSION_JUSTIFICATIONS.md](./PERMISSION_JUSTIFICATIONS.md).

---

## Store listing assets

| Asset | File |
|-------|------|
| Icon 128×128 | [store_icon_128.png](./store_icon_128.png) |
| Screenshots | `screenshot_1_*.png` … `screenshot_5_*.png` |
| Listing copy | [CHROME_WEB_STORE.md](./CHROME_WEB_STORE.md) |
| Product Hunt | [PRODUCT_HUNT.md](./PRODUCT_HUNT.md) |
| License keys | [LICENSE_KEYS_HOWTO.md](./LICENSE_KEYS_HOWTO.md) |

---

## Stack

- Manifest V3 · service worker · side panel
- Client-side scraping (Shopify `products.json`, Woo Store API, JSON-LD, DOM fallback)
- Optional AI: Anthropic, xAI (Grok), OpenAI, Gemini, DeepSeek

---

## Roadmap (ideas)

- Server-side license verification
- Stronger multi-competitor “market position”
- Hosted monitoring (doesn’t require Chrome to stay open)

---

## Disclaimer

Matching is best-effort — always review pairs (size, pack, and naming differ across shops). Suggested prices are guidance, not financial advice. Respect storefront terms and applicable law when scraping.

---

## License

Proprietary for now. Contact the author for commercial redistribution.
