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

const WORKER_URL = "https://customereward.slcantec.workers.dev"; // <-- set this

window.API_BASE = (() => {
  const host = window.location.hostname;
  const onPagesDev = host.endsWith(".pages.dev");
  const onLocalhost = host === "localhost" || host === "127.0.0.1";

  if (onPagesDev || onLocalhost) {
    return WORKER_URL;
  }
  // Same custom domain as the Worker route → same-origin, no prefix needed.
  return "";
})();
