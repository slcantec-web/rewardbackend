// ============================================================
// API + portal URL resolution (2-domain Cloudflare Pages setup)
//
// ORIGINAL DEPLOY MODEL (recommended, already on Cloudflare):
//   - Customer Claim Portal  → Pages project, build output = public
//   - Admin + Finance Panel  → Pages project, build output = admin
//   - API Worker             → Workers (from wrangler.toml / src/)
//
// WORKER_URL: Worker origin (required — API is on a different origin)
// ADMIN_PORTAL_URL: Admin/Finance custom domain (or *.pages.dev fallback)
// ============================================================

const WORKER_URL = "https://customereward.slcantec.workers.dev";
const ADMIN_PORTAL_URL = "https://admin.cloudebase.dpdns.org";

window.API_BASE = WORKER_URL || "";
window.ADMIN_PORTAL_URL = ADMIN_PORTAL_URL || "";
window.CLAIM_PORTAL_URL = ""; // this project is the claim portal
