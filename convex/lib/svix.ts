// Verify a Clerk (Svix) webhook signature without the `svix` npm package, using
// the Web Crypto API available in Convex's default runtime. Svix signs
// `${svix-id}.${svix-timestamp}.${body}` with HMAC-SHA256 using the base64 part
// of the `whsec_...` signing secret, and sends the result base64-encoded in the
// `svix-signature` header as a space-separated list of `v1,<sig>` entries.

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Web Crypto wants a plain ArrayBuffer-backed source; copy the view's bytes into
// a fresh ArrayBuffer so the type is exactly ArrayBuffer (TS 6 BufferSource).
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

// Constant-time string comparison to avoid signature timing leaks.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

const TOLERANCE_SECONDS = 5 * 60;

/**
 * Returns true iff the payload matches one of the provided v1 signatures and the
 * timestamp is within a 5-minute window (replay protection).
 */
export async function verifySvixSignature(args: {
  secret: string; // whsec_...
  headers: SvixHeaders;
  payload: string; // raw request body
}): Promise<boolean> {
  const { secret, headers, payload } = args;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return false;

  const secretB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = base64ToBytes(secretB64);
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const toSign = `${headers.id}.${headers.timestamp}.${payload}`;
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(new TextEncoder().encode(toSign)),
  );
  const expected = bytesToBase64(new Uint8Array(sigBuf));

  // Header may carry multiple space-separated `v1,<sig>` entries.
  return headers.signature.split(" ").some((entry) => {
    const comma = entry.indexOf(",");
    const sig = comma === -1 ? entry : entry.slice(comma + 1);
    return timingSafeEqual(sig, expected);
  });
}
