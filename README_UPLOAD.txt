FEATURE: End-customer name on claim portal (first time only)
===========================================================

BEHAVIOUR
- User enters contact mobile number.
- Portal calls GET /api/public/mobile-check?mobile=...
- If mobile already has a saved name → name field stays HIDDEN.
- If new mobile (or name never collected) → "Your Full Name" appears
  and is required before submit.
- Name is stored in table end_customers (one per mobile).
- Admin customer dossier shows "End Customer Name".

UPLOAD
  Claim Portal Pages:
    public/index.html
    public/app.js
  Worker / API:
    src/index.ts
    src/types.ts
    src/extras.ts
  Admin Pages (dossier label only):
    admin/index.html

Redeploy Claim Portal + Worker (+ Admin if desired). Hard refresh.
