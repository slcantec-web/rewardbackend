import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, CreateSubmissionPayload } from "./types";
import { evaluateFraud, perceptualHashFromBytes, deviceFingerprintHash } from "./fraud";
import { signSession, verifySession, requireRole, type SessionPayload } from "./auth";
import { registerExtras } from "./extras";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// Enhanced routes FIRST so they win over base routes with the same path
// (device insights, payout sync, location parsing, richer finance APIs).
registerExtras(app);

// ============================================================
// Helpers
// ============================================================

function genSubmissionId(): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(10000 + Math.random() * 89999);
  return `SUB-${year}-${rand}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getSession(c: any, secret: string): Promise<SessionPayload | null> {
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  return verifySession(token, secret);
}

// Accepts either an Admin or a Finance token — used by shared read-only
// endpoints (e.g. dashboard summaries) that both panels display.
async function getAnySession(c: any): Promise<SessionPayload | null> {
  const financeSession = await getSession(c, c.env.FINANCE_JWT_SECRET);
  if (financeSession) return financeSession;
  return getSession(c, c.env.ADMIN_JWT_SECRET);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:.*;base64,/, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ============================================================
// Public: Catalog (products / dealers)
// ============================================================

app.get("/api/products", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, unit_label FROM products WHERE active = 1 ORDER BY sort_order`
  ).all();
  return c.json({ products: results });
});

app.get("/api/dealers", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const like = `%${q}%`;
  // Search by name, customer code, city, or address/location text
  const { results } = await c.env.DB.prepare(
    `SELECT id, customer_code, name, city, address, latitude, longitude
     FROM dealers
     WHERE active = 1
       AND (
         ? = ''
         OR name LIKE ?
         OR IFNULL(customer_code, '') LIKE ?
         OR IFNULL(city, '') LIKE ?
         OR IFNULL(address, '') LIKE ?
       )
     ORDER BY
       CASE
         WHEN ? != '' AND IFNULL(customer_code, '') = ? THEN 0
         WHEN ? != '' AND name LIKE ? THEN 1
         ELSE 2
       END,
       name
     LIMIT 30`
  )
    .bind(q, like, like, like, like, q, q, q, `${q}%`)
    .all();
  return c.json({ dealers: results });
});

// ============================================================
// Customer: Submit a claim
// ============================================================

app.post("/api/submissions", async (c) => {
  const env = c.env;
  const payload = await c.req.json<CreateSubmissionPayload>();

  if (!payload.mobileNumber || !payload.dealerId || !payload.items?.length || !payload.billImageBase64) {
    return c.json({ error: "Missing required fields" }, 400);
  }
  if (!payload.gps || payload.gps.lat == null || payload.gps.lng == null) {
    return c.json({ error: "Location permission is required to submit a claim" }, 400);
  }

  // Block desktop / PC submissions — claims must be from a mobile device at the dealer
  const device = payload.device || {};
  const ua = String(device.userAgent || "");
  const platform = String(device.platform || "");
  const mobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile/i.test(ua);
  const desktopUa =
    (/Windows NT|Macintosh|Linux x86_64|CrOS/i.test(ua) || /Win32|Win64|MacIntel|Linux x86_64/i.test(platform)) &&
    !/Android|Mobile|iPhone|iPad/i.test(ua);
  const clientSaysMobile = device.isMobile === true;
  if (desktopUa || (!mobileUa && !clientSaysMobile)) {
    return c.json(
      {
        error: "Claims must be submitted from a mobile phone at the dealer location. Desktop / PC browsers are blocked.",
        flags: ["DESKTOP_BLOCKED"],
      },
      403
    );
  }

  const submissionId = genSubmissionId();
  const nowIso = new Date().toISOString();

  // --- Store bill image in R2 ---
  const imageBytes = base64ToBytes(payload.billImageBase64);
  const r2Key = `bills/${submissionId}.jpg`;
  await env.BILL_IMAGES.put(r2Key, imageBytes, { httpMetadata: { contentType: "image/jpeg" } });

  // --- Compute hashes ---
  const imageHash = await perceptualHashFromBytes(imageBytes);
  const deviceHash = await deviceFingerprintHash(payload.device || {});

  // --- Look up dealer location for geofence ---
  const dealer = await env.DB.prepare(`SELECT latitude, longitude FROM dealers WHERE id = ?`)
    .bind(payload.dealerId)
    .first<{ latitude: number | null; longitude: number | null }>();

  // --- Fraud evaluation ---
  const clientInstallId = String((payload.device as any)?.installId || "").trim();

  const fraud = await evaluateFraud({
    env,
    db: env.DB,
    dealerLat: dealer?.latitude ?? null,
    dealerLng: dealer?.longitude ?? null,
    gpsLat: payload.gps.lat,
    gpsLng: payload.gps.lng,
    createdAtClient: payload.createdAtClient,
    createdAtServer: nowIso,
    deviceHash,
    imageHash,
    mobileNumber: payload.mobileNumber,
    installId: clientInstallId || undefined,
  });

  // Hard block: same phone / browser already used with a different contact number
  if (fraud.multiMobileDevice) {
    return c.json(
      {
        error:
          "This phone was already used to submit claims with a different contact number. " +
          "Each mobile number must use its own phone. If this is your number, contact support.",
        code: "DEVICE_MULTI_MOBILE",
        flags: fraud.flags,
      },
      403
    );
  }

  // Extra guard: direct installId lookup (in case fraud helper missed)
  if (clientInstallId) {
    const extra = await env.DB.prepare(
      `SELECT COUNT(DISTINCT mobile_number) AS cnt
       FROM submissions
       WHERE json_extract(device_raw_json, '$.installId') = ?
         AND mobile_number IS NOT NULL
         AND length(trim(mobile_number)) > 0
         AND mobile_number != ?`
    )
      .bind(clientInstallId, payload.mobileNumber)
      .first<{ cnt: number }>();
    if ((extra?.cnt ?? 0) > 0) {
      return c.json(
        {
          error:
            "This phone was already used to submit claims with a different contact number. " +
            "Each mobile number must use its own phone. If this is your number, contact support.",
          code: "DEVICE_MULTI_MOBILE",
          flags: ["FLAG_DEVICE_MULTI_MOBILE"],
        },
        403
      );
    }
  }

  // --- Resolve current payout rates & compute claimed reward ---
  let totalClaimed = 0;
  const itemRows: { productId: string; claimedQty: number; rate: number; lineReward: number }[] = [];
  for (const item of payload.items) {
    if (item.claimedQty <= 0) continue;
    const rateRow = await env.DB.prepare(
      `SELECT rate_lkr FROM payout_rates WHERE product_id = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`
    )
      .bind(item.productId)
      .first<{ rate_lkr: number }>();
    const rate = rateRow?.rate_lkr ?? 0;
    const lineReward = rate * item.claimedQty;
    totalClaimed += lineReward;
    itemRows.push({ productId: item.productId, claimedQty: item.claimedQty, rate, lineReward });
  }

  // --- Insert submission ---
  await env.DB.prepare(
    `INSERT INTO submissions (
      id, dealer_id, mobile_number, bill_image_key, bill_image_hash,
      gps_lat, gps_lng, gps_accuracy_m, dealer_distance_km,
      created_at_client, created_at_server, time_delta_seconds,
      device_fingerprint_hash, device_raw_json, risk_score, fraud_flags,
      status, total_claimed_reward_lkr
    ) VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?)`
  )
    .bind(
      submissionId,
      payload.dealerId,
      payload.mobileNumber,
      r2Key,
      imageHash,
      payload.gps.lat,
      payload.gps.lng,
      payload.gps.accuracy,
      fraud.distanceKm,
      payload.createdAtClient,
      nowIso,
      fraud.timeDeltaSeconds,
      deviceHash,
      JSON.stringify(payload.device || {}),
      fraud.riskScore,
      fraud.flags.join(","),
      fraud.duplicateImage ? "REJECTED" : "PENDING",
      totalClaimed
    )
    .run();

  for (const item of itemRows) {
    await env.DB.prepare(
      `INSERT INTO submission_items (submission_id, product_id, claimed_qty, rate_lkr_snapshot, line_reward_lkr)
       VALUES (?,?,?,?,?)`
    )
      .bind(submissionId, item.productId, item.claimedQty, item.rate, item.lineReward)
      .run();
  }

  if (fraud.duplicateImage) {
    await env.DB.prepare(
      `UPDATE submissions SET rejection_code = 'DUPLICATE_BILL_IMAGE' WHERE id = ?`
    )
      .bind(submissionId)
      .run();
  }

  return c.json({
    submissionId,
    status: fraud.duplicateImage ? "REJECTED" : "PENDING",
    flags: fraud.flags,
  });
});

// ============================================================
// Customer: Track a claim
// ============================================================

app.get("/api/track", async (c) => {
  const mobile = c.req.query("mobile");
  const submissionId = c.req.query("submissionId");
  if (!mobile || !submissionId) {
    return c.json({ error: "mobile and submissionId are required" }, 400);
  }

  const submission = await c.env.DB.prepare(
    `SELECT id, status, created_at_server, total_claimed_reward_lkr, total_approved_reward_lkr
     FROM submissions WHERE id = ? AND mobile_number = ?`
  )
    .bind(submissionId, mobile)
    .first();

  if (!submission) return c.json({ error: "Not found" }, 404);

  const { results: items } = await c.env.DB.prepare(
    `SELECT si.claimed_qty, si.verified_qty, p.name
     FROM submission_items si JOIN products p ON p.id = si.product_id
     WHERE si.submission_id = ?`
  )
    .bind(submissionId)
    .all();

  const wallet = await c.env.DB.prepare(`SELECT balance_lkr, status FROM wallets WHERE mobile_number = ?`)
    .bind(mobile)
    .first<{ balance_lkr: number; status: string }>();

  // All claims under the same mobile (summary)
  const { results: allSubmissions } = await c.env.DB.prepare(
    `SELECT id, status, created_at_server, total_claimed_reward_lkr, total_approved_reward_lkr
     FROM submissions WHERE mobile_number = ?
     ORDER BY created_at_server DESC LIMIT 50`
  )
    .bind(mobile)
    .all();

  const summary = {
    total: (allSubmissions || []).length,
    pending: (allSubmissions || []).filter((x: any) => x.status === "PENDING" || x.status === "IN_REVIEW").length,
    approved: (allSubmissions || []).filter((x: any) => x.status === "APPROVED").length,
    rejected: (allSubmissions || []).filter((x: any) => x.status === "REJECTED").length,
    approvedLkr: (allSubmissions || []).reduce((s: number, x: any) => s + Number(x.total_approved_reward_lkr || 0), 0),
    claimedLkr: (allSubmissions || []).reduce((s: number, x: any) => s + Number(x.total_claimed_reward_lkr || 0), 0),
  };

  // Threshold for progress bar (best-effort; public endpoint — use env default)
  let threshold = parseFloat(c.env.WALLET_PAYOUT_THRESHOLD_LKR) || 1000;
  try {
    const row = await c.env.DB.prepare(`SELECT value FROM system_settings WHERE key = 'payout_threshold_lkr'`).first<{ value: string }>();
    if (row?.value != null) {
      const n = parseFloat(row.value);
      if (!isNaN(n) && n >= 0) threshold = n;
    }
  } catch { /* table may not exist yet */ }

  return c.json({
    submission,
    items,
    wallet: wallet || { balance_lkr: 0, status: "ACTIVE" },
    allSubmissions: allSubmissions || [],
    summary,
    threshold,
  });
});

// ============================================================
// Bank details routes: provided by registerExtras (remembered per mobile)

// ============================================================
// Shared: Top submitted customers (Admin + Finance dashboards)
// ============================================================

app.get("/api/top-customers", async (c) => {
  const session = await getAnySession(c);
  if (!requireRole(session, ["admin", "finance_staff", "finance_lead"])) return c.json({ error: "Unauthorized" }, 401);

  const limit = Math.min(50, parseInt(c.req.query("limit") || "10", 10));
  const { results: topCustomers } = await c.env.DB.prepare(
    `SELECT s.mobile_number, COALESCE(d.name, 'Direct Customer') as dealer_name, COUNT(*) as submission_count,
            SUM(CASE WHEN s.status = 'APPROVED' THEN s.total_approved_reward_lkr ELSE 0 END) as total_approved_lkr,
            MAX(s.created_at_server) as last_submission
     FROM submissions s LEFT JOIN dealers d ON d.id = s.dealer_id
     GROUP BY s.mobile_number
     ORDER BY submission_count DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  const totalDealersRow = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM dealers WHERE active = 1`).first<{ count: number }>();
  const totalSubmissionsRow = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM submissions`).first<{ count: number }>();
  const totalApprovedRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(total_approved_reward_lkr), 0) as total FROM submissions WHERE status = 'APPROVED'`
  ).first<{ total: number }>();
  const totalPendingRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(total_claimed_reward_lkr), 0) as total FROM submissions WHERE status IN ('PENDING', 'IN_REVIEW')`
  ).first<{ total: number }>();
  const totalPaidRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount_lkr), 0) as total FROM payouts WHERE status = 'PAID'`
  ).first<{ total: number }>();
  const pendingPayoutsRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(amount_lkr), 0) as total FROM payouts WHERE status = 'PENDING'`
  ).first<{ count: number; total: number }>();

  const { results: recentDealers } = await c.env.DB.prepare(
    `SELECT id, customer_code, name, contact_phone, city, active, created_at
     FROM dealers
     ORDER BY created_at DESC
     LIMIT 10`
  ).all();

  return c.json({
    customers: topCustomers || [],
    recentDealers: recentDealers || [],
    stats: {
      totalDealers: totalDealersRow?.count ?? 0,
      totalSubmissions: totalSubmissionsRow?.count ?? 0,
      totalApprovedLkr: totalApprovedRow?.total ?? 0,
      totalPendingLkr: totalPendingRow?.total ?? 0,
      totalPaidLkr: totalPaidRow?.total ?? 0,
      pendingPayoutsCount: pendingPayoutsRow?.count ?? 0,
      pendingPayoutsLkr: pendingPayoutsRow?.total ?? 0,
    }
  });
});

// ============================================================
// Auth: Finance / Admin login
// ============================================================

app.post("/api/auth/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  const passwordHash = await sha256Hex(password);

  const user = await c.env.DB.prepare(
    `SELECT username, role FROM staff_users WHERE username = ? AND password_hash = ? AND active = 1`
  )
    .bind(username, passwordHash)
    .first<{ username: string; role: SessionPayload["role"] }>();

  if (!user) return c.json({ error: "Invalid credentials" }, 401);

  const secret = user.role === "admin" ? c.env.ADMIN_JWT_SECRET : c.env.FINANCE_JWT_SECRET;
  const token = await signSession(
    { sub: user.username, role: user.role, exp: Math.floor(Date.now() / 1000) + 8 * 3600 },
    secret
  );
  return c.json({ token, role: user.role });
});

// ============================================================
// Finance: Review queue & actions
// queue / detail / approve / payouts list live in extras.ts (registerExtras)
// so device badges, customer profile, and payout-sync always apply.
// ============================================================

app.get("/api/finance/submissions/:id/image", async (c) => {
  const session = await getAnySession(c);
  if (!requireRole(session, ["admin", "finance_staff", "finance_lead"])) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const submission = await c.env.DB.prepare(`SELECT bill_image_key FROM submissions WHERE id = ?`)
    .bind(id)
    .first<{ bill_image_key: string }>();
  if (!submission) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.BILL_IMAGES.get(submission.bill_image_key);
  if (!obj) return c.json({ error: "Image not found" }, 404);

  return new Response(obj.body, { headers: { "Content-Type": "image/jpeg" } });
});

app.post("/api/finance/submissions/:id/verify", async (c) => {
  // Finance JWT only — admin cannot adjust verified quantities
  const session = await getSession(c, c.env.FINANCE_JWT_SECRET);
  if (!requireRole(session, ["finance_staff", "finance_lead"])) {
    return c.json({ error: "Only Finance staff can verify claim quantities. Admin cannot approve or adjust bills." }, 403);
  }

  const id = c.req.param("id");
  const { items } = await c.req.json<{ items: { itemId: number; verifiedQty: number }[] }>();

  for (const item of items) {
    const row = await c.env.DB.prepare(`SELECT rate_lkr_snapshot FROM submission_items WHERE id = ?`)
      .bind(item.itemId)
      .first<{ rate_lkr_snapshot: number }>();
    const lineReward = (row?.rate_lkr_snapshot ?? 0) * item.verifiedQty;
    await c.env.DB.prepare(
      `UPDATE submission_items SET verified_qty = ?, line_reward_lkr = ? WHERE id = ? AND submission_id = ?`
    )
      .bind(item.verifiedQty, lineReward, item.itemId, id)
      .run();
  }

  await c.env.DB.prepare(
    `INSERT INTO finance_audit_trail (actor, submission_id, action, details_json) VALUES (?,?,?,?)`
  )
    .bind(session!.sub, id, "ADJUST_QTY", JSON.stringify(items))
    .run();

  return c.json({ ok: true });
});

app.post("/api/finance/submissions/:id/reject", async (c) => {
  // Finance JWT only — admin cannot reject bills
  const session = await getSession(c, c.env.FINANCE_JWT_SECRET);
  if (!requireRole(session, ["finance_staff", "finance_lead"])) {
    return c.json({ error: "Only Finance staff can reject claims. Admin cannot reject bills." }, 403);
  }

  const id = c.req.param("id");
  const { rejectionCode } = await c.req.json<{ rejectionCode: string }>();

  await c.env.DB.prepare(
    `UPDATE submissions SET status = 'REJECTED', rejection_code = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
  )
    .bind(rejectionCode, session!.sub, id)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO finance_audit_trail (actor, submission_id, action, details_json) VALUES (?,?,?,?)`
  )
    .bind(session!.sub, id, "REJECT", JSON.stringify({ rejectionCode }))
    .run();

  return c.json({ ok: true });
});

// ============================================================
// Finance Lead / Admin: bind only (list + sync live in extras.ts)
// ============================================================

app.post("/api/finance-lead/payouts/:id/bind", async (c) => {
  const session = await getAnySession(c);
  if (!requireRole(session, ["admin", "finance_lead"])) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const { erpReference, bankReference } = await c.req.json<{ erpReference: string; bankReference: string }>();

  const payout = await c.env.DB.prepare(`SELECT mobile_number FROM payouts WHERE id = ?`)
    .bind(id)
    .first<{ mobile_number: string }>();
  if (!payout) return c.json({ error: "Not found" }, 404);

  const bankDetails = await c.env.DB.prepare(
    `SELECT mobile_number FROM customer_bank_details WHERE mobile_number = ?`
  )
    .bind(payout.mobile_number)
    .first();
  if (!bankDetails) {
    return c.json({ error: "Customer has not submitted bank details yet — cannot bind payout." }, 400);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE payouts SET status = 'PAID', erp_reference = ?, bank_reference = ?, bound_by = ?, bound_at = datetime('now') WHERE id = ?`
    ).bind(erpReference, bankReference, session!.sub, id),
    c.env.DB.prepare(`UPDATE wallets SET balance_lkr = 0, status = 'ACTIVE' WHERE mobile_number = ?`).bind(
      payout.mobile_number
    ),
  ]);

  await c.env.DB.prepare(
    `INSERT INTO finance_audit_trail (actor, submission_id, action, details_json) VALUES (?,?,?,?)`
  )
    .bind(session!.sub, null, "BIND_PAYOUT_REF", JSON.stringify({ payoutId: id, erpReference, bankReference }))
    .run();

  return c.json({ ok: true });
});

// ============================================================
// Admin: Staff account management (create / reset password / activate)
// ============================================================

app.get("/api/admin/staff", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT username, role, active, created_at FROM staff_users ORDER BY created_at DESC`
  ).all();
  return c.json({ staff: results });
});

app.post("/api/admin/staff", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { username, password, role } = await c.req.json<{
    username: string;
    password: string;
    role: "admin" | "finance_staff" | "finance_lead";
  }>();

  if (!username || !password || password.length < 8) {
    return c.json({ error: "Username and a password of at least 8 characters are required" }, 400);
  }
  if (!["admin", "finance_staff", "finance_lead"].includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  const existing = await c.env.DB.prepare(`SELECT username FROM staff_users WHERE username = ?`)
    .bind(username)
    .first();
  if (existing) return c.json({ error: "Username already exists" }, 409);

  const passwordHash = await sha256Hex(password);
  await c.env.DB.prepare(`INSERT INTO staff_users (username, password_hash, role) VALUES (?,?,?)`)
    .bind(username, passwordHash, role)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "CREATE_STAFF_USER", "staff_user", username, JSON.stringify({ role }))
    .run();

  return c.json({ ok: true });
});

app.post("/api/admin/staff/:username/reset-password", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const username = c.req.param("username");
  const { password } = await c.req.json<{ password: string }>();
  if (!password || password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const result = await c.env.DB.prepare(`UPDATE staff_users SET password_hash = ? WHERE username = ?`)
    .bind(await sha256Hex(password), username)
    .run();
  if (result.meta.changes === 0) return c.json({ error: "Staff user not found" }, 404);

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "RESET_STAFF_PASSWORD", "staff_user", username, "{}")
    .run();

  return c.json({ ok: true });
});

app.post("/api/admin/staff/:username/role", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const username = c.req.param("username");
  const { role } = await c.req.json<{ role: "admin" | "finance_staff" | "finance_lead" }>();
  if (!["admin", "finance_staff", "finance_lead"].includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }
  if (username === session!.sub && role !== "admin") {
    return c.json({ error: "You cannot remove your own admin role" }, 400);
  }

  await c.env.DB.prepare(`UPDATE staff_users SET role = ? WHERE username = ?`).bind(role, username).run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "CHANGE_STAFF_ROLE", "staff_user", username, JSON.stringify({ role }))
    .run();

  return c.json({ ok: true });
});

app.post("/api/admin/staff/:username/active", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const username = c.req.param("username");
  const { active } = await c.req.json<{ active: boolean }>();
  if (username === session!.sub && !active) {
    return c.json({ error: "You cannot deactivate your own account" }, 400);
  }

  await c.env.DB.prepare(`UPDATE staff_users SET active = ? WHERE username = ?`)
    .bind(active ? 1 : 0, username)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, active ? "ACTIVATE_STAFF_USER" : "DEACTIVATE_STAFF_USER", "staff_user", username, "{}")
    .run();

  return c.json({ ok: true });
});

// ============================================================
// Admin: Products, rates, dealers, QR assets
// ============================================================

app.get("/api/admin/products", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.unit_label, p.active,
            (SELECT rate_lkr FROM payout_rates WHERE product_id = p.id AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) as current_rate
     FROM products p ORDER BY p.sort_order`
  ).all();
  return c.json({ products: results });
});

app.post("/api/admin/products/:id/rate", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const productId = c.req.param("id");
  const { rate } = await c.req.json<{ rate: number }>();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE payout_rates SET effective_to = datetime('now') WHERE product_id = ? AND effective_to IS NULL`
    ).bind(productId),
    c.env.DB.prepare(`INSERT INTO payout_rates (product_id, rate_lkr) VALUES (?, ?)`).bind(productId, rate),
  ]);

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "UPDATE_RATE", "product", productId, JSON.stringify({ rate }))
    .run();

  return c.json({ ok: true });
});

// ---------- Item Master: create / edit / delete / bulk upload ----------

function slugId(prefix: string, name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 24);
  return `${prefix}-${slug}-${Math.floor(1000 + Math.random() * 8999)}`;
}

app.post("/api/admin/items", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { itemCode, name, unitLabel, rate } = await c.req.json<{
    itemCode?: string;
    name: string;
    unitLabel?: string;
    rate?: number;
  }>();
  if (!name) return c.json({ error: "Item name is required" }, 400);

  const id = slugId("PRD", name);
  await c.env.DB.prepare(
    `INSERT INTO products (id, item_code, name, unit_label) VALUES (?,?,?,?)`
  )
    .bind(id, itemCode || null, name, unitLabel || "bag")
    .run();

  if (rate != null) {
    await c.env.DB.prepare(`INSERT INTO payout_rates (product_id, rate_lkr) VALUES (?, ?)`).bind(id, rate).run();
  }

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "CREATE_ITEM", "product", id, JSON.stringify({ itemCode, name, unitLabel, rate }))
    .run();

  return c.json({ ok: true, id });
});

app.patch("/api/admin/items/:id", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const { itemCode, name, unitLabel } = await c.req.json<{
    itemCode?: string;
    name?: string;
    unitLabel?: string;
  }>();

  await c.env.DB.prepare(
    `UPDATE products SET
      item_code = COALESCE(?, item_code),
      name = COALESCE(?, name),
      unit_label = COALESCE(?, unit_label),
      updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(itemCode ?? null, name ?? null, unitLabel ?? null, id)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "EDIT_ITEM", "product", id, JSON.stringify({ itemCode, name, unitLabel }))
    .run();

  return c.json({ ok: true });
});

app.delete("/api/admin/items/:id", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  // Soft-delete: submissions reference items by id, so deactivate rather than
  // hard-delete to keep historical claims intact.
  await c.env.DB.prepare(`UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?`).bind(id).run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "DEACTIVATE_ITEM", "product", id, "{}")
    .run();

  return c.json({ ok: true });
});

app.post("/api/admin/items/bulk", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { rows } = await c.req.json<{
    rows: { itemCode: string; name: string; unitLabel?: string; rate?: number }[];
  }>();
  if (!Array.isArray(rows) || rows.length === 0) return c.json({ error: "No rows provided" }, 400);

  let created = 0;
  let updated = 0;
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.name) {
      errors.push({ row: i + 1, error: "Missing item name" });
      continue;
    }
    try {
      const existing = row.itemCode
        ? await c.env.DB.prepare(`SELECT id FROM products WHERE item_code = ?`).bind(row.itemCode).first<{ id: string }>()
        : null;

      let productId: string;
      if (existing) {
        productId = existing.id;
        await c.env.DB.prepare(
          `UPDATE products SET name = ?, unit_label = COALESCE(?, unit_label), active = 1, updated_at = datetime('now') WHERE id = ?`
        )
          .bind(row.name, row.unitLabel || null, productId)
          .run();
        updated++;
      } else {
        productId = slugId("PRD", row.name);
        await c.env.DB.prepare(`INSERT INTO products (id, item_code, name, unit_label) VALUES (?,?,?,?)`)
          .bind(productId, row.itemCode || null, row.name, row.unitLabel || "bag")
          .run();
        created++;
      }

      if (row.rate != null) {
        const currentRate = await c.env.DB.prepare(
          `SELECT rate_lkr FROM payout_rates WHERE product_id = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`
        )
          .bind(productId)
          .first<{ rate_lkr: number }>();
        if (!currentRate || currentRate.rate_lkr !== row.rate) {
          await c.env.DB.batch([
            c.env.DB.prepare(
              `UPDATE payout_rates SET effective_to = datetime('now') WHERE product_id = ? AND effective_to IS NULL`
            ).bind(productId),
            c.env.DB.prepare(`INSERT INTO payout_rates (product_id, rate_lkr) VALUES (?, ?)`).bind(
              productId,
              row.rate
            ),
          ]);
        }
      }
    } catch (e: any) {
      errors.push({ row: i + 1, error: e.message || "Insert failed" });
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "BULK_UPLOAD_ITEMS", "product", "bulk", JSON.stringify({ created, updated, errorCount: errors.length }))
    .run();

  return c.json({ created, updated, errors });
});

// ---------- Customer (Dealer) Master: create / edit / delete / bulk upload ----------

app.get("/api/admin/dealers", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT id, customer_code, name, contact_phone, address, city, latitude, longitude, active
     FROM dealers ORDER BY name`
  ).all();
  return c.json({ dealers: results });
});

app.post("/api/admin/dealers", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json<{
    customerCode?: string;
    name: string;
    contactPhone?: string;
    address?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  }>();
  if (!body.name) return c.json({ error: "Customer name is required" }, 400);

  const id = slugId("DLR", body.name);
  await c.env.DB.prepare(
    `INSERT INTO dealers (id, customer_code, name, contact_phone, address, city, latitude, longitude)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(
      id,
      body.customerCode || null,
      body.name,
      body.contactPhone || null,
      body.address || null,
      body.city || null,
      body.latitude ?? null,
      body.longitude ?? null
    )
    .run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "CREATE_DEALER", "dealer", id, JSON.stringify(body))
    .run();

  return c.json({ ok: true, id });
});

app.patch("/api/admin/dealers/:id", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const body = await c.req.json<{
    customerCode?: string;
    name?: string;
    contactPhone?: string;
    address?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  }>();

  await c.env.DB.prepare(
    `UPDATE dealers SET
      customer_code = COALESCE(?, customer_code),
      name = COALESCE(?, name),
      contact_phone = COALESCE(?, contact_phone),
      address = COALESCE(?, address),
      city = COALESCE(?, city),
      latitude = COALESCE(?, latitude),
      longitude = COALESCE(?, longitude),
      updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      body.customerCode ?? null,
      body.name ?? null,
      body.contactPhone ?? null,
      body.address ?? null,
      body.city ?? null,
      body.latitude ?? null,
      body.longitude ?? null,
      id
    )
    .run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "EDIT_DEALER", "dealer", id, JSON.stringify(body))
    .run();

  return c.json({ ok: true });
});

app.delete("/api/admin/dealers/:id", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  // Soft-delete: submissions reference dealers by id, so deactivate rather
  // than hard-delete to keep historical claims and geofence data intact.
  await c.env.DB.prepare(`UPDATE dealers SET active = 0, updated_at = datetime('now') WHERE id = ?`).bind(id).run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "DEACTIVATE_DEALER", "dealer", id, "{}")
    .run();

  return c.json({ ok: true });
});

app.post("/api/admin/dealers/bulk", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { rows } = await c.req.json<{
    rows: {
      customerCode: string;
      name: string;
      contactPhone?: string;
      address?: string;
      city?: string;
      latitude?: number;
      longitude?: number;
    }[];
  }>();
  if (!Array.isArray(rows) || rows.length === 0) return c.json({ error: "No rows provided" }, 400);

  let created = 0;
  let updated = 0;
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.name) {
      errors.push({ row: i + 1, error: "Missing customer name" });
      continue;
    }
    try {
      const existing = row.customerCode
        ? await c.env.DB.prepare(`SELECT id FROM dealers WHERE customer_code = ?`)
            .bind(row.customerCode)
            .first<{ id: string }>()
        : null;

      if (existing) {
        await c.env.DB.prepare(
          `UPDATE dealers SET
            name = ?, contact_phone = COALESCE(?, contact_phone), address = COALESCE(?, address),
            city = COALESCE(?, city), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
            active = 1, updated_at = datetime('now')
           WHERE id = ?`
        )
          .bind(
            row.name,
            row.contactPhone || null,
            row.address || null,
            row.city || null,
            row.latitude ?? null,
            row.longitude ?? null,
            existing.id
          )
          .run();
        updated++;
      } else {
        const id = slugId("DLR", row.name);
        await c.env.DB.prepare(
          `INSERT INTO dealers (id, customer_code, name, contact_phone, address, city, latitude, longitude)
           VALUES (?,?,?,?,?,?,?,?)`
        )
          .bind(
            id,
            row.customerCode || null,
            row.name,
            row.contactPhone || null,
            row.address || null,
            row.city || null,
            row.latitude ?? null,
            row.longitude ?? null
          )
          .run();
        created++;
      }
    } catch (e: any) {
      errors.push({ row: i + 1, error: e.message || "Insert failed" });
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "BULK_UPLOAD_DEALERS", "dealer", "bulk", JSON.stringify({ created, updated, errorCount: errors.length }))
    .run();

  return c.json({ created, updated, errors });
});

app.get("/api/admin/qr-assets", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT id, asset_type, target_url, format, created_by, created_at FROM qr_assets ORDER BY created_at DESC LIMIT 50`
  ).all();
  return c.json({ assets: results });
});

app.post("/api/admin/qr-assets", async (c) => {
  const session = await getSession(c, c.env.ADMIN_JWT_SECRET);
  if (!requireRole(session, ["admin"])) return c.json({ error: "Unauthorized" }, 401);

  const { assetType, targetUrl, format } = await c.req.json<{
    assetType: "upload" | "track";
    targetUrl: string;
    format: "svg" | "pdf" | "png";
  }>();

  const result = await c.env.DB.prepare(
    `INSERT INTO qr_assets (asset_type, target_url, format, created_by) VALUES (?,?,?,?)`
  )
    .bind(assetType, targetUrl, format, session!.sub)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`
  )
    .bind(session!.sub, "GENERATE_QR", "qr_asset", String(result.meta.last_row_id), JSON.stringify({ assetType, targetUrl, format }))
    .run();

  // NOTE: actual QR image rendering (SVG/PNG/PDF with Level-H error correction)
  // should be done with a QR library (e.g. `qrcode` npm package works in Workers
  // via nodejs_compat) — generate the vector here and store it in R2, returning
  // a download URL. This scaffold records the asset request; wire up rendering
  // in a follow-up pass once the library is confirmed to work in your Workers runtime.
  return c.json({ ok: true, assetId: result.meta.last_row_id });
});

export default app;
