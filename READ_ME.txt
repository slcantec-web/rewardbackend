CUSTOMER SUMMARY TAB + payout diagnostics

Deploy:
  src/extras.ts      → Worker
  src/index.ts       → Worker
  admin/finance.html → Admin / Finance Pages

After deploy, header must show: v2026-09-24d
API line must include: 2026-09-24d-customers

New nav tab: "Customers"
- One row per mobile number
- Submissions (A/R/P counts)
- Approved LKR, Pending LKR, Wallet, Net payable
- Risk / fraud flags (geo, duplicate, velocity)
- Suspect (pink) and payout-eligible (green) highlighting
- Click mobile for full profile
- CSV export

Payouts still empty?
1. Open Customers tab
2. Check "Approved LKR" and "Payout-eligible" columns
3. If Approved LKR is 0 → claims were never Approved (only submitted)
4. If green/eligible rows exist → open Payouts as finance_lead → "Rebuild from approved claims"
