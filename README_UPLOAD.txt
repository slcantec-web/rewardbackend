FEATURE: End-customer security dossier + blocked-attempt logging
================================================================

WHAT YOU GET
1) security_events table (auto-created) logs:
   - DAILY_CLAIM_LIMIT     — mobile hit max claims per day (default 3)
   - DEVICE_MULTI_MOBILE   — same phone used with different contact numbers
   - BANK_ACCOUNT_COLLISION — same bank account tried on another mobile
   - DESKTOP_BLOCKED       — PC / desktop claim attempt

2) Daily claim limit is now ENFORCED server-side (was only UI text).
   Override with env DAILY_CLAIM_LIMIT if needed.

3) Customer profile API includes:
   - security.summary (counts)
   - security.events (recent attempts)
   - security.bank_collisions
   - security.claims_today / daily_limit
   - fraudHistory (claims with flags / elevated risk)

4) Admin Customer Dossier drawer shows a "Security & Risk Report" section.

UPLOAD
  Worker / API project:
    src/fraud.ts
    src/index.ts
    src/extras.ts
  Admin static pages:
    admin/index.html

Redeploy Worker + Admin pages. Hard refresh admin after deploy.
