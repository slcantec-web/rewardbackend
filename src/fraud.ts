import type { Env, DeviceBlueprint, FraudEvaluation, D1Database } from "./types";
import { computePerceptualHash, hammingDistanceHex, NEAR_DUPLICATE_THRESHOLD } from "./phash";

/**
 * Haversine distance in km between two lat/lng points.
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Exact-byte content hash (SHA-256) — catches *identical* re-uploads reliably.
 * For near-duplicate detection (re-compressed / re-cropped versions of the
 * same bill), see `computeNearDuplicateHash` below, which uses a real
 * DCT-based perceptual hash.
 */
export async function perceptualHashFromBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as any);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Real perceptual hash (pHash) for near-duplicate bill detection — catches
 * recompressed, lightly cropped, or resized re-uploads of the same photo
 * that an exact SHA-256 hash would miss. Degrades gracefully (returns null)
 * on undecodable input rather than failing the submission — exact-hash
 * duplicate detection still applies regardless.
 */
export async function computeNearDuplicateHash(bytes: Uint8Array): Promise<string | null> {
  try {
    return computePerceptualHash(bytes);
  } catch (err) {
    console.error("pHash computation failed (non-fatal):", err);
    return null;
  }
}

/**
 * Derives a stable device fingerprint hash from the client-submitted blueprint.
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalize Sri Lankan (and general) mobile numbers so "0771234567", "771234567",
 * "+94771234567", "94 77 123 4567" all compare as the same identity.
 * Returns digits-only local form preferred as 0XXXXXXXXX when possible.
 */
export function normalizeMobile(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  // Keep leading + briefly for country-code detection, strip other junk
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  // Sri Lanka country code
  if (s.startsWith("94") && s.length >= 11) {
    s = "0" + s.slice(2);
  }
  // 9-digit local starting with 7 → prefix 0
  if (/^7\d{8}$/.test(s)) s = "0" + s;
  // Final: digits only
  s = s.replace(/\D/g, "");
  return s;
}

/**
 * Device binding hash.
 * Prefer localStorage installId (stable across claims on the same browser).
 * Hardware blueprint alone is too weak: same phone models collide and UA/canvas can drift.
 */
export async function deviceFingerprintHash(device: DeviceBlueprint): Promise<string> {
  const installId = String((device as any).installId || "").trim();
  if (installId) {
    // v3 = installId-primary binding (intentional version bump so new claims share one key per browser)
    return sha256Hex(JSON.stringify({ v: 3, installId }));
  }
  // Fallback when storage is blocked — best-effort hardware signature
  const material = JSON.stringify({
    v: 3,
    ua: device.userAgent,
    platform: device.platform,
    lang: device.language,
    screen: device.screen,
    cores: device.hardwareConcurrency,
    mem: device.deviceMemory,
    gl: device.webglRenderer,
    canvas: device.canvasFingerprint,
  });
  return sha256Hex(material);
}

export interface FraudCheckInput {
  env: Env;
  db: D1Database;
  dealerLat: number | null;
  dealerLng: number | null;
  gpsLat: number;
  gpsLng: number;
  createdAtClient: string;
  createdAtServer: string;
  deviceHash: string;
  imageHash: string;
  /** Perceptual hash for near-duplicate image detection — null if it couldn't be computed. */
  nearHash?: string | null;
  /** Submission IP address (server-derived, e.g. CF-Connecting-IP) — used for rate limiting. */
  clientIp?: string;
  /** Contact number on this claim — used to detect same device + different mobiles */
  mobileNumber?: string;
  /** Client localStorage install id — strongest same-browser binding */
  installId?: string;
}

export async function evaluateFraud(input: FraudCheckInput): Promise<FraudEvaluation> {
  const {
    env,
    db,
    dealerLat,
    dealerLng,
    gpsLat,
    gpsLng,
    createdAtClient,
    createdAtServer,
    deviceHash,
    imageHash,
    nearHash,
    clientIp,
    mobileNumber,
  } = input;

  const flags: string[] = [];
  let riskScore = 0;

  // --- Layer 1: duplicate image hash lock (exact byte match) ---
  const dupRow = await db
    .prepare(`SELECT id FROM submissions WHERE bill_image_hash = ? LIMIT 1`)
    .bind(imageHash)
    .first<{ id: string }>();
  const duplicateImage = !!dupRow;
  if (duplicateImage) {
    flags.push("FLAG_DUPLICATE_BILL_IMAGE");
    riskScore += 60;
  }

  // --- Layer 1b: near-duplicate via pHash (skip if exact duplicate already found) ---
  // Cap scan size for latency — last ~400 recent hashed bills (was 3000).
  let nearDuplicateImage = false;
  if (nearHash && !duplicateImage) {
    const { results: recentHashes } = await db
      .prepare(
        `SELECT bill_image_phash FROM submissions
         WHERE bill_image_phash IS NOT NULL AND bill_image_phash != ''
         ORDER BY created_at_server DESC LIMIT 400`
      )
      .all<{ bill_image_phash: string }>();
    for (const row of recentHashes || []) {
      const dist = hammingDistanceHex(nearHash, row.bill_image_phash);
      if (dist >= 0 && dist <= NEAR_DUPLICATE_THRESHOLD) {
        nearDuplicateImage = true;
        break;
      }
    }
    if (nearDuplicateImage) {
      flags.push("FLAG_DUPLICATE_BILL_IMAGE_NEAR");
      riskScore += 45;
    }
  }

  // --- Layer 2: geofence ---
  let distanceKm: number | null = null;
  let geographicMismatch = false;
  const radius = parseFloat(env.GEOFENCE_RADIUS_KM || "5");
  if (dealerLat != null && dealerLng != null) {
    distanceKm = haversineKm(dealerLat, dealerLng, gpsLat, gpsLng);
    if (distanceKm > radius) {
      geographicMismatch = true;
      flags.push("GEOGRAPHIC_MISMATCH");
      riskScore += 25;
    }
  }

  // --- Timestamp delta ---
  const clientMs = new Date(createdAtClient).getTime();
  const serverMs = new Date(createdAtServer).getTime();
  const timeDeltaSeconds = Math.abs((serverMs - clientMs) / 1000);
  if (timeDeltaSeconds > 300) {
    flags.push("FLAG_CLOCK_MISMATCH");
    riskScore += 10;
  }

  // --- Layers 3–5 in parallel: device velocity, multi-mobile, IP velocity ---
  const windowMinutes = parseInt(env.VELOCITY_WINDOW_MINUTES || "10", 10);
  const maxSubmissions = parseInt(env.VELOCITY_MAX_SUBMISSIONS || "3", 10);
  const windowStart = new Date(serverMs - windowMinutes * 60 * 1000).toISOString();
  const installIdFromInput = (input as any).installId ? String((input as any).installId).trim() : "";
  const mobileNorm = normalizeMobile(mobileNumber);
  const ipWindowMinutes = parseInt(env.IP_VELOCITY_WINDOW_MINUTES || "10", 10);
  const ipMaxSubmissions = parseInt(env.IP_VELOCITY_MAX_SUBMISSIONS || "5", 10);
  const ipWindowStart = new Date(serverMs - ipWindowMinutes * 60 * 1000).toISOString();

  const velocityPromise = deviceHash
    ? db
        .prepare(
          `SELECT COUNT(*) as cnt FROM submissions WHERE device_fingerprint_hash = ? AND created_at_server >= ?`
        )
        .bind(deviceHash, windowStart)
        .first<{ cnt: number }>()
    : Promise.resolve(null);

  const multiMobilePromise = (async (): Promise<string[]> => {
    if (!deviceHash || !mobileNorm) return [];
    if (installIdFromInput) {
      const { results: rows } = await db
        .prepare(
          `SELECT DISTINCT mobile_number AS m
           FROM submissions
           WHERE mobile_number IS NOT NULL
             AND length(trim(mobile_number)) > 0
             AND (
               device_fingerprint_hash = ?
               OR json_extract(device_raw_json, '$.installId') = ?
             )`
        )
        .bind(deviceHash, installIdFromInput)
        .all<{ m: string }>();
      return (rows || []).map((r) => r.m);
    }
    const { results: rows } = await db
      .prepare(
        `SELECT DISTINCT mobile_number AS m
         FROM submissions
         WHERE device_fingerprint_hash = ?
           AND mobile_number IS NOT NULL
           AND length(trim(mobile_number)) > 0`
      )
      .bind(deviceHash)
      .all<{ m: string }>();
    return (rows || []).map((r) => r.m);
  })();

  const ipPromise =
    clientIp && clientIp !== "unknown"
      ? db
          .prepare(`SELECT COUNT(*) as cnt FROM submissions WHERE client_ip = ? AND created_at_server >= ?`)
          .bind(clientIp, ipWindowStart)
          .first<{ cnt: number }>()
      : Promise.resolve(null);

  const [recentCountRow, priorMobiles, ipCountRow] = await Promise.all([
    velocityPromise,
    multiMobilePromise,
    ipPromise,
  ]);

  const recentCount = recentCountRow?.cnt ?? 0;
  const highVelocity = recentCount >= maxSubmissions;
  if (highVelocity) {
    flags.push("FLAG_HIGH_VELOCITY_DEVICE");
    riskScore += 30;
  }

  let multiMobileDevice = false;
  if (priorMobiles.length > 0) {
    const otherNorms = new Set(
      priorMobiles.map(normalizeMobile).filter((m) => m && m !== mobileNorm)
    );
    if (otherNorms.size > 0) {
      multiMobileDevice = true;
      flags.push("FLAG_DEVICE_MULTI_MOBILE");
      riskScore += 70;
    }
  }

  let highVelocityIp = false;
  if (ipCountRow) {
    const ipCount = ipCountRow.cnt ?? 0;
    highVelocityIp = ipCount >= ipMaxSubmissions;
    if (highVelocityIp) {
      flags.push("FLAG_HIGH_VELOCITY_IP");
      riskScore += 20;
    }
  }

  riskScore = Math.min(100, riskScore);

  return {
    distanceKm,
    geographicMismatch,
    timeDeltaSeconds,
    highVelocity,
    duplicateImage,
    nearDuplicateImage,
    multiMobileDevice,
    highVelocityIp,
    riskScore,
    flags,
  };
}

// ============================================================
// Security events log — blocked / suspicious attempts for dossier
// ============================================================

export type SecurityEventType =
  | "DAILY_CLAIM_LIMIT"
  | "DEVICE_MULTI_MOBILE"
  | "BANK_ACCOUNT_COLLISION"
  | "HIGH_VELOCITY_DEVICE"
  | "HIGH_VELOCITY_IP"
  | "DESKTOP_BLOCKED"
  | "DUPLICATE_BILL";

let _securityTableReady = false;

export async function ensureSecurityEventsTable(db: D1Database): Promise<void> {
  if (_securityTableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        mobile_number TEXT,
        related_mobile TEXT,
        client_ip TEXT,
        device_hash TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_security_events_mobile ON security_events(mobile_number)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at)`).run();
  } catch {
    /* index may already exist */
  }
  _securityTableReady = true;
}

export async function logSecurityEvent(
  db: D1Database,
  opts: {
    eventType: SecurityEventType | string;
    mobile?: string | null;
    relatedMobile?: string | null;
    clientIp?: string | null;
    deviceHash?: string | null;
    details?: Record<string, unknown> | null;
  }
): Promise<void> {
  try {
    await ensureSecurityEventsTable(db);
    await db
      .prepare(
        `INSERT INTO security_events (event_type, mobile_number, related_mobile, client_ip, device_hash, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        opts.eventType,
        opts.mobile ? normalizeMobile(opts.mobile) || opts.mobile : null,
        opts.relatedMobile ? normalizeMobile(opts.relatedMobile) || opts.relatedMobile : null,
        opts.clientIp || null,
        opts.deviceHash || null,
        opts.details ? JSON.stringify(opts.details) : null
      )
      .run();
  } catch (err) {
    console.error("logSecurityEvent failed (non-fatal):", err);
  }
}

/** Default daily claim cap per mobile (matches public UI copy). Overridable via env DAILY_CLAIM_LIMIT. */
export function dailyClaimLimit(env: { DAILY_CLAIM_LIMIT?: string }): number {
  const n = parseInt(env.DAILY_CLAIM_LIMIT || "3", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

export async function countClaimsToday(db: D1Database, mobile: string): Promise<number> {
  const m = normalizeMobile(mobile) || mobile;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM submissions
       WHERE mobile_number = ?
         AND date(created_at_server) = date('now')`
    )
    .bind(m)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

export async function securityReportForMobile(db: D1Database, mobile: string): Promise<{
  events: any[];
  summary: {
    daily_limit_hits: number;
    bank_collision_attempts: number;
    device_multi_mobile_blocks: number;
    high_velocity_flags: number;
    other_blocks: number;
    total_events: number;
  };
  bank_collisions: { attempted_by: string; account_hint?: string; at: string }[];
  claims_today: number;
  daily_limit: number;
}> {
  await ensureSecurityEventsTable(db);
  const m = normalizeMobile(mobile) || mobile;

  const { results: events } = await db
    .prepare(
      `SELECT id, event_type, mobile_number, related_mobile, client_ip, device_hash, details_json, created_at
       FROM security_events
       WHERE mobile_number = ? OR related_mobile = ?
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .bind(m, m)
    .all<any>();

  const list = events || [];
  const summary = {
    daily_limit_hits: 0,
    bank_collision_attempts: 0,
    device_multi_mobile_blocks: 0,
    high_velocity_flags: 0,
    other_blocks: 0,
    total_events: list.length,
  };
  const bank_collisions: { attempted_by: string; account_hint?: string; at: string }[] = [];

  for (const e of list) {
    if (e.event_type === "DAILY_CLAIM_LIMIT") summary.daily_limit_hits++;
    else if (e.event_type === "BANK_ACCOUNT_COLLISION") {
      summary.bank_collision_attempts++;
      let hint: string | undefined;
      try {
        const d = e.details_json ? JSON.parse(e.details_json) : {};
        hint = d.account_hint || d.accountNumberMasked || undefined;
      } catch {
        /* ignore */
      }
      bank_collisions.push({
        attempted_by: e.mobile_number || "—",
        account_hint: hint,
        at: e.created_at,
      });
    } else if (e.event_type === "DEVICE_MULTI_MOBILE") summary.device_multi_mobile_blocks++;
    else if (e.event_type === "HIGH_VELOCITY_DEVICE" || e.event_type === "HIGH_VELOCITY_IP") summary.high_velocity_flags++;
    else summary.other_blocks++;
  }

  const claims_today = await countClaimsToday(db, m);

  return {
    events: list.map((e) => ({
      ...e,
      details: (() => {
        try {
          return e.details_json ? JSON.parse(e.details_json) : null;
        } catch {
          return null;
        }
      })(),
    })),
    summary,
    bank_collisions,
    claims_today,
    daily_limit: 3,
  };
}
