PERF: Faster claim submit (public portal + Worker)
=================================================

CLIENT (claim portal)
- Stronger image compression before upload (960px edge, JPEG ~0.62)
- createImageBitmap path (faster than FileReader data-URL)
- Shows ~KB size when photo is ready
- Product list cached 5 min in sessionStorage (instant reopen)
- Preconnect / dns-prefetch to Worker API

WORKER
- Parallel: R2 upload + SHA-256 + device fingerprint + dealer lookup
- Skip expensive pHash JPEG decode when exact duplicate already found
- pHash scan reduced 3000 → 400 recent bills
- Device velocity + multi-mobile + IP checks run in parallel

UPLOAD
  Claim Portal: public/app.js, public/index.html
  Worker:       src/index.ts, src/fraud.ts

Redeploy both. Hard refresh claim page on phone.
