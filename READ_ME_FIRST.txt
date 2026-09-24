WHY YOU SAW NO UI CHANGE
========================
1) Cloudflare Pages serves ONLY the "Build output directory" folder.
   - Admin/Finance project  → output dir must be: admin
   - Customer PWA project   → output dir must be: public
   If you put finance.html in repo root but Pages output is "admin",
   the live site still serves the OLD admin/finance.html.

2) Browser cache. Hard-refresh: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac).
   Or open the URL in a private/incognito window.

3) Worker must be redeployed for API features (device counts, payouts, location).
   Static HTML changes only need the Pages project redeployed.

HOW TO VERIFY THIS PACKAGE IS LIVE
==================================
After deploy, open Finance Dashboard. The header must show:
  "Finance Dashboard v2026-09-24"
Admin Panel header must show:
  "Admin Panel v2026-09-24"
If you do NOT see "v2026-09-24", the new HTML is not what Cloudflare is serving.

UPLOAD MAP (structured — recommended)
=====================================
Copy into your Git repo root:

  src/index.ts          ← Worker (required)
  src/extras.ts         ← Worker (required)
  admin/finance.html    ← Finance UI
  admin/index.html      ← Admin UI (Customer Master location field)
  public/track.html     ← Track page (bank prefill)

Then push. Cloudflare auto-redeploys if Git is connected.
Or: Dashboard → Workers & Pages → each project → Deployments → Retry deployment
  after the commit is on the tracked branch.

Cloudflare Pages settings check
===============================
Admin project:  Build output directory = admin   (no build command)
Customer project: Build output directory = public
Worker: main = src/index.ts (from wrangler.toml)
