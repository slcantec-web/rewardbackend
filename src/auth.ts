/**
 * Minimal signed-token auth (no external JWT library dependency).
 * Token format: base64url(payloadJson).base64url(hmacSignature)
 *
 * For production, swap this for Cloudflare Access (recommended for
 * internal Admin/Finance dashboards) or a proper JWT library — this
 * keeps the Worker dependency-free for the scaffold.
 */

export interface SessionPayload {
  sub: string;       // username
  role: "admin" | "finance_staff" | "finance_lead";
  exp: number;        // unix seconds
}

function b64urlEncode(bytes: Uint8Array): string {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64 = b64urlEncode(payloadBytes);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = b64urlEncode(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(sigB64) as any,
    new TextEncoder().encode(payloadB64)
  );
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as SessionPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function requireRole(payload: SessionPayload | null, roles: SessionPayload["role"][]): boolean {
  return !!payload && roles.includes(payload.role);
}
