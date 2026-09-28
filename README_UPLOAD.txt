FEATURE: Name + bank on first claim only (no separate bank login)
================================================================

FLOW
1) Customer enters contact mobile on claim form.
2) If mobile has NO name or NO bank yet → show once:
     - Full name
     - Account holder name
     - Account number
     - Bank name
     - Branch (optional)
3) If profile already on file → fields hidden; claim only.
4) Track page is for status + wallet (tracking ID). Bank form remains only as fallback.

API
- GET /api/public/mobile-check → hasName, hasBank, needProfile, name, bankHint
- POST /api/submissions accepts customerName + bankDetails when required

UPLOAD
  Claim Portal: public/index.html, public/app.js, public/track.html
  Worker:       src/index.ts, src/types.ts

Redeploy Claim Portal + Worker. Hard refresh claim page.
