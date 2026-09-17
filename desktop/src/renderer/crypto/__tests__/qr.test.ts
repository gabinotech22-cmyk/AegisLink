/**
 * qr — desktop parity with mobile/src/crypto/__tests__/qr.links.test.ts
 * (federation F1). The desktop copy used to lag mobile (no universal links,
 * no ID↔key binding, a throwing decodeURIComponent); these cases pin parity.
 */
import { describe, it, expect } from 'vitest';
import { decodeBase64 } from 'tweetnacl-util';
import { encodeIdentityQR, encodeIdentityLink, parseIdentityQR, universalToScheme, UNIVERSAL_LINK_HOST } from '../qr';
import { deriveAegisId } from '../identity';

const KEY = 'A'.repeat(43) + '=';
const ID = deriveAegisId(decodeBase64(KEY));
const ONION = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwxyz'.slice(0, 56) + '.onion';
const RELAY = { onion: ONION };
const ROOT = 'A'.repeat(43) + '=';

describe('identity links (desktop parity)', () => {
  it('v1 QR and https forms round-trip with relay: null', () => {
    expect(parseIdentityQR(encodeIdentityQR(ID, KEY))).toEqual({ aegisId: ID, publicKeyB64: KEY, relay: null, mailboxRootB64: null });
    const link = encodeIdentityLink(ID, KEY);
    expect(link.startsWith(`${UNIVERSAL_LINK_HOST}/a#v1/`)).toBe(true);
    expect(parseIdentityQR(link)).toEqual({ aegisId: ID, publicKeyB64: KEY, relay: null, mailboxRootB64: null });
  });

  it('a null relay still emits v1 — nothing changes for today’s users', () => {
    expect(encodeIdentityQR(ID, KEY, null)).toBe(encodeIdentityQR(ID, KEY));
  });

  it('v2 QR and https forms round-trip with the relay and the mailbox root', () => {
    expect(parseIdentityQR(encodeIdentityQR(ID, KEY, RELAY, ROOT))).toEqual({ aegisId: ID, publicKeyB64: KEY, relay: RELAY, mailboxRootB64: ROOT });
    expect(parseIdentityQR(encodeIdentityLink(ID, KEY, RELAY, ROOT))).toEqual({ aegisId: ID, publicKeyB64: KEY, relay: RELAY, mailboxRootB64: ROOT });
    expect(() => encodeIdentityQR(ID, KEY, RELAY)).toThrow();
  });

  it('a v2 payload with an invalid relay or root is rejected, never downgraded', () => {
    expect(parseIdentityQR(`aegislink://v2/${ID}/${encodeURIComponent(KEY)}/evil.example.com/${encodeURIComponent(ROOT)}`)).toBeNull();
    expect(parseIdentityQR(`aegislink://v2/${ID}/${encodeURIComponent(KEY)}/${ONION}`)).toBeNull();
    expect(parseIdentityQR(`aegislink://v2/${ID}/${encodeURIComponent(KEY)}/${ONION}/short`)).toBeNull();
  });

  it('binds the ID to the key and survives malformed escapes', () => {
    expect(parseIdentityQR(`aegislink://v1/${ID}/${'B'.repeat(43)}%3D`)).toBeNull(); // wrong key for ID
    expect(parseIdentityQR(`aegislink://v1/${ID}/%E0%A4%A`)).toBeNull();            // malformed escape: no throw
    expect(parseIdentityQR(`aegislink://v1/NOT-AN-ID/${KEY}`)).toBeNull();
  });

  it('universalToScheme never produces a panic URL', () => {
    expect(universalToScheme(`${UNIVERSAL_LINK_HOST}/panic#x`)).toBeNull();
    expect(universalToScheme(`${UNIVERSAL_LINK_HOST}/a#v1/x/y`)).toBe('aegislink://v1/x/y');
  });
});
