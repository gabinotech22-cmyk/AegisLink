/**
 * QR payload format for sharing an identity:
 *   aegislink://v1/<AEGIS_ID>/<PUBLIC_KEY_BASE64>
 *
 * `aegislink://` doubles as a deep-link scheme so the app can be opened
 * directly from a scanned URL on iOS/Android.
 */

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const SCHEME = 'aegislink://v1/';

export function encodeIdentityQR(aegisId: string, publicKeyB64: string): string {
  return `${SCHEME}${aegisId}/${encodeURIComponent(publicKeyB64)}`;
}

export interface ParsedIdentityQR {
  aegisId: string;
  publicKeyB64: string;
}

export function parseIdentityQR(raw: string): ParsedIdentityQR | null {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith(SCHEME)) return null;
  const rest = raw.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const aegisId = rest.slice(0, slash).trim().toUpperCase();
  const publicKeyB64 = decodeURIComponent(rest.slice(slash + 1)).trim();
  if (!AEGIS_ID_RE.test(aegisId)) return null;
  // base64-encoded 32-byte Curve25519 key is exactly 44 chars.
  if (publicKeyB64.length !== 44) return null;
  return { aegisId, publicKeyB64 };
}
