PERF: Admin / Finance / Login / API workflows
============================================

ADMIN
- Boot no longer loads full customer-summaries (was the slow badge call)
- Header counts (dealers + pending payouts) load in parallel
- Overview + badges start together
- Preconnect to Worker API

FINANCE
- Submission detail + bill image prefetch in parallel
- Preconnect to Worker API

LOGIN
- Preconnect to Worker API (faster first sign-in)

API (Worker)
- Customer summaries: 7 independent D1 queries in Promise.all
- Customer dossier profile: parallel stats/wallet/bank/devices/recent
- Claim rates: one query for all active rates (not per product line)

Also includes prior claim-submit optimisations (fraud + public portal) if you redeploy those files.

UPLOAD
  Admin Pages:  admin/index.html, admin/finance.html, admin/login.html
  Worker:       src/extras.ts, src/index.ts, src/fraud.ts (optional with claim perf)
  Claim Portal: public/app.js, public/index.html (optional with claim perf)

Redeploy Admin + Worker. Hard refresh.
