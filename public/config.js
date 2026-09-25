// ============================================================
// API + portal URL resolution (2-domain Cloudflare Pages setup)
//
// ORIGINAL DEPLOY MODEL (recommended, already on Cloudflare):
//   - Customer Claim Portal  → Pages project, build output = public
//   - Admin + Finance Panel  → Pages project, build output = admin
//   - API Worker             → Workers (from wrangler.toml / src/)
//
// Fill WORKER_URL when the Worker is on a different origin
// (e.g. https://customereward.<account>.workers.dev).
// Leave empty ("") only if you put a Worker Route for /api/*
// on the SAME hostname as this Pages project.
//
// Fill ADMIN_PORTAL_URL with the Admin/Finance Pages custom domain
// or *.pages.dev URL so footer links work across domains.
// ============================================================

const WORKER_URL = ""; // e.g. "https://customereward.YOUR_SUBDOMAIN.workers.dev"
const ADMIN_PORTAL_URL = ""; // e.g. "https://admin-your-project.pages.dev"

window.API_BASE = WORKER_URL || "";
window.ADMIN_PORTAL_URL = ADMIN_PORTAL_URL || "";
window.CLAIM_PORTAL_URL = ""; // this project is the claim portal
