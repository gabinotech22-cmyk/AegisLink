/**
 * QR payload format for sharing an identity:
 *   aegislink://v1/<AEGIS_ID>/<PUBLIC_KEY_BASE64>
 *
 * `aegislink://` doubles as a deep-link scheme so the app can be opened
 * directly from a scanned URL on iOS/Android.
 */

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const SCHEME = 'aegislink://v1/';
const GROUP_SCHEME = 'aegislink://group/v1/';

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

// ─── Group invite links ───────────────────────────────────────────────────────
// Format: aegislink://group/v1/<groupId>/<groupName>/<adminId>
// Each segment is URI-encoded. groupId and adminId are opaque identifiers;
// groupName is display-only and not cryptographically bound to the group.

export interface ParsedGroupInvite {
  groupId: string;
  groupName: string;
  adminId: string;
}

export function encodeGroupInviteLink(
  groupId: string,
  groupName: string,
  adminId: string,
): string {
  return (
    GROUP_SCHEME +
    encodeURIComponent(groupId) +
    '/' +
    encodeURIComponent(groupName) +
    '/' +
    encodeURIComponent(adminId)
  );
}

export function parseGroupInviteLink(url: string): ParsedGroupInvite | null {
  if (typeof url !== 'string' || !url.startsWith(GROUP_SCHEME)) return null;
  const rest = url.slice(GROUP_SCHEME.length);
  const parts = rest.split('/');
  if (parts.length < 3) return null;
  const groupId = decodeURIComponent(parts[0]).trim();
  const groupName = decodeURIComponent(parts[1]).trim();
  const adminId = decodeURIComponent(parts[2]).trim();
  if (!groupId || !groupName || !adminId) return null;
  return { groupId, groupName, adminId };
}
