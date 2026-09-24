/**
 * AegisLink — Sealed Public Channels invite links (Phase 2d, gap B; docs §11.2)
 *
 *   aegislink://channel/<b32 channelId>/<b32 channelEd25519Pub>
 *     [?k=<b32 capability>]   // open/readonly/moderated — capability in the link
 *     [&p=1]                  // approval-gated — NO capability (admin sends it later)
 *
 * The link is out-of-band and PUBLIC: for capability-bearing channels anyone with
 * the link can read (posts are still always CEK-encrypted; the relay never sees
 * content). The channelId↔pubkey binding is NOT verified here — the invite has no
 * salt — it is verified at join against the signed manifest (extractChannelSignerPub
 * re-derives channelId from the manifest's pub+salt). This module only encodes the
 * three values out, and parses them back.
 *
 * Encoding is reversible Crockford Base32 (URL-safe, no padding) — distinct from
 * crypto/aegisId's lossy fixed-width encoder, which cannot round-trip.
 */

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SCHEME = 'aegislink://channel/';
const ID_BYTES = 16;
const PUB_BYTES = 32;
const CAP_BYTES = 32;

function b32encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** Decode Crockford Base32 to exactly `outLen` bytes, or null on any invalid input. */
function b32decode(str: string, outLen: number): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of str.toUpperCase()) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length !== outLen) return null;
  return Uint8Array.from(out);
}

export interface ChannelInvite {
  /** Canonical base64 channelId (16-byte id). */
  channelId: string;
  /** Channel signing public key (32 bytes). */
  channelEd25519Pub: Uint8Array;
  /** Access capability (32 bytes), or null for an approval-gated invite. */
  capability: Uint8Array | null;
  /** True when the link is approval-gated (p=1, no capability). */
  approvalGated: boolean;
}

/** Build an invite link from channel values. Throws on wrong-length inputs. */
export function buildInviteLink(invite: ChannelInvite): string {
  const idBytes = decodeBase64(invite.channelId);
  if (idBytes.length !== ID_BYTES) throw new Error('buildInviteLink: channelId must be 16 bytes');
  if (invite.channelEd25519Pub.length !== PUB_BYTES) throw new Error('buildInviteLink: pubkey must be 32 bytes');
  if (invite.capability && invite.capability.length !== CAP_BYTES) {
    throw new Error('buildInviteLink: capability must be 32 bytes');
  }

  let url = `${SCHEME}${b32encode(idBytes)}/${b32encode(invite.channelEd25519Pub)}`;
  const params: string[] = [];
  if (invite.capability) params.push(`k=${b32encode(invite.capability)}`);
  if (invite.approvalGated) params.push('p=1');
  if (params.length > 0) url += `?${params.join('&')}`;
  return url;
}

/** Parse an invite link. Returns null on any malformed/invalid input (never throws). */
export function parseInviteLink(url: string): ChannelInvite | null {
  if (typeof url !== 'string' || !url.startsWith(SCHEME)) return null;

  const rest = url.slice(SCHEME.length);
  const [path, query = ''] = rest.split('?', 2);
  const segments = path.split('/');
  if (segments.length !== 2) return null;
  const [idB32, pubB32] = segments;
  if (!idB32 || !pubB32) return null;

  const idBytes = b32decode(idB32, ID_BYTES);
  const pub = b32decode(pubB32, PUB_BYTES);
  if (!idBytes || !pub) return null;

  const qs = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) { qs.set(pair, ''); continue; }
    qs.set(pair.slice(0, eq), pair.slice(eq + 1));
  }

  let capability: Uint8Array | null = null;
  const k = qs.get('k');
  if (k !== undefined) {
    capability = b32decode(k, CAP_BYTES);
    if (!capability) return null; // malformed capability → reject the whole link
  }
  const approvalGated = qs.get('p') === '1';

  return { channelId: encodeBase64(idBytes), channelEd25519Pub: pub, capability, approvalGated };
}
