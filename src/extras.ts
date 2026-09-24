/**
 * extras.ts — additions / overrides for the Reward System API.
 *
 * Register this BEFORE the original routes in index.ts (right after
 * `app.use("*", cors())`). Hono runs handlers in registration order and the
 * first one that returns a response wins, so any route defined here replaces
 * the older route with the same method + path. The older versions can be
 * deleted from index.ts whenever convenient.
 */
import type { Hono } from "hono";
import type { Env } from "./types";
import { verifySession, requireRole, type SessionPayload } from "./auth";

type App = Hono<{ Bindings: Env }>;
type Role = SessionPayload["role"];

// ============================================================
// Auth helpers
// ============================================================

async function sessionFrom(c: any, secret: string): Promise<SessionPayload | null> {
  try {
    const auth = c.req.header("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;
    return await verifySession(token, secret);
  } catch {
    return null;
  }
}

async function financeSession(c: any, roles: Role[]) {
  const s = await sessionFrom(c, c.env.FINANCE_JWT_SECRET);
  return requireRole(s, roles) ? s : null;
}

async function adminSession(c: any) {
  const s = await sessionFrom(c, c.env.ADMIN_JWT_SECRET);
  return requireRole(s, ["admin"]) ? s : null;
}

async function anySession(c: any) {
  return (await sessionFrom(c, c.env.FINANCE_JWT_SECRET)) ?? (await sessionFrom(c, c.env.ADMIN_JWT_SECRET));
}

const maskAccount = (n: string) => (n || "").replace(/.(?=.{4})/g, "•");

function safeJson(text: unknown): any {
  try {
    return text ? JSON.parse(String(text)) : {};
  } catch {
    return {};
  }
}

// ============================================================
// Device blueprint → readable summary
// ============================================================

export function describeDevice(raw: any) {
  const ua: string = raw?.userAgent || "";
  let os = "Unknown";
  let category = "Other";
  if (/android/i.test(ua)) { os = "Android"; category = "Android"; }
  else if (/iphone|ipad|ipod/i.test(ua)) { os = "iOS"; category = "iOS"; }
  else if (/windows/i.test(ua)) { os = "Windows"; category = "Desktop"; }
  else if (/mac os x|macintosh/i.test(ua)) { os = "macOS"; category = "Desktop"; }
  else if (/linux|cros/i.test(ua)) { os = "Linux"; category = "Desktop"; }

  const osVersion =
    ua.match(/Android ([\d.]+)/)?.[1] ?? ua.match(/OS ([\d_]+) like Mac/)?.[1]?.replace(/_/g, ".") ?? "";

  let browser = "Unknown";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";
  else if (/samsungbrowser/i.test(ua)) browser = "Samsung Internet";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/safari/i.test(ua)) browser = "Safari";

  const model =
    os === "Android"
      ? ua.match(/Android [\d.]+; ([^;)]+)/)?.[1]?.trim() || ""
      : os === "iOS"
      ? /ipad/i.test(ua) ? "iPad" : "iPhone"
      : "";

  const s = raw?.screen;
  const screen = s ? `${s.width}×${s.height} @${s.pixelRatio}x` : "";
  const gpu: string = raw?.webglRenderer || "";

  return {
    label: [model || os, browser].filter(Boolean).join(" · "),
    os,
    osVersion,
    browser,
    model,
    category,
    screen,
    gpu,
    cores: raw?.hardwareConcurrency ?? null,
    memoryGb: raw?.deviceMemory ?? null,
    language: raw?.language || "",
    platform: raw?.platform || "",
    network: raw?.connectionType || "",
    // Used to group "common" hardware profiles together
    profileKey: [os, gpu || "no-gpu-info", screen].join(" | "),
  };
}

const classify = (total: number, mobiles: number) =>
  mobiles >= 2 ? "shared" : total >= 2 ? "repeat" : "single";

async function deviceActivity(db: D1Database, hash: string) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT mobile_number) AS mobiles,
              COUNT(DISTINCT dealer_id) AS dealers,
              MIN(created_at_server) AS first_seen,
              MAX(created_at_server) AS last_seen,
              COALESCE(SUM(status = 'APPROVED'), 0) AS approved,
              COALESCE(SUM(status = 'REJECTED'), 0) AS rejected,
              COALESCE(SUM(status IN ('PENDING','IN_REVIEW')), 0) AS pending,
              COALESCE(MAX(risk_score), 0) AS max_risk
       FROM submissions WHERE device_fingerprint_hash = ?`
    )
    .bind(hash)
    .first<any>();
  const total = r?.total ?? 0;
  const mobiles = r?.mobiles ?? 0;
  return { ...r, total, mobiles, cls: classify(total, mobiles) };
}

// ============================================================
// Customer profile (used by Finance)
// ============================================================

async function customerProfile(db: D1Database, mobile: string, fullBank: boolean) {
  const stats = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'APPROVED'), 0) AS approved,
              COALESCE(SUM(status = 'REJECTED'), 0) AS rejected,
              COALESCE(SUM(status IN ('PENDING','IN_REVIEW')), 0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN total_approved_reward_lkr ELSE 0 END), 0) AS approved_lkr,
              COALESCE(SUM(CASE WHEN status IN ('PENDING','IN_REVIEW') THEN total_claimed_reward_lkr ELSE 0 END), 0) AS pending_lkr,
              COALESCE(MAX(risk_score), 0) AS max_risk,
              MIN(created_at_server) AS first_claim,
              MAX(created_at_server) AS last_claim
       FROM submissions WHERE mobile_number = ?`
    )
    .bind(mobile)
    .first<any>();

  const wallet = await db
    .prepare(`SELECT balance_lkr, status FROM wallets WHERE mobile_number = ?`)
    .bind(mobile)
    .first<any>();

  const paid = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_lkr), 0) AS total FROM payouts WHERE mobile_number = ? AND status = 'PAID'`)
    .bind(mobile)
    .first<any>();

  const { results: dealers } = await db
    .prepare(
      `SELECT COALESCE(d.name, 'Unknown') AS name, d.city AS city, COUNT(*) AS claims
       FROM submissions s LEFT JOIN dealers d ON d.id = s.dealer_id
       WHERE s.mobile_number = ? GROUP BY s.dealer_id ORDER BY claims DESC LIMIT 5`
    )
    .bind(mobile)
    .all<any>();

  const { results: deviceRows } = await db
    .prepare(
      `SELECT device_fingerprint_hash AS hash, COUNT(*) AS claims, MAX(device_raw_json) AS raw
       FROM submissions WHERE mobile_number = ? GROUP BY device_fingerprint_hash ORDER BY claims DESC LIMIT 10`
    )
    .bind(mobile)
    .all<any>();
  const devices = deviceRows.map((d) => ({ hash: d.hash, claims: d.claims, ...describeDevice(safeJson(d.raw)) }));

  const { results: recent } = await db
    .prepare(
      `SELECT id, status, created_at_server, total_claimed_reward_lkr, total_approved_reward_lkr, risk_score
       FROM submissions WHERE mobile_number = ? ORDER BY created_at_server DESC LIMIT 10`
    )
    .bind(mobile)
    .all<any>();

  const bank = await db
    .prepare(`SELECT account_name, account_number, bank_name, branch_name, updated_at FROM customer_bank_details WHERE mobile_number = ?`)
    .bind(mobile)
    .first<any>();

  return {
    mobile,
    stats,
    wallet: wallet || { balance_lkr: 0, status: "ACTIVE" },
    paidOut: paid,
    dealers,
    devices,
    recent,
    bank: bank ? { ...bank, account_number: fullBank ? bank.account_number : maskAccount(bank.account_number) } : null,
  };
}

// ============================================================
// Payout sync (fixes "over threshold but no payout shown")
// ============================================================

async function syncPayout(env: Env, mobile: string) {
  const threshold = parseFloat(env.WALLET_PAYOUT_THRESHOLD_LKR) || 1000;
  const wallet = await env.DB.prepare(`SELECT balance_lkr FROM wallets WHERE mobile_number = ?`)
    .bind(mobile)
    .first<{ balance_lkr: number }>();
  if (!wallet || wallet.balance_lkr < threshold) return;

  const pending = await env.DB.prepare(`SELECT id FROM payouts WHERE mobile_number = ? AND status = 'PENDING' LIMIT 1`)
    .bind(mobile)
    .first<{ id: number }>();

  if (pending) {
    await env.DB.prepare(`UPDATE payouts SET amount_lkr = ? WHERE id = ?`).bind(wallet.balance_lkr, pending.id).run();
  } else {
    await env.DB.prepare(`INSERT INTO payouts (mobile_number, amount_lkr, status) VALUES (?, ?, 'PENDING')`)
      .bind(mobile, wallet.balance_lkr)
      .run();
  }
  await env.DB.prepare(`UPDATE wallets SET status = 'PENDING_PAYOUT', updated_at = datetime('now') WHERE mobile_number = ?`)
    .bind(mobile)
    .run();
}

/**
 * Rebuild wallet balances from APPROVED claims minus already PAID payouts,
 * then create/refresh PENDING payout rows for anyone at/over threshold.
 * Fixes historical data where claims were approved but wallets/payouts were never written.
 */
async function rebuildWalletsFromApprovals(env: Env) {
  const threshold = parseFloat(env.WALLET_PAYOUT_THRESHOLD_LKR) || 1000;

  // Net balance per mobile = sum(approved rewards) - sum(paid payouts)
  const { results: rows } = await env.DB.prepare(
    `SELECT s.mobile_number,
            COALESCE(SUM(s.total_approved_reward_lkr), 0) AS approved_total,
            COALESCE((SELECT SUM(p.amount_lkr) FROM payouts p WHERE p.mobile_number = s.mobile_number AND p.status = 'PAID'), 0) AS paid_total
     FROM submissions s
     WHERE s.status = 'APPROVED'
     GROUP BY s.mobile_number`
  ).all<{ mobile_number: string; approved_total: number; paid_total: number }>();

  let walletsUpserted = 0;
  let overThreshold = 0;

  for (const r of rows) {
    const balance = Math.max(0, Number(r.approved_total || 0) - Number(r.paid_total || 0));
    await env.DB.prepare(
      `INSERT INTO wallets (mobile_number, balance_lkr, status, updated_at)
       VALUES (?, ?, 'ACTIVE', datetime('now'))
       ON CONFLICT(mobile_number) DO UPDATE SET
         balance_lkr = excluded.balance_lkr,
         updated_at = datetime('now')`
    )
      .bind(r.mobile_number, balance)
      .run();
    walletsUpserted++;
    if (balance >= threshold) overThreshold++;
  }

  await syncAllPayouts(env);

  return { walletsUpserted, overThreshold, threshold, mobilesFromApprovals: rows.length };
}

/** Creates missing payouts for every wallet at/over threshold and refreshes pending amounts. */
async function syncAllPayouts(env: Env) {
  const threshold = parseFloat(env.WALLET_PAYOUT_THRESHOLD_LKR) || 1000;
  const { results } = await env.DB.prepare(
    `SELECT w.mobile_number FROM wallets w
     WHERE w.balance_lkr >= ?
       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.mobile_number = w.mobile_number AND p.status = 'PENDING')`
  )
    .bind(threshold)
    .all<{ mobile_number: string }>();
  for (const r of results) await syncPayout(env, r.mobile_number);

  await env.DB.prepare(
    `UPDATE payouts SET amount_lkr = (SELECT balance_lkr FROM wallets w WHERE w.mobile_number = payouts.mobile_number)
     WHERE status = 'PENDING' AND EXISTS (SELECT 1 FROM wallets w WHERE w.mobile_number = payouts.mobile_number AND w.balance_lkr >= ?)`
  )
    .bind(threshold)
    .run();
}

// ============================================================
// Location parsing (Google Maps link, "lat, lng", DMS-ish text)
// ============================================================

const inRange = (lat: number, lng: number) =>
  isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// Sri Lanka guard: catches "lng, lat" pasted the wrong way round.
function normalise(lat: number, lng: number) {
  if (lat >= 79 && lat <= 82.5 && lng >= 5 && lng <= 10.5) return { lat: lng, lng: lat };
  return { lat, lng };
}

export function extractLatLng(text: string): { lat: number; lng: number } | null {
  let s = text.trim();
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  const cleaned = s.replace(/°/g, "").replace(/(\d)\s*[NnEe]\b/g, "$1");
  const num = "(-?\\d+(?:\\.\\d+)?)";
  const patterns: RegExp[] = [
    new RegExp(`!3d${num}!4d${num}`),
    new RegExp(`@${num},${num}`),
    new RegExp(`[?&](?:q|query|ll|sll|destination|center)=${num}[,+ ]\\s*${num}`),
    new RegExp(`\\[null,null,${num},${num}\\]`),
    new RegExp(`^\\s*\\(?\\s*${num}\\s*[,;\\s]\\s*${num}\\s*\\)?\\s*$`),
  ];
  for (const re of patterns) {
    const m = (re.source.startsWith("^") ? cleaned : s).match(re);
    if (!m) continue;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (inRange(lat, lng)) return normalise(lat, lng);
  }
  return null;
}

const GOOGLE_HOST = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co)$/i;

export async function resolveLocation(input: unknown): Promise<{ lat: number; lng: number } | null> {
  if (input == null) return null;
  const text = String(input).trim();
  if (!text) return null;
  const direct = extractLatLng(text);
  if (direct) return direct;
  if (!/^https?:\/\//i.test(text)) return null;

  // Short links (maps.app.goo.gl/...) need their redirect followed server-side.
  let url = text;
  for (let hop = 0; hop < 5; hop++) {
    let host = "";
    try { host = new URL(url).hostname; } catch { return null; }
    if (!GOOGLE_HOST.test(host)) return null;
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
    } catch {
      return null;
    }
    const loc = res.headers.get("Location");
    if (loc) {
      url = new URL(loc, url).toString();
      const p = extractLatLng(url);
      if (p) return p;
      continue;
    }
    const body = (await res.text()).slice(0, 300000);
    return extractLatLng(url) ?? extractLatLng(body);
  }
  return null;
}

async function coordsFrom(b: { latitude?: any; longitude?: any; location?: any }) {
  const lat = parseFloat(b.latitude);
  const lng = parseFloat(b.longitude);
  if (isFinite(lat) && isFinite(lng)) {
    return inRange(lat, lng) ? { point: normalise(lat, lng), invalid: false } : { point: null, invalid: true };
  }
  if (b.location == null || String(b.location).trim() === "") return { point: null, invalid: false };
  const p = await resolveLocation(b.location);
  return { point: p, invalid: !p };
}

function slugId(prefix: string, name: string): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 24);
  return `${prefix}-${slug}-${Math.floor(1000 + Math.random() * 8999)}`;
}

const LOCATION_HELP = "Location not recognised. Paste a Google Maps link or 'latitude, longitude' (e.g. 6.9271, 79.8612).";

// ============================================================
// Routes
// ============================================================

export function registerExtras(app: App) {
  // ---------- Device insights (Admin + Finance) ----------

  app.get("/api/device-insights", async (c) => {
    if (!(await anySession(c))) return c.json({ error: "Unauthorized" }, 401);

    const days = Math.min(365, Math.max(0, parseInt(c.req.query("days") || "30", 10) || 0));
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : "1970-01-01T00:00:00.000Z";

    const { results } = await c.env.DB.prepare(
      `SELECT device_fingerprint_hash AS hash,
              COUNT(*) AS submissions,
              COUNT(DISTINCT mobile_number) AS mobiles,
              COUNT(DISTINCT dealer_id) AS dealers,
              MIN(created_at_server) AS first_seen,
              MAX(created_at_server) AS last_seen,
              COALESCE(SUM(status = 'APPROVED'), 0) AS approved,
              COALESCE(SUM(status = 'REJECTED'), 0) AS rejected,
              COALESCE(SUM(status IN ('PENDING','IN_REVIEW')), 0) AS pending,
              COALESCE(MAX(risk_score), 0) AS max_risk,
              MAX(device_raw_json) AS raw,
              GROUP_CONCAT(DISTINCT mobile_number) AS mobile_list
       FROM submissions
       WHERE device_fingerprint_hash IS NOT NULL AND created_at_server >= ?
       GROUP BY device_fingerprint_hash
       ORDER BY submissions DESC, last_seen DESC
       LIMIT 300`
    )
      .bind(since)
      .all<any>();

    const devices = results.map((r) => {
      const { raw, mobile_list, ...rest } = r;
      return {
        ...rest,
        mobile_list: String(mobile_list || "").split(",").filter(Boolean),
        cls: classify(r.submissions, r.mobiles),
        summary: describeDevice(safeJson(raw)),
      };
    });

    const byCategory: Record<string, { devices: number; claims: number }> = {};
    const summary = { devices: devices.length, repeat: 0, shared: 0, single: 0, claims: 0 };
    for (const d of devices) {
      summary[d.cls as "repeat" | "shared" | "single"]++;
      summary.claims += d.submissions;
      const cat = d.summary.category;
      byCategory[cat] ??= { devices: 0, claims: 0 };
      byCategory[cat].devices++;
      byCategory[cat].claims += d.submissions;
    }

    return c.json({ summary: { ...summary, byCategory }, devices });
  });

  app.get("/api/device-insights/:hash", async (c) => {
    if (!(await anySession(c))) return c.json({ error: "Unauthorized" }, 401);
    const hash = c.req.param("hash");
    const activity = await deviceActivity(c.env.DB, hash);
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.mobile_number, d.name AS dealer_name, s.status, s.risk_score, s.created_at_server, s.total_claimed_reward_lkr
       FROM submissions s LEFT JOIN dealers d ON d.id = s.dealer_id
       WHERE s.device_fingerprint_hash = ? ORDER BY s.created_at_server DESC LIMIT 50`
    )
      .bind(hash)
      .all();
    return c.json({ activity, submissions: results });
  });

  // ---------- Finance: queue, detail, customer profile ----------

  app.get("/api/finance/queue", async (c) => {
    if (!(await financeSession(c, ["finance_staff", "finance_lead"]))) return c.json({ error: "Unauthorized" }, 401);
    const status = c.req.query("status") || "PENDING";
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.mobile_number, s.dealer_id, d.name AS dealer_name, s.status, s.risk_score, s.fraud_flags,
              s.created_at_server, s.total_claimed_reward_lkr,
              (SELECT COUNT(*) FROM submissions x WHERE x.device_fingerprint_hash = s.device_fingerprint_hash) AS device_submissions,
              (SELECT COUNT(DISTINCT x.mobile_number) FROM submissions x WHERE x.device_fingerprint_hash = s.device_fingerprint_hash) AS device_mobiles
       FROM submissions s LEFT JOIN dealers d ON d.id = s.dealer_id
       WHERE s.status = ? ORDER BY s.created_at_server ASC LIMIT 50`
    )
      .bind(status)
      .all();
    return c.json({ submissions: results });
  });

  app.get("/api/finance/submissions/:id", async (c) => {
    const session = await financeSession(c, ["finance_staff", "finance_lead"]);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const submission = await c.env.DB.prepare(
      `SELECT s.*, d.name AS dealer_name, d.city AS dealer_city, d.latitude AS dealer_lat, d.longitude AS dealer_lng
       FROM submissions s LEFT JOIN dealers d ON d.id = s.dealer_id WHERE s.id = ?`
    )
      .bind(id)
      .first<any>();
    if (!submission) return c.json({ error: "Not found" }, 404);

    const { results: items } = await c.env.DB.prepare(
      `SELECT si.id, si.product_id, p.name, si.claimed_qty, si.verified_qty, si.rate_lkr_snapshot, si.line_reward_lkr
       FROM submission_items si JOIN products p ON p.id = si.product_id WHERE si.submission_id = ?`
    )
      .bind(id)
      .all();

    const raw = safeJson(submission.device_raw_json);
    delete submission.device_raw_json;

    const device = {
      fingerprint: submission.device_fingerprint_hash,
      summary: describeDevice(raw),
      activity: submission.device_fingerprint_hash ? await deviceActivity(c.env.DB, submission.device_fingerprint_hash) : null,
    };
    const customer = await customerProfile(c.env.DB, submission.mobile_number, session.role === "finance_lead");

    return c.json({ submission, items, billImageUrl: `/api/finance/submissions/${id}/image`, device, customer });
  });

  app.get("/api/finance/customers/:mobile", async (c) => {
    const session = await financeSession(c, ["finance_staff", "finance_lead"]);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const profile = await customerProfile(c.env.DB, c.req.param("mobile"), session.role === "finance_lead");
    if (!profile.stats?.total) return c.json({ error: "Customer not found" }, 404);
    return c.json({ customer: profile });
  });

  // ---------- Finance: approve (double-approve guard + payout sync) ----------

  app.post("/api/finance/submissions/:id/approve", async (c) => {
    const session = await financeSession(c, ["finance_staff", "finance_lead"]);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const sub = await c.env.DB.prepare(`SELECT mobile_number, status FROM submissions WHERE id = ?`)
      .bind(id)
      .first<{ mobile_number: string; status: string }>();
    if (!sub) return c.json({ error: "Not found" }, 404);
    if (sub.status === "APPROVED") return c.json({ error: "This claim is already approved" }, 409);

    const totalRow = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(line_reward_lkr), 0) AS total FROM submission_items WHERE submission_id = ?`
    )
      .bind(id)
      .first<{ total: number }>();
    const totalApproved = totalRow?.total ?? 0;

    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE submissions SET status = 'APPROVED', total_approved_reward_lkr = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
      ).bind(totalApproved, session.sub, id),
      c.env.DB.prepare(
        `INSERT INTO wallets (mobile_number, balance_lkr) VALUES (?, ?)
         ON CONFLICT(mobile_number) DO UPDATE SET balance_lkr = balance_lkr + excluded.balance_lkr, updated_at = datetime('now')`
      ).bind(sub.mobile_number, totalApproved),
    ]);

    await syncPayout(c.env, sub.mobile_number);

    await c.env.DB.prepare(
      `INSERT INTO finance_audit_trail (actor, submission_id, action, details_json) VALUES (?,?,?,?)`
    )
      .bind(session.sub, id, "APPROVE", JSON.stringify({ totalApproved }))
      .run();

    return c.json({ ok: true, totalApproved });
  });

  // ---------- Finance Lead: payouts ----------

  app.get("/api/finance-lead/payouts", async (c) => {
    if (!(await financeSession(c, ["finance_lead"]))) return c.json({ error: "Unauthorized" }, 401);

    const status = (c.req.query("status") || "PENDING").toUpperCase();
    const threshold = parseFloat(c.env.WALLET_PAYOUT_THRESHOLD_LKR) || 1000;
    const doRebuild = c.req.query("rebuild") === "1";

    let rebuildStats: any = null;
    if (doRebuild) {
      // Force: recompute wallets from approved claims, then create payout rows
      rebuildStats = await rebuildWalletsFromApprovals(c.env);
    } else if (status === "PENDING" || status === "ALL") {
      await syncAllPayouts(c.env);
    }

    const { results } = await c.env.DB.prepare(
      `SELECT p.id, p.mobile_number, p.amount_lkr, p.status, p.erp_reference, p.bank_reference, p.bound_by, p.bound_at, p.created_at,
              b.account_name, b.account_number, b.bank_name, b.branch_name,
              w.balance_lkr AS wallet_balance,
              (SELECT COUNT(*) FROM submissions s WHERE s.mobile_number = p.mobile_number AND s.status = 'APPROVED') AS approved_claims
       FROM payouts p
       LEFT JOIN customer_bank_details b ON b.mobile_number = p.mobile_number
       LEFT JOIN wallets w ON w.mobile_number = p.mobile_number
       WHERE (? = 'ALL' OR p.status = ?)
       ORDER BY p.created_at DESC`
    )
      .bind(status, status)
      .all();

    const { results: eligible } = await c.env.DB.prepare(
      `SELECT w.mobile_number, w.balance_lkr, w.status AS wallet_status,
              (SELECT COUNT(*) FROM payouts p WHERE p.mobile_number = w.mobile_number AND p.status = 'PENDING') AS pending_payouts,
              (SELECT COUNT(*) FROM customer_bank_details b WHERE b.mobile_number = w.mobile_number) AS has_bank
       FROM wallets w
       WHERE w.balance_lkr >= ?
       ORDER BY w.balance_lkr DESC
       LIMIT 100`
    )
      .bind(threshold)
      .all();

    // Always show top approved totals so lead can see why list is empty
    const { results: topApproved } = await c.env.DB.prepare(
      `SELECT mobile_number,
              COALESCE(SUM(total_approved_reward_lkr), 0) AS approved_total,
              COUNT(*) AS approved_claims
       FROM submissions
       WHERE status = 'APPROVED'
       GROUP BY mobile_number
       ORDER BY approved_total DESC
       LIMIT 30`
    ).all();

    const walletCount = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM wallets`).first<{ n: number }>();
    const walletOver = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM wallets WHERE balance_lkr >= ?`).bind(threshold).first<{ n: number }>();

    return c.json({
      payouts: results,
      eligible,
      topApproved,
      stats: {
        wallets: walletCount?.n ?? 0,
        walletsOverThreshold: walletOver?.n ?? 0,
        pendingPayouts: results.filter((p: any) => p.status === "PENDING").length,
      },
      rebuildStats,
      threshold,
      apiVersion: "2026-09-24d-customers",
      synced: true,
    });
  });

  app.post("/api/finance-lead/payouts/rebuild", async (c) => {
    const session = await financeSession(c, ["finance_lead"]);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const stats = await rebuildWalletsFromApprovals(c.env);
    await c.env.DB.prepare(
      `INSERT INTO finance_audit_trail (actor, submission_id, action, details_json) VALUES (?,?,?,?)`
    )
      .bind(session.sub, null, "REBUILD_WALLETS_PAYOUTS", JSON.stringify(stats))
      .run();
    return c.json({ ok: true, ...stats, apiVersion: "2026-09-24d-customers" });
  });


  // ---------- Customer summaries (mobile-based rollup for Finance) ----------
  app.get("/api/finance/customer-summaries", async (c) => {
    if (!(await financeSession(c, ["finance_staff", "finance_lead"]))) return c.json({ error: "Unauthorized" }, 401);

    const threshold = parseFloat(c.env.WALLET_PAYOUT_THRESHOLD_LKR) || 1000;
    const q = (c.req.query("q") || "").trim();
    const sort = (c.req.query("sort") || "approved").toLowerCase();
    const limit = Math.min(500, Math.max(20, parseInt(c.req.query("limit") || "100", 10) || 100));

    // Core rollup per mobile
    let sql = `
      SELECT s.mobile_number,
             COUNT(*) AS total_submissions,
             COALESCE(SUM(s.status = 'APPROVED'), 0) AS approved_count,
             COALESCE(SUM(s.status = 'REJECTED'), 0) AS rejected_count,
             COALESCE(SUM(s.status IN ('PENDING','IN_REVIEW')), 0) AS pending_count,
             COALESCE(SUM(CASE WHEN s.status = 'APPROVED' THEN s.total_approved_reward_lkr ELSE 0 END), 0) AS approved_lkr,
             COALESCE(SUM(CASE WHEN s.status IN ('PENDING','IN_REVIEW') THEN s.total_claimed_reward_lkr ELSE 0 END), 0) AS pending_lkr,
             COALESCE(SUM(CASE WHEN s.status = 'REJECTED' THEN s.total_claimed_reward_lkr ELSE 0 END), 0) AS rejected_lkr,
             COALESCE(SUM(s.total_claimed_reward_lkr), 0) AS claimed_lkr,
             COALESCE(MAX(s.risk_score), 0) AS max_risk,
             COALESCE(SUM(CASE WHEN s.risk_score >= 60 THEN 1 ELSE 0 END), 0) AS high_risk_count,
             COALESCE(SUM(CASE WHEN s.fraud_flags IS NOT NULL AND s.fraud_flags != '' THEN 1 ELSE 0 END), 0) AS flagged_count,
             COALESCE(SUM(CASE WHEN s.fraud_flags LIKE '%GEOGRAPHIC_MISMATCH%' THEN 1 ELSE 0 END), 0) AS geo_mismatch_count,
             COALESCE(SUM(CASE WHEN s.fraud_flags LIKE '%DUPLICATE%' THEN 1 ELSE 0 END), 0) AS duplicate_count,
             COALESCE(SUM(CASE WHEN s.fraud_flags LIKE '%HIGH_VELOCITY%' THEN 1 ELSE 0 END), 0) AS velocity_count,
             COUNT(DISTINCT s.device_fingerprint_hash) AS device_count,
             COUNT(DISTINCT s.dealer_id) AS dealer_count,
             MIN(s.created_at_server) AS first_seen,
             MAX(s.created_at_server) AS last_seen
      FROM submissions s
    `;
    const binds: any[] = [];
    if (q) {
      sql += ` WHERE s.mobile_number LIKE ? `;
      binds.push(`%${q}%`);
    }
    sql += ` GROUP BY s.mobile_number `;

    const orderMap: Record<string, string> = {
      approved: "approved_lkr DESC",
      pending: "pending_lkr DESC",
      risk: "max_risk DESC",
      submissions: "total_submissions DESC",
      recent: "last_seen DESC",
    };
    sql += ` ORDER BY ${orderMap[sort] || orderMap.approved} LIMIT ? `;
    binds.push(limit);

    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<any>();

    // Attach wallet + bank + paid
    const customers = [];
    for (const r of results) {
      const wallet = await c.env.DB.prepare(`SELECT balance_lkr, status FROM wallets WHERE mobile_number = ?`)
        .bind(r.mobile_number)
        .first<any>();
      const paid = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_lkr), 0) AS total FROM payouts WHERE mobile_number = ? AND status = 'PAID'`
      )
        .bind(r.mobile_number)
        .first<any>();
      const pendingPay = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_lkr), 0) AS total FROM payouts WHERE mobile_number = ? AND status = 'PENDING'`
      )
        .bind(r.mobile_number)
        .first<any>();
      const bank = await c.env.DB.prepare(
        `SELECT account_name, bank_name FROM customer_bank_details WHERE mobile_number = ?`
      )
        .bind(r.mobile_number)
        .first<any>();

      const approved = Number(r.approved_lkr || 0);
      const walletBal = wallet ? Number(wallet.balance_lkr || 0) : 0;
      const paidTotal = Number(paid?.total || 0);
      const net = Math.max(0, approved - paidTotal);

      customers.push({
        ...r,
        wallet_balance: walletBal,
        wallet_status: wallet?.status || "NONE",
        paid_lkr: paidTotal,
        paid_count: paid?.n || 0,
        pending_payout_lkr: Number(pendingPay?.total || 0),
        pending_payout_count: pendingPay?.n || 0,
        has_bank: !!bank,
        bank_name: bank?.bank_name || null,
        account_name: bank?.account_name || null,
        net_payable: net,
        payout_eligible: net >= threshold,
        suspect: Number(r.high_risk_count) > 0 || Number(r.flagged_count) > 0 || Number(r.device_count) > 2,
      });
    }

    const totals = {
      customers: customers.length,
      approved_lkr: customers.reduce((a, x) => a + Number(x.approved_lkr || 0), 0),
      pending_lkr: customers.reduce((a, x) => a + Number(x.pending_lkr || 0), 0),
      eligible: customers.filter((x) => x.payout_eligible).length,
      suspects: customers.filter((x) => x.suspect).length,
      with_pending_payout: customers.filter((x) => x.pending_payout_count > 0).length,
    };

    return c.json({
      customers,
      totals,
      threshold,
      apiVersion: "2026-09-24d-customers",
    });
  });

  app.get("/api/version", async (c) => {
    return c.json({
      apiVersion: "2026-09-24d-customers",
      features: ["device-insights", "payout-sync", "wallet-rebuild", "location-parse", "customer-profile", "bank-prefill"],
    });
  });

  app.post("/api/finance-lead/payouts/export-log", async (c) => {
    const session = await financeSession(c, ["finance_lead"]);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ format?: string; filter?: string; rows?: number }>().catch(() => ({} as any));
    await c.env.DB.prepare(
      `INSERT INTO finance_audit_trail (actor, submission_id, action, details_json) VALUES (?,?,?,?)`
    )
      .bind(session.sub, null, "EXPORT_PAYOUTS", JSON.stringify(body))
      .run();
    return c.json({ ok: true });
  });

  app.post("/api/finance-lead/payouts/:id/bind", async (c) => {
    const session = await financeSession(c, ["finance_lead"]);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const body = await c.req.json<{ erpReference?: string; bankReference?: string }>();
    const erpReference = (body.erpReference || "").trim();
    const bankReference = (body.bankReference || "").trim();
    if (!erpReference || !bankReference) return c.json({ error: "ERP reference and bank reference are required" }, 400);

    const payout = await c.env.DB.prepare(`SELECT mobile_number, amount_lkr, status FROM payouts WHERE id = ?`)
      .bind(id)
      .first<{ mobile_number: string; amount_lkr: number; status: string }>();
    if (!payout) return c.json({ error: "Not found" }, 404);
    if (payout.status !== "PENDING") return c.json({ error: "This payout is already marked as paid" }, 409);

    const bank = await c.env.DB.prepare(`SELECT mobile_number FROM customer_bank_details WHERE mobile_number = ?`)
      .bind(payout.mobile_number)
      .first();
    if (!bank) return c.json({ error: "Customer has not submitted bank details yet — cannot bind payout." }, 400);

    // Deduct only what was paid (not zero the wallet) so claims approved after the
    // payout was created are not wiped out.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE payouts SET status = 'PAID', erp_reference = ?, bank_reference = ?, bound_by = ?, bound_at = datetime('now')
         WHERE id = ? AND status = 'PENDING'`
      ).bind(erpReference, bankReference, session.sub, id),
      c.env.DB.prepare(
        `UPDATE wallets SET balance_lkr = MAX(0, balance_lkr - ?), status = 'ACTIVE', updated_at = datetime('now') WHERE mobile_number = ?`
      ).bind(payout.amount_lkr, payout.mobile_number),
    ]);
    await syncPayout(c.env, payout.mobile_number); // leftover balance may still be over threshold

    await c.env.DB.prepare(
      `INSERT INTO finance_audit_trail (actor, submission_id, action, details_json) VALUES (?,?,?,?)`
    )
      .bind(session.sub, null, "BIND_PAYOUT_REF", JSON.stringify({ payoutId: id, erpReference, bankReference }))
      .run();

    return c.json({ ok: true });
  });

  // ---------- Customer: bank details (remembered per mobile number) ----------

  async function owns(db: D1Database, mobile: string, submissionId: string) {
    const row = await db.prepare(`SELECT id FROM submissions WHERE id = ? AND mobile_number = ?`).bind(submissionId, mobile).first();
    return !!row;
  }

  app.get("/api/track/bank-details", async (c) => {
    const mobile = c.req.query("mobile");
    const submissionId = c.req.query("submissionId");
    if (!mobile || !submissionId) return c.json({ error: "mobile and submissionId are required" }, 400);
    if (!(await owns(c.env.DB, mobile, submissionId))) return c.json({ error: "Not found" }, 404);

    const d = await c.env.DB.prepare(
      `SELECT account_name, account_number, bank_name, branch_name, updated_at FROM customer_bank_details WHERE mobile_number = ?`
    )
      .bind(mobile)
      .first<any>();
    if (!d) return c.json({ hasDetails: false });
    return c.json({ hasDetails: true, details: { ...d, account_number: maskAccount(d.account_number) } });
  });

  app.post("/api/track/bank-details", async (c) => {
    const b = await c.req.json<{
      mobile: string; submissionId: string; accountName: string; accountNumber?: string; bankName: string; branchName?: string;
    }>();
    if (!b.mobile || !b.submissionId) return c.json({ error: "mobile and submissionId are required" }, 400);
    if (!(await owns(c.env.DB, b.mobile, b.submissionId))) return c.json({ error: "Not found" }, 404);

    const existing = await c.env.DB.prepare(`SELECT account_number FROM customer_bank_details WHERE mobile_number = ?`)
      .bind(b.mobile)
      .first<{ account_number: string }>();

    // Blank account number on an update = keep the saved one (the customer only ever sees it masked).
    const accountNumber = (b.accountNumber || "").trim() || existing?.account_number || "";
    if (!b.accountName?.trim() || !accountNumber || !b.bankName?.trim()) {
      return c.json({ error: "Account name, account number, and bank name are required" }, 400);
    }

    await c.env.DB.prepare(`INSERT OR IGNORE INTO wallets (mobile_number) VALUES (?)`).bind(b.mobile).run();
    await c.env.DB.prepare(
      `INSERT INTO customer_bank_details (mobile_number, account_name, account_number, bank_name, branch_name)
       VALUES (?,?,?,?,?)
       ON CONFLICT(mobile_number) DO UPDATE SET
         account_name = excluded.account_name, account_number = excluded.account_number,
         bank_name = excluded.bank_name, branch_name = excluded.branch_name, updated_at = datetime('now')`
    )
      .bind(b.mobile, b.accountName.trim(), accountNumber, b.bankName.trim(), b.branchName?.trim() || null)
      .run();

    return c.json({ ok: true });
  });

  // ---------- Admin: Customer (dealer) master with simple location input ----------

  app.post("/api/admin/dealers", async (c) => {
    const session = await adminSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const b = await c.req.json<any>();
    if (!b.name) return c.json({ error: "Customer name is required" }, 400);
    const { point, invalid } = await coordsFrom(b);
    if (invalid) return c.json({ error: LOCATION_HELP }, 400);

    const id = slugId("DLR", b.name);
    try {
      await c.env.DB.prepare(
        `INSERT INTO dealers (id, customer_code, name, contact_phone, address, city, latitude, longitude) VALUES (?,?,?,?,?,?,?,?)`
      )
        .bind(id, b.customerCode || null, b.name, b.contactPhone || null, b.address || null, b.city || null, point?.lat ?? null, point?.lng ?? null)
        .run();
    } catch (e: any) {
      if (/UNIQUE/i.test(e.message || "")) return c.json({ error: "Customer code already exists" }, 409);
      throw e;
    }

    await c.env.DB.prepare(`INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`)
      .bind(session.sub, "CREATE_DEALER", "dealer", id, JSON.stringify({ ...b, latitude: point?.lat, longitude: point?.lng }))
      .run();

    return c.json({ ok: true, id, latitude: point?.lat ?? null, longitude: point?.lng ?? null });
  });

  app.patch("/api/admin/dealers/:id", async (c) => {
    const session = await adminSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const b = await c.req.json<any>();
    const { point, invalid } = await coordsFrom(b);
    if (invalid) return c.json({ error: LOCATION_HELP }, 400);

    await c.env.DB.prepare(
      `UPDATE dealers SET
         customer_code = COALESCE(?, customer_code), name = COALESCE(?, name), contact_phone = COALESCE(?, contact_phone),
         address = COALESCE(?, address), city = COALESCE(?, city), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(
        b.customerCode || null, b.name || null, b.contactPhone || null, b.address || null, b.city || null,
        point?.lat ?? null, point?.lng ?? null, id
      )
      .run();

    await c.env.DB.prepare(`INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`)
      .bind(session.sub, "EDIT_DEALER", "dealer", id, JSON.stringify({ ...b, latitude: point?.lat, longitude: point?.lng }))
      .run();

    return c.json({ ok: true, latitude: point?.lat ?? null, longitude: point?.lng ?? null });
  });

  app.post("/api/admin/dealers/bulk", async (c) => {
    const session = await adminSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const { rows } = await c.req.json<{ rows: any[] }>();
    if (!Array.isArray(rows) || rows.length === 0) return c.json({ error: "No rows provided" }, 400);
    if (rows.length > 200) return c.json({ error: "Send at most 200 rows per request" }, 400);

    let created = 0;
    let updated = 0;
    const errors: { row: number; error: string }[] = [];
    const warnings: { row: number; warning: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.name) { errors.push({ row: i + 1, error: "Missing customer name" }); continue; }

      const { point, invalid } = await coordsFrom(row);
      if (invalid) warnings.push({ row: i + 1, warning: `${row.name}: location not recognised — saved without coordinates` });

      try {
        const existing = row.customerCode
          ? await c.env.DB.prepare(`SELECT id FROM dealers WHERE customer_code = ?`).bind(row.customerCode).first<{ id: string }>()
          : null;

        if (existing) {
          await c.env.DB.prepare(
            `UPDATE dealers SET name = ?, contact_phone = COALESCE(?, contact_phone), address = COALESCE(?, address),
               city = COALESCE(?, city), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
               active = 1, updated_at = datetime('now') WHERE id = ?`
          )
            .bind(row.name, row.contactPhone || null, row.address || null, row.city || null, point?.lat ?? null, point?.lng ?? null, existing.id)
            .run();
          updated++;
        } else {
          await c.env.DB.prepare(
            `INSERT INTO dealers (id, customer_code, name, contact_phone, address, city, latitude, longitude) VALUES (?,?,?,?,?,?,?,?)`
          )
            .bind(slugId("DLR", row.name), row.customerCode || null, row.name, row.contactPhone || null, row.address || null, row.city || null, point?.lat ?? null, point?.lng ?? null)
            .run();
          created++;
        }
      } catch (e: any) {
        errors.push({ row: i + 1, error: e.message || "Insert failed" });
      }
    }

    await c.env.DB.prepare(`INSERT INTO system_audit_log (actor, action, entity_type, entity_id, details_json) VALUES (?,?,?,?,?)`)
      .bind(session.sub, "BULK_UPLOAD_DEALERS", "dealer", "bulk", JSON.stringify({ created, updated, errorCount: errors.length, warningCount: warnings.length }))
      .run();

    return c.json({ created, updated, errors, warnings });
  });
}
