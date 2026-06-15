/**
 * Universal (https) invite links — encode/parse contract.
 *
 * The https forms must round-trip through the same parsers as the QR/scheme
 * forms, and universalToScheme must NEVER produce a panic URL (there is no
 * universal form for the remote wipe, by design).
 */

import { decodeBase64 } from 'tweetnacl-util';
import {
  encodeIdentityQR,
  encodeIdentityLink,
  parseIdentityQR,
  encodeGroupInviteLink,
  encodeGroupInviteLinkUniversal,
  parseGroupInviteLink,
  universalToScheme,
  UNIVERSAL_LINK_HOST,
} from '../qr';
import { deriveAegisId } from '../aegisId';

// parseIdentityQR now cryptographically binds the ID to its key, so the fixture
// MUST be a real pair: the ID is derived from the key, not an arbitrary literal.
const KEY = 'A'.repeat(43) + '='; // 44-char base64 (deterministic 32-byte key)
const ID = deriveAegisId(decodeBase64(KEY));

describe('universal contact links', () => {
  it('encodeIdentityLink → parseIdentityQR round-trips', () => {
    const link = encodeIdentityLink(ID, KEY);
    expect(link.startsWith(`${UNIVERSAL_LINK_HOST}/a#v1/`)).toBe(true);
    expect(parseIdentityQR(link)).toEqual({ aegisId: ID, publicKeyB64: KEY });
  });

  it('parseIdentityQR still accepts the aegislink:// QR form', () => {
    expect(parseIdentityQR(encodeIdentityQR(ID, KEY))).toEqual({ aegisId: ID, publicKeyB64: KEY });
  });

  it('rejects malformed ids and keys in the universal form', () => {
    expect(parseIdentityQR(`${UNIVERSAL_LINK_HOST}/a#v1/NOT-AN-ID/${KEY}`)).toBeNull();
    expect(parseIdentityQR(`${UNIVERSAL_LINK_HOST}/a#v1/${ID}/shortkey`)).toBeNull();
  });
});

describe('universal group invite links', () => {
  it('encodeGroupInviteLinkUniversal → parseGroupInviteLink round-trips', () => {
    const link = encodeGroupInviteLinkUniversal('g-123', 'Mi Grupo Ñ', 'ADM-1111-2222');
    expect(link.startsWith(`${UNIVERSAL_LINK_HOST}/g#v1/`)).toBe(true);
    expect(parseGroupInviteLink(link)).toEqual({
      groupId: 'g-123', groupName: 'Mi Grupo Ñ', adminId: 'ADM-1111-2222',
    });
  });

  it('parseGroupInviteLink still accepts the aegislink:// scheme form', () => {
    const link = encodeGroupInviteLink('g-123', 'X', 'ADM-1');
    expect(parseGroupInviteLink(link)).toEqual({ groupId: 'g-123', groupName: 'X', adminId: 'ADM-1' });
  });
});

describe('universalToScheme', () => {
  it('maps /g# and /a# to their scheme equivalents', () => {
    expect(universalToScheme(`${UNIVERSAL_LINK_HOST}/g#v1/a/b/c`)).toBe('aegislink://group/v1/a/b/c');
    expect(universalToScheme(`${UNIVERSAL_LINK_HOST}/a#v1/${ID}/${KEY}`)).toBe(`aegislink://v1/${ID}/${KEY}`);
  });

  it('returns null for foreign URLs and NEVER maps to aegislink://panic', () => {
    expect(universalToScheme('https://evil.example/g#v1/a/b/c')).toBeNull();
    expect(universalToScheme(`${UNIVERSAL_LINK_HOST}/p#token=x`)).toBeNull();
    expect(universalToScheme(`${UNIVERSAL_LINK_HOST}/panic#token=x`)).toBeNull();
    // A crafted fragment cannot escape the group/ prefix into another scheme path.
    const mapped = universalToScheme(`${UNIVERSAL_LINK_HOST}/g#v1/x/y/z`);
    expect(mapped?.startsWith('aegislink://group/')).toBe(true);
  });
});
