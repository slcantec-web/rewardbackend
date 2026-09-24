import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import app from "./src/index";
import { initializeDatabaseAndEnv } from "./src/db-adapter";

const env = initializeDatabaseAndEnv();

// Admin & Finance redirects and static files
app.get("/admin", (c) => c.redirect("/admin/index.html"));
app.get("/admin/", (c) => c.redirect("/admin/index.html"));
app.get("/finance", (c) => c.redirect("/admin/finance.html"));
app.get("/finance/", (c) => c.redirect("/admin/finance.html"));
app.get("/finance.html", (c) => c.redirect("/admin/finance.html"));
app.get("/admin/finance", (c) => c.redirect("/admin/finance.html"));
app.use("/admin/*", serveStatic({ root: "./" }));

// Public client files (Customer portal)
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT) || 3000;
const hostname = "0.0.0.0";

console.log(`Starting CanTec Reward System server on http://${hostname}:${port}`);

serve({
  fetch: (req) => app.fetch(req, env),
  port,
  hostname,
});
