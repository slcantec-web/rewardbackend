# Upload paths — where each file goes in your repo

Match the Cloudflare Pages + Workers layout from README.

```
reward-system/                          ← your GitHub repo root
├── wrangler.toml                       ← Worker config
├── schema.sql
├── package.json
├── migrations/
│   ├── 0002_customer_item_master.sql
│   └── 0003_customer_bank_details.sql
├── src/                                ← Worker API (deploy as Worker)
│   ├── index.ts                        ★ UPDATED (wires registerExtras)
│   ├── extras.ts                       ★ UPDATED (device / payout / location / finance)
│   ├── fraud.ts
│   ├── auth.ts
│   └── types.ts
├── public/                             ← Customer PWA (Pages build output = public)
│   ├── index.html                      (submission form)
│   ├── track.html                      ★ UPDATED (bank prefill by mobile)
│   ├── app.js
│   ├── config.js
│   └── manifest.json
└── admin/                              ← Finance + Admin (Pages build output = admin)
    ├── finance.html                    ★ UPDATED (device badges, customer profile, CSV export)
    ├── index.html                      ★ UPDATED (simple location + bulk location column)
    └── config.js
```

## Files changed in this update (copy these over existing ones)

| Local path in this zip              | Upload / replace path in repo   |
|-------------------------------------|---------------------------------|
| `src/index.ts`                      | `src/index.ts`                  |
| `src/extras.ts`                     | `src/extras.ts`                 |
| `admin/finance.html`                | `admin/finance.html`            |
| `admin/index.html`                  | `admin/index.html`              |
| `public/track.html`                 | `public/track.html`             |

Unchanged supporting files are included so the package is complete if you need a full drop-in.

## After upload

1. Push to the branch connected to Cloudflare (or deploy Worker + both Pages projects).
2. No new D1 migrations required for these UI/API features.
3. Worker must pick up `src/index.ts` + `src/extras.ts` (ensure build entry includes both).
