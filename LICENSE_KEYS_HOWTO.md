# Issuing license keys

## Format
`SA-PRO-XXXX-XXXX` or `SA-YR-…` or `SA-LIFE-…`  
Min length 12 characters. Extension only checks prefix + length (MVP).

## When you scale
Replace `isValidLicenseFormat` with a request to your backend:

POST https://your-api.com/verify-license  
{ "key": "SA-PRO-…" } → { "valid": true, "plan": "pro" }

Until then:
1. Sell on Gumroad/Lemon Squeezy
2. Deliver a unique key in the thank-you email
3. Keep a spreadsheet of issued keys
4. If abused, change prefixes and force updates

## Sample keys for testing
SA-PRO-TEST-DEMO01
SA-YR-TEST-DEMO0001
SA-LIFE-TEST-DEMO01
