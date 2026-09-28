FIX: Claim Portal links broken in Admin panel
=============================================

ROOT CAUSE
- Admin and Claim Portal are SEPARATE domains.
- Admin was building links with window.location.origin (admin domain),
  so "Claim Portal", store QR, and QR tab pointed at admin pages — broken.

FIXES
1) admin/index.html
   - Claim Portal nav link → CLAIM_PORTAL_URL from config.js
   - Store counter QR / dealer claim link → CLAIM_PORTAL_URL/?dealer=ID
   - QR Assets tab defaults → claim portal home / track.html

2) admin/finance.html
   - Claim Portal nav link no longer falls back to "/" (admin root)

3) public/app.js (Claim Portal)
   - Reads ?dealer=<id> and pre-selects that store

4) src/index.ts (Worker)
   - GET /api/dealers?id=... exact lookup for store QR deep-links

VERIFY admin/config.js has:
  CLAIM_PORTAL_URL = "https://rewards.cloudebase.dpdns.org"
  (or your real claim portal domain)

UPLOAD
  Admin Pages:   admin/index.html, admin/finance.html
  Claim Portal:  public/app.js
  Worker:        src/index.ts

Redeploy all three if needed. Hard refresh admin (Ctrl+Shift+R).
