GITHUB DRAG-AND-DROP — files that fix the build error + pHash/IP feature
========================================================================

HOW TO UPLOAD
1. Open your GitHub repo in the browser.
2. Click into the matching folders (or use "Upload files" from repo root).
3. Drag each file from this folder into the correct path (see table below).
4. Commit with message e.g.: "Fix package-lock sync + pHash/IP near-dupe detection"

FILE → REPO PATH (replace existing files)
----------------------------------------
package.json                          →  package.json          ★ REQUIRED (jpeg-js dep)
package-lock.json                     →  package-lock.json     ★ REQUIRED (fixes npm ci build error)
wrangler.toml                         →  wrangler.toml
schema.sql                            →  schema.sql
src/phash.ts                          →  src/phash.ts          (NEW)
src/fraud.ts                          →  src/fraud.ts
src/index.ts                          →  src/index.ts
src/types.ts                          →  src/types.ts
src/db-adapter.ts                     →  src/db-adapter.ts
migrations/0004_phash_and_ip.sql      →  migrations/0004_phash_and_ip.sql  (NEW)

MINIMUM to fix the CURRENT build failure only:
  package.json + package-lock.json

AFTER UPLOAD
- Cloudflare build will run npm ci successfully (lockfile now includes jpeg-js).
- If D1 is already live, run once:
    npx wrangler d1 execute reward-system-db --remote --file=./migrations/0004_phash_and_ip.sql
- Worker redeploy picks up src/*.ts changes.

Do NOT upload node_modules or reward-system.db.
