export interface Env {
  DB: D1Database;
  BILL_IMAGES: R2Bucket;
  GEOFENCE_RADIUS_KM: string;
  VELOCITY_MAX_SUBMISSIONS: string;
  VELOCITY_WINDOW_MINUTES: string;
  WALLET_PAYOUT_THRESHOLD_LKR: string;
  FINANCE_JWT_SECRET: string;
  ADMIN_JWT_SECRET: string;
}

export interface DeviceBlueprint {
  userAgent?: string;
  platform?: string;
  language?: string;
  screen?: { width: number; height: number; colorDepth: number; pixelRatio: number };
  hardwareConcurrency?: number;
  deviceMemory?: number;
  webglRenderer?: string;
  canvasFingerprint?: string;
  connectionType?: string;
}

export interface SubmissionItemInput {
  productId: string;
  claimedQty: number;
}

export interface CreateSubmissionPayload {
  dealerId: string;
  mobileNumber: string;
  items: SubmissionItemInput[];
  billImageBase64: string;      // client-compressed image, base64
  gps: { lat: number; lng: number; accuracy: number };
  createdAtClient: string;      // ISO timestamp from browser
  device: DeviceBlueprint;
  clientIp?: string;
}

export interface FraudEvaluation {
  distanceKm: number | null;
  geographicMismatch: boolean;
  timeDeltaSeconds: number;
  highVelocity: boolean;
  duplicateImage: boolean;
  riskScore: number;
  flags: string[];
}
