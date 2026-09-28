FIX: Unclear "enter full name" error when switching mobiles
==========================================================

WHAT WAS WRONG
- Name/bank validation ran BEFORE same-phone multi-mobile check.
- Using a different contact number on a phone already linked to another
  mobile could show "enter full name..." instead of the real reason.
- Error text was vague.

NOW
1) Same-phone / different-mobile is checked FIRST with a clear message:
   "This phone is already linked to a different contact number..."
   (shows last-4 of previous number when available)

2) Name / bank messages are explicit:
   - New mobile → fill name + bank once under the mobile field
   - Missing bank only → bank fields required once
   - UI scrolls to the profile section when server asks for it

3) Claim submit re-checks mobile profile before upload so fields are shown.

UPLOAD
  Claim Portal: public/app.js
  Worker:       src/index.ts

Redeploy both. Hard refresh claim page on the phone.
