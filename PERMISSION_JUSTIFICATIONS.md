# Chrome Web Store — Permission justifications

Copy/adapt these into the developer dashboard when asked.

---

### activeTab
Used when the user clicks “Analyze this shop” so the extension can read the current storefront tab and extract product titles and prices for the user’s own catalog analysis.

### scripting
Required to run a short in-page script that collects product data (Shopify JSON, WooCommerce Store API, JSON-LD, or DOM fallback) on the active shop tab and on competitor tabs the user explicitly adds or watches.

### tabs
Used to open competitor storefront URLs in a background tab when the user adds a competitor or runs a watch price check, then close that tab after scraping. Also used to identify the active tab URL for analysis.

### storage
Stores analysis results, confirmed product matches, watchlist, pricing strategy, optional margin settings, optional AI API keys, and optional Pro license key locally on the user’s device so the side panel can restore state.

### alarms
Schedules periodic competitor price checks for items on the user’s watchlist (Pro). No network activity runs unless the user has configured a watchlist and eligible plan settings.

### notifications
Shows a desktop notification when a watched competitor product price changes after a check, so the user does not need to keep the side panel open.

### sidePanel
Displays the Shop Analyzer interface in Chrome’s side panel so it can stay open while the user browses storefront pages.

### Host permission: https://*/* and http://*/*
Storefronts the user analyzes or compares can be on any domain. The extension only requests product/catalog data from URLs the user opens or pastes (their shop and competitor URLs). Broad host access is required because competitor shops are not limited to a fixed list of domains.

### Host permission: api.anthropic.com / api.x.ai / api.openai.com / generativelanguage.googleapis.com / api.deepseek.com
Optional AI recommendations. Requests are sent only when the user clicks “Generate recommendations” and only to the provider they selected, using an API key the user provides.

---

### Single-purpose description (if asked)
Shop Analyzer helps online store owners compare their product prices with competitor storefronts, suggest margin-safe price changes, and optionally watch competitor prices for changes.
