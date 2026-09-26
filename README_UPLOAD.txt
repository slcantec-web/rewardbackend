SAME-DEVICE / DIFFERENT-MOBILE HARD BLOCK — upload these 3 files
================================================================

WHAT THIS DOES
- One phone/browser is locked to the first mobile number that successfully submits.
- A second submit from the same phone with a different number → HTTP 403 blocked.
- User sees: "This phone is already linked to another contact number."

FILES TO UPLOAD (drag-drop into matching paths in GitHub)

  src/fraud.ts      →  src/fraud.ts
  src/index.ts      →  src/index.ts
  public/app.js     →  public/app.js

After push: redeploy Worker (src/*) AND the customer Pages site (public/app.js).

HOW IT WORKS
1. Browser stores a stable installId in localStorage + sessionStorage + cookie.
2. Server hashes installId → device_fingerprint_hash.
3. On every submit, server looks up prior mobiles for that installId/hash.
4. Mobiles are normalized (+94, spaces, missing 0) before compare — formatting cannot bypass.
5. If any other mobile already used this device → hard block (not only a flag).

TEST
1. Submit claim with mobile A from your phone → should succeed.
2. Without clearing site data, submit again with mobile B → must be blocked.
3. Clear site data / use Incognito → new installId (limitation of browser privacy).
   Full bypass still needs a different browser profile or wiped storage.

Do NOT upload node_modules or .db files.
