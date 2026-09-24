FIX: empty payouts + no UI detail improvements
==============================================

1) Redeploy BOTH:
   - Worker (src/index.ts + src/extras.ts)  ← critical for payouts + device data
   - Admin Pages (admin/finance.html + admin/index.html)

2) After deploy, open Finance Dashboard. Header must say:
     Finance Dashboard v2026-09-24b
   And next to your name you should see:
     API 2026-09-24-payout-sync
   If API line is missing or different → Worker is still old.

3) Payouts tab is ONLY visible when logged in as finance_lead
   (not finance_staff).

4) "1000 customers" in Customer Master ≠ payouts.
   Payouts need:
     - Claims APPROVED by finance
     - Wallet balance_lkr ≥ 1000 (sum of approved rewards)
   Opening Payouts tab now auto-creates pending payout rows for
   every wallet already over threshold, and lists those wallets.

5) Hard refresh: Ctrl+Shift+R / Cmd+Shift+R
