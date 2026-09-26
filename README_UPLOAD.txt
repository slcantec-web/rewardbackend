NATIVE APP TOASTS — replace browser alert() notifications
=========================================================

WHAT THIS DOES
- All browser alert() popups are replaced with native in-app toast notifications
  (dark card, top-right, icon + message + dismiss).
- Covers: Customer Master create/edit/GPS/bulk, Item Master create/edit/deactivate/bulk,
  payouts, rates, staff, QR, exports, and Finance approve/reject/status/invite/sync.
- Claim portal network error uses the existing result banner (no browser alert).

FILES TO UPLOAD (drag-drop into matching paths in GitHub)

  admin/index.html    →  admin/index.html
  admin/finance.html  →  admin/finance.html
  public/app.js       →  public/app.js

DEPLOY
1) Admin/Finance Pages project: admin/index.html + admin/finance.html
2) Customer claim Pages project: public/app.js

After deploy: hard refresh (Ctrl+Shift+R) on admin, finance, and claim pages.

TEST
- Customer Master → Edit a customer → should show green success toast (not browser alert)
- Item Master → Edit/Create product → same
- Finance → Approve/Reject claim → same native toasts
