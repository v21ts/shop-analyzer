# Shop Analyzer — Pricing

## Public prices

| Plan | Price | Billing |
|------|--------|---------|
| Free | $0 | Forever |
| Pro Monthly | **$14 / month** | Cancel anytime |
| Pro Yearly | **$99 / year** | ~2 months free vs monthly |
| Lifetime | **$159** once | Limited early-supporter (optional) |

## Feature matrix

| Feature | Free | Pro |
|---------|------|-----|
| Analyze own shop | Yes | Yes |
| Competitors | **1** | Up to 25 |
| Recommended moves shown | **15** | 500 |
| Category filter | Yes | Yes |
| Margin floor | Yes | Yes |
| Manual pairing | Yes | Yes |
| CSV export | Yes | Yes |
| Watchlist | **3** items | **50** items |
| Check now (manual) | Yes | Yes |
| Scheduled alerts + notifications | No | Yes |
| AI recommendations (BYOK) | **3 / day** | Unlimited |

## License keys (extension)

Keys accepted by the extension (prefix-based):

- `SA-PRO-…` — Pro subscription
- `SA-YR-…` — Yearly
- `SA-LIFE-…` — Lifetime

Generate unique keys in your payment system (Gumroad, Stripe, Lemon Squeezy) and email them after purchase.  
Customer pastes the key under **Upgrade to Pro** in the side panel.

### Test key (for you only)

You can temporarily force Pro in DevTools console on the panel page:

```js
chrome.storage.local.set({ planOverride: "pro" })
```

Remove with:

```js
chrome.storage.local.remove("planOverride")
```

Or paste any key starting with `SA-PRO-` and at least 12 characters (e.g. `SA-PRO-TEST-0001`).

## Payment providers (suggested)

1. **Lemon Squeezy** or **Gumroad** — fastest for lifetime + licenses  
2. **Stripe** Checkout — monthly/yearly subscriptions  

After payment → email license key → user activates in extension.
