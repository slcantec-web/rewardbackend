// ============================================================
// API base resolution
//
// If Pages and the Worker share a custom domain (recommended — set up a
// Worker Route for /api/* on your zone, e.g. rewards.company.com/api/*),
// requests stay same-origin and no config is needed.
//
// If you're still on the default *.pages.dev / *.workers.dev subdomains
// (or any other split-domain setup), fill in WORKER_URL below and this
// file will route API calls there automatically.
// ============================================================

// API base resolution: use same-origin relative URLs in AI Studio
window.API_BASE = "";

