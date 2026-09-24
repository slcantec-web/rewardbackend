PAYOUT FIX — deploy these 3 files

1. src/extras.ts     → Worker
2. src/index.ts      → Worker  
3. admin/finance.html → Admin Pages

After deploy:
- Header must show: Finance Dashboard v2026-09-24c
- Name line must show: API 2026-09-24c-rebuild
- Open Payouts tab as finance_lead
- Click green button: "Rebuild from approved claims"

That recomputes wallets from every APPROVED submission
(minus already PAID payouts) and creates pending payout rows
for anyone with remaining balance ≥ 1000 LKR.
