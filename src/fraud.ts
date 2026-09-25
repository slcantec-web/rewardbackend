import type { Env, DeviceBlueprint, FraudEvaluation, D1Database } from "./types";

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
 * Simple average-hash (aHash) perceptual hash for duplicate-image detection.
 * NOTE: This is a lightweight placeholder — for production, precompute a
 * proper pHash (DCT-based) client-side or via an image-processing library
 * bound to the Worker, then pass the hash in in place of recomputation here.
 * This function hashes the raw bytes' downsampled luminance as a stand-in.
 */
export async function perceptualHashFromBytes(bytes: Uint8Array): Promise<string> {
  // Cheap content hash (SHA-256) — catches *identical* re-uploads reliably.
  // Swap in a true pHash implementation for near-duplicate detection
  // (re-compressed / re-cropped versions of the same bill).
  const digest = await crypto.subtle.digest("SHA-256", bytes as any);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derives a stable device fingerprint hash from the client-submitted blueprint.
 */
export async function deviceFingerprintHash(device: DeviceBlueprint): Promise<string> {
  // Stable material only — no timestamps / random values.
  // installId (localStorage) strengthens uniqueness when canvas is blocked or identical hardware collides.
  const material = JSON.stringify({
    ua: device.userAgent,
    platform: device.platform,
    lang: device.language,
    screen: device.screen,
    cores: device.hardwareConcurrency,
    mem: device.deviceMemory,
    gl: device.webglRenderer,
    canvas: device.canvasFingerprint,
    installId: (device as any).installId || null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  /** Contact number on this claim — used to detect same device + different mobiles */
  mobileNumber?: string;
}

export async function evaluateFraud(input: FraudCheckInput): Promise<FraudEvaluation> {
  const { env, db, dealerLat, dealerLng, gpsLat, gpsLng, createdAtClient, createdAtServer, deviceHash, imageHash, mobileNumber } =
    input;

  const flags: string[] = [];
  let riskScore = 0;

  // --- Layer 1: duplicate image hash lock ---
  const dupRow = await db
    .prepare(`SELECT id FROM submissions WHERE bill_image_hash = ? LIMIT 1`)
    .bind(imageHash)
    .first<{ id: string }>();
  const duplicateImage = !!dupRow;
  if (duplicateImage) {
    flags.push("FLAG_DUPLICATE_BILL_IMAGE");
    riskScore += 60;
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

  // --- Layer 3: high-velocity device capping ---
  const windowMinutes = parseInt(env.VELOCITY_WINDOW_MINUTES || "10", 10);
  const maxSubmissions = parseInt(env.VELOCITY_MAX_SUBMISSIONS || "3", 10);
  const windowStart = new Date(serverMs - windowMinutes * 60 * 1000).toISOString();
  const recentCountRow = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM submissions WHERE device_fingerprint_hash = ? AND created_at_server >= ?`
    )
    .bind(deviceHash, windowStart)
    .first<{ cnt: number }>();
  const recentCount = recentCountRow?.cnt ?? 0;
  const highVelocity = recentCount >= maxSubmissions;
  if (highVelocity) {
    flags.push("FLAG_HIGH_VELOCITY_DEVICE");
    riskScore += 30;
  }

  // --- Layer 4: same device blueprint used with a different contact number ---
  // Accurate enough for reward abuse: one phone repeatedly claiming under many mobiles.
  // Same mobile re-submitting on the same device is allowed.
  let multiMobileDevice = false;
  if (deviceHash && mobileNumber) {
    const otherMobiles = await db
      .prepare(
        `SELECT COUNT(DISTINCT mobile_number) AS cnt
         FROM submissions
         WHERE device_fingerprint_hash = ?
           AND mobile_number IS NOT NULL
           AND mobile_number != ?
           AND length(trim(mobile_number)) > 0`
      )
      .bind(deviceHash, mobileNumber)
      .first<{ cnt: number }>();
    if ((otherMobiles?.cnt ?? 0) > 0) {
      multiMobileDevice = true;
      flags.push("FLAG_DEVICE_MULTI_MOBILE");
      riskScore += 70;
    }
  }

  riskScore = Math.min(100, riskScore);

  return {
    distanceKm,
    geographicMismatch,
    timeDeltaSeconds,
    highVelocity,
    duplicateImage,
    multiMobileDevice,
    riskScore,
    flags,
  };
}
