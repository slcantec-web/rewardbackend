FIX: End-customer name in Customer Intelligence & Summaries Ledger
=================================================================

ROOT CAUSE
- Summaries API hard-coded end-customer label as "Customer {mobile}"
  and never joined end_customers.full_name.

NOW
- API loads end_customers and sets:
    end_customer_name  (real name or null)
    dealer_name        (real name, or fallback "Customer {mobile}")
- Admin + Finance summaries tables show the real name
- Search matches end_customer_name
- CSV export uses end_customer_name when present
- "Name not collected" shown when missing

UPLOAD
  Worker:  src/extras.ts
  Admin:   admin/index.html, admin/finance.html

Redeploy Worker + Admin pages. Hard refresh. Open Customer Summaries.
