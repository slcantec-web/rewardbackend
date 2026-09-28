FEATURE: End-customer summary & claim history on Finance approval page
=====================================================================

On each claim in the Finance review queue, finance users can see:

  • End customer name
  • Mobile, wallet, approved / pending / rejected counts
  • Approved LKR, pending claimed, paid out
  • Bank on file
  • Stores used
  • Security signals (daily limit, collisions, multi-mobile, etc.)
  • "View claim history" → last claims table + flagged claims

Also from Customer Summaries: "View history" opens the same history modal.

UPLOAD
  Admin Pages: admin/finance.html

No Worker change required (uses existing /api/finance/submissions/:id customer payload
and /api/finance/customers/:mobile).

Hard refresh Finance portal after deploy.
