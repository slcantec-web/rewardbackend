NATIVE APP TOASTS + EDIT MODALS (Customer Master / Item Master)
===============================================================

WHAT THIS DOES
1) All browser alert() popups → native in-app toast notifications
   (dark card, top-right, success/error/warning icons).

2) Customer Master + Item Master EDIT no longer use browser prompt() dialogs.
   They open proper in-app modal forms:
   - Edit Customer: name, phone, city
   - Set / Edit GPS: maps link or coordinates + Clear GPS
   - Edit Item: product name, unit packaging

FILES TO UPLOAD (drag-drop into matching paths in GitHub)

  admin/index.html    →  admin/index.html
  admin/finance.html  →  admin/finance.html
  public/app.js       →  public/app.js

DEPLOY
1) Admin/Finance Pages: admin/index.html + admin/finance.html
2) Claim portal Pages: public/app.js

Hard refresh after deploy (Ctrl+Shift+R).

TEST
- Customer Master → Edit → modal form (not browser alert)
- Customer Master → Set GPS / Edit GPS → modal form
- Item Master → Edit → modal form
- Save → green success toast
