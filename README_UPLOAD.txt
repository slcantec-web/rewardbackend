FIX: Finance "Mark Paid" — both ERP + Bank/Self references (same as admin)
=========================================================================

WHY
- Admin panel used a proper modal with 2 fields: ERP voucher + Bank/CEFT reference.
- Finance portal used browser prompt() twice; the second (bank/self) was easy to miss,
  so it looked like finance only had ERP reference.

NOW
- Finance Payout Ledger → Mark Paid opens the same style modal with:
  1) ERP Payment Voucher Reference *
  2) Bank / Self Transfer Reference *
- Both are required before Confirm Bank Payment.
- Authority remains with finance_lead (and admin) as before.

UPLOAD
  admin/finance.html  →  admin/finance.html

Redeploy the Admin/Finance Pages project (not only the Worker).
Hard refresh finance.html after deploy (Ctrl+Shift+R).
