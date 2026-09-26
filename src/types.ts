export interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; success?: boolean; meta?: any }>;
  run(): Promise<{ success?: boolean; meta: { changes: number; last_row_id?: number } }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<any[]>;
  exec?(query: string): Promise<any>;
}

export interface R2Bucket {
  put(key: string, value: any, options?: any): Promise<any>;
  get(key: string): Promise<any>;
  delete(key: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  BILL_IMAGES: R2Bucket;
  GEOFENCE_RADIUS_KM: string;
  VELOCITY_MAX_SUBMISSIONS: string;
  VELOCITY_WINDOW_MINUTES: string;
  /** IP-based rate limiting — soft flag only (IPs are often shared behind NAT/wifi) */
  IP_VELOCITY_MAX_SUBMISSIONS: string;
  IP_VELOCITY_WINDOW_MINUTES: string;
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
  /** Stable per-browser install id (localStorage) — strengthens device binding */
  installId?: string;
  maxTouchPoints?: number;
  isMobile?: boolean;
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
  /** Ignored if present — client-supplied IPs are spoofable. The server derives the real IP from request headers. */
  clientIp?: string;
}

export interface FraudEvaluation {
  distanceKm: number | null;
  geographicMismatch: boolean;
  timeDeltaSeconds: number;
  highVelocity: boolean;
  duplicateImage: boolean;
  /** True when a perceptually similar (but not byte-identical) bill image was recently submitted */
  nearDuplicateImage: boolean;
  /** True when this device fingerprint already submitted under a different mobile number */
  multiMobileDevice: boolean;
  /** True when this IP address has submitted more than the allowed number of claims in the window */
  highVelocityIp: boolean;
  riskScore: number;
  flags: string[];
}
