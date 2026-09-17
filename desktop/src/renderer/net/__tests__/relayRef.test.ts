/**
 * relayRef — known-answer vectors (federation F1, docs/FEDERATION-DESIGN.md D1).
 *
 * mobile/src/net/__tests__/relayRef.test.ts asserts the SAME vectors against
 * its byte-identical copy of the module. If one platform's address
 * parser drifts (case folding, scheme stripping, onion length, `@` handling),
 * one of the two suites breaks — a link generated on one platform must parse
 * identically on the other or two users silently end up on different relays.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeOnion,
  relayRefFromOnion,
  sameRelay,
  shortOnion,
  parseContactAddress,
  formatContactAddress,
  ONION_V3_RE,
} from '../relayRef';

const HOST = 'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd';
const ONION = `${HOST}.onion`;
const ID = 'ABC-DEFG-HJKM'; // Crockford base32: no I, L, O, U

// ── KAT vectors: [input, expected canonical onion | null] ─────────────────────
export const NORMALIZE_VECTORS: Array<[unknown, string | null]> = [
  [ONION, ONION],
  [ONION.toUpperCase(), ONION],
  [`http://${ONION}`, ONION],
  [`HTTPS://${ONION}/`, ONION],
  [`ws://${ONION}:3001/socket.io/`, ONION],
  [`  ${ONION}  `, ONION],
  [`${HOST}`, null],                       // missing .onion
  [`${HOST.slice(0, 55)}.onion`, null],   // 55 chars: not v3
  [`${HOST}x.onion`, null],               // 57 chars
  ['facebookcorewwwi.onion', null],        // v2 (16 chars) — retired
  [`${HOST.replace('p', '1')}.onion`, null], // '1' is not base32
  ['aegislink.duckdns.org', null],
  ['', null],
  [null, null],
  [42, null],
  ['x'.repeat(600), null],
];

export const ADDRESS_VECTORS: Array<[unknown, { aegisId: string; relay: { onion: string } | null } | null]> = [
  [ID, { aegisId: ID, relay: null }],
  ['abc-defg-hjkm', { aegisId: ID, relay: null }],
  [`${ID}@${ONION}`, { aegisId: ID, relay: { onion: ONION } }],
  [`abc-defg-hjkm@HTTP://${ONION.toUpperCase()}/`, { aegisId: ID, relay: { onion: ONION } }],
  [`${ID}@evil.example.com`, null],       // valid id, invalid relay → refuse, never "official"
  [`${ID}@`, null],
  [`@${ONION}`, null],
  [`${ID}@@${ONION}`, null],
  ['ABC-DEFG-HJKL', null],                // 'L' is not Crockford base32
  ['', null],
  [undefined, null],
];

describe('normalizeOnion', () => {
  it.each(NORMALIZE_VECTORS)('%p → %p', (input, expected) => {
    expect(normalizeOnion(input)).toBe(expected);
  });

  it('ONION_V3_RE is exactly 56 base32 chars + .onion', () => {
    expect(ONION_V3_RE.test(ONION)).toBe(true);
    expect(ONION_V3_RE.test(ONION.toUpperCase())).toBe(false); // canonical form is lowercase
  });
});

describe('parseContactAddress / formatContactAddress', () => {
  it.each(ADDRESS_VECTORS)('%p → %p', (input, expected) => {
    expect(parseContactAddress(input)).toEqual(expected);
  });

  it('format is the inverse of parse', () => {
    expect(formatContactAddress(ID, null)).toBe(ID);
    expect(formatContactAddress(ID, { onion: ONION })).toBe(`${ID}@${ONION}`);
    expect(parseContactAddress(formatContactAddress(ID, { onion: ONION }))).toEqual({ aegisId: ID, relay: { onion: ONION } });
  });
});

describe('helpers', () => {
  it('relayRefFromOnion / sameRelay', () => {
    expect(relayRefFromOnion(`https://${ONION}`)).toEqual({ onion: ONION });
    expect(relayRefFromOnion('nope')).toBeNull();
    expect(sameRelay(null, undefined)).toBe(true);
    expect(sameRelay({ onion: ONION }, { onion: ONION })).toBe(true);
    expect(sameRelay({ onion: ONION }, null)).toBe(false);
  });

  it('shortOnion keeps both ends of the host', () => {
    expect(shortOnion(ONION)).toBe('pg6mmj…scryd.onion'.replace('scryd', HOST.slice(-6)));
    expect(shortOnion(ONION).length).toBeLessThan(ONION.length);
  });
});
