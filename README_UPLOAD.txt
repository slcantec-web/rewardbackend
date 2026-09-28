FIX: Bank details request — proper modal (no browser prompt/alert)
=================================================================

WHY
- "Request bank details" used browser prompt() for the invite link and
  a second prompt() as clipboard fallback. That felt like a system alert,
  not part of the app.

NOW
- Finance portal (admin/finance.html) and Admin panel (admin/index.html)
  open an in-app modal:
  - Shows mobile + secure invite link
  - Copy link button
  - Open WhatsApp button (pre-filled message)
  - Close
- No browser alert/prompt for this flow.
- Also fixed broken authHeaders() in finance.html (toast code had been
  inserted mid-function).

UPLOAD (Admin/Finance Pages project)
  admin/finance.html  →  admin/finance.html
  admin/index.html    →  admin/index.html

Redeploy the Admin/Finance static pages (not only the Worker).
Hard refresh after deploy (Ctrl+Shift+R).
