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
// Fill CLAIM_PORTAL_URL with the Customer Pages custom domain
// or *.pages.dev URL so "Claim Portal" links work across domains.
// ============================================================

const WORKER_URL = ""; // e.g. "https://customereward.YOUR_SUBDOMAIN.workers.dev"
const CLAIM_PORTAL_URL = ""; // e.g. "https://claim-your-project.pages.dev"

window.API_BASE = WORKER_URL || "";
window.CLAIM_PORTAL_URL = CLAIM_PORTAL_URL || "";
window.ADMIN_PORTAL_URL = ""; // this project is admin + finance
