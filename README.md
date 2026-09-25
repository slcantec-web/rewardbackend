# Secure Anti-Fraud B2B2C Reward System

Cloudflare Pages + Workers + D1 + R2 implementation scaffold, matching the SRS
(itemized bill submission, manual finance review, no OCR).

## Structure

```
reward-system/
├── wrangler.toml          # Worker config (D1 + R2 bindings)
├── schema.sql             # D1 schema + seed data (fresh installs)
├── migrations/
│   ├── 0002_customer_item_master.sql    # Run only if upgrading an already-deployed DB
│   └── 0003_customer_bank_details.sql   # Run only if upgrading an already-deployed DB
├── package.json
├── src/
│   ├── index.ts           # Hono app — all API routes (customer, finance, admin)
│   ├── fraud.ts           # Duplicate-image hash, geofence, velocity capping, risk scoring
│   ├── auth.ts            # Lightweight signed-session auth for Finance/Admin
│   └── types.ts
├── public/                # Customer-facing PWA (deploy as one Cloudflare Pages project)
│   ├── index.html         # Submission form
│   ├── track.html         # Tracking page
│   ├── app.js
│   └── manifest.json
├── admin/                 # Finance review + Admin Panel (deploy as a second, auth-gated Pages project)
│   ├── finance.html       # Finance Staff / Finance Lead review dashboard
│   └── index.html         # Admin Panel — staff accounts, payout rates, QR/URL asset requests
```

## Deploying via GitHub + the Cloudflare Dashboard

This is the path for connecting a GitHub repo to Cloudflare and deploying
everything from the dashboard — no local `wrangler` CLI required, except for
one step (running the D1 schema) that's easiest done once via `npx wrangler`
or the D1 Console's SQL editor.

### 1. Push this repo to GitHub

Commit everything as-is, including `wrangler.toml` — the Worker's Git
integration reads it directly.

### 2. Create the D1 database and R2 bucket

In the Cloudflare dashboard:
- **Workers & Pages → D1 → Create database** → name it `reward-system-db`.
  Copy the generated **database_id** into `wrangler.toml` (`d1_databases` →
  `database_id`), commit, and push.
- **R2 → Create bucket** → name it `reward-system-bill-images` (matches
  `wrangler.toml`'s `bucket_name`; rename one side if you use a different name).

### 3. Load the schema

Open your D1 database in the dashboard → **Console**, paste the contents of
`schema.sql`, and run it. This creates all tables and seeds the sample
products/dealer.

> Already deployed before this update? Paste
> `migrations/0002_customer_item_master.sql` **and**
> `migrations/0003_customer_bank_details.sql` into the Console instead — the
> latter adds the `customer_bank_details` table the payout flow depends on.
> Fresh installs get these from `schema.sql` directly and can skip this.

### 4. Deploy the Worker (API)

**Workers & Pages → Create → Workers → Connect to Git** → select this repo.
Cloudflare reads `wrangler.toml` for the build and bindings. Before the first
deploy succeeds, add the D1 and R2 bindings under the Worker's
**Settings → Bindings** if they aren't picked up automatically from
`wrangler.toml`.

Then set secrets under **Settings → Variables and Secrets**:
- `FINANCE_JWT_SECRET`
- `ADMIN_JWT_SECRET`

(any long random string works — these sign the Finance/Admin session tokens)

### 5. Deploy the two Pages projects

**Workers & Pages → Create → Pages → Connect to Git**, same repo, twice:
- One project with **build output directory** set to `public` → customer PWA
- One project with **build output directory** set to `admin` → Finance dashboard + Admin Panel

No build command needed for either — they're static files.

### 6. Connect Pages to the Worker (2-domain layout)

This project is designed for **two Pages projects** + one Worker (original Cloudflare deploy):

| Project | Build output | Role |
|---------|--------------|------|
| Claim portal | `public` | Customer submission + track |
| Admin / Finance | `admin` | Admin panel + finance review |
| Worker | `src/` via `wrangler.toml` | `/api/*` |

`public/config.js` and `admin/config.js`:

1. Set **`WORKER_URL`** in both files to your Worker URL  
   (e.g. `https://customereward.<account>.workers.dev`) when API is on a different origin.
2. In **`admin/config.js`**, set **`CLAIM_PORTAL_URL`** to the customer Pages URL  
   (e.g. `https://your-claim.pages.dev`) so “Claim Portal ↗” works.
3. In **`public/config.js`**, optionally set **`ADMIN_PORTAL_URL`** to the admin Pages URL  
   if you want footer staff links on the claim page.

Leave a value as `""` only when that resource is same-origin (Worker Route on the same hostname, or local `server.ts`).

CORS on the Worker already allows cross-origin API calls from the two Pages hosts.

### 7. Seed the first admin account

D1 doesn't have a signup flow by design, and staff creation via the Admin
Panel requires you to already be logged in as an admin — so the very first
account has to be inserted directly via the D1 Console:

```sql
INSERT INTO staff_users (username, password_hash, role)
VALUES ('admin1', '<sha256-hex-of-your-password>', 'admin');
```

Generate the password hash on your machine first (never type the raw
password into the dashboard):
```bash
echo -n "yourpassword" | shasum -a 256
```

Every account after that (finance staff, finance leads, more admins) can be
created from **Admin Panel → Staff Accounts** once you're logged in.

> Swap this for Cloudflare Access in front of the `admin` Pages project for
> production — it removes the need to manage passwords yourself entirely.

### Redeploying after future changes

Both the Worker and Pages projects are now tracked to your GitHub branch —
push to that branch and Cloudflare redeploys automatically. Schema changes
still need to be pasted into the D1 Console by hand; they don't run from Git.

---

## Alternative: local Wrangler CLI

If you'd rather deploy from your machine instead of the dashboard:

```bash
npm install
npx wrangler login

npx wrangler d1 create reward-system-db        # copy database_id into wrangler.toml
npx wrangler r2 bucket create reward-system-bill-images
npm run db:migrate:remote                       # or db:migrate for local dev

npx wrangler secret put FINANCE_JWT_SECRET
npx wrangler secret put ADMIN_JWT_SECRET

npx wrangler deploy                             # Worker (API)
npx wrangler pages deploy public                # customer PWA
npx wrangler pages deploy admin                 # Finance dashboard + Admin Panel
```

## What's scaffolded vs. what needs finishing

**Done:**
- Full D1 schema (submissions, items, wallets, payouts, audit trails, rate history)
- Customer submission API with telemetry capture, R2 image storage, fraud evaluation
- All three fraud layers (duplicate image hash, geofence, velocity capping) wired into ingest
- Finance review queue, verify/approve/reject, wallet crediting, 1,000 LKR threshold → pending payout
- Finance Lead payout binding (ERP ref + bank ref)
- Admin rate management + QR asset request logging
- **Admin Panel**: create/edit staff accounts, reset passwords, change roles, activate/deactivate — enforced role checks (self-deactivation and self-demotion from admin are blocked)
- **Customer (B2B Dealer) Master**: add/edit/deactivate dealers, plus Excel (.xlsx/.csv) bulk upload that upserts by `customerCode`
- **Item Master**: add/edit/deactivate products (with reward rate), plus Excel bulk upload that upserts by `itemCode` and updates rates when changed
- Finance review queue and detail view now join and display the dealer name from the Customer Master, so Finance always sees current master data rather than a raw ID
- **Bank details & payout flow**: once a customer's wallet hits the 1,000 LKR threshold, `track.html` prompts them to submit bank account details; Finance Lead's new **Payouts** view (in `finance.html`, visible only to the `finance_lead` role) shows each pending payout with those bank details and requires an ERP reference + bank reference before it can be marked paid — binding is blocked server-side if details are missing
- **Top Submitted Customers**: a shared `/api/top-customers` endpoint (readable by Admin or Finance tokens) now feeds a leaderboard on both the Admin Panel's new **Overview** tab and a sidebar widget in the Finance dashboard
- **Headers, navigation, and logout**: every page now has a header identifying the app; Admin Panel and Finance Dashboard cross-link to each other and both have a working **Log out** button (previously missing)
- **QR generation now actually produces a file**: the Admin Panel's QR tab renders a real QR code client-side (Level-H error correction, per SRS §3) the moment you generate one, with **Download SVG**, **Download PNG**, and **Print/Save as PDF** buttons — no more "request logged, nothing to open." A request history table (via a new `GET /api/admin/qr-assets`) lets you re-render any past URL on demand.
- Customer PWA (product steppers, bill capture + client-side compression, GPS, device blueprint)
- Finance dashboard (queue, bill viewer, telemetry card, quantity verification, approve/reject)

**Needs a follow-up pass before production:**
- **QR rendering**: `/api/admin/qr-assets` records the request but doesn't render the actual SVG/PDF/PNG with Level-H error correction yet — wire in a QR library (e.g. `qrcode` via `nodejs_compat`) and store the output in R2.
- **Perceptual hashing**: `fraud.ts` currently does exact-byte SHA-256 hashing (catches identical re-uploads only). For true near-duplicate detection (re-compressed/re-cropped bills), swap in a DCT-based pHash.
- **Auth hardening**: the included auth is a minimal HMAC-signed session, sufficient for internal tooling but not a replacement for Cloudflare Access or a vetted JWT library at scale.
- **Dealer geocoding**: Customer Master lets you type lat/lng directly, but there's no map picker or automatic geocoding yet — worth adding if dealers are onboarded frequently.
- **Image serving**: bill images are streamed through the Worker (`/api/finance/submissions/:id/image`) — fine for internal review traffic; consider R2 signed URLs if traffic grows.

## Next stage (deferred, per your note)

Not built yet — flagged for a follow-up pass rather than included here:
- **Email verification at submission**: capturing and verifying a customer email on the bill-submission form (with auto-fill from a previously-saved email against their mobile number).
- **Reference-number email on submission**: sending a confirmation email with the submission ID once a bill is submitted, via your existing email/SMS gateway setup rather than a new provider.

Both are natural additions to `POST /api/submissions` (customer PWA) and the Worker once you're ready — happy to wire them in next.
