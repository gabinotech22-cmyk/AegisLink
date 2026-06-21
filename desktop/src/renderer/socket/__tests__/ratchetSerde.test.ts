/**
 * ratchetSerde.test.ts — ratchet-state byte revival (desktop).
 *
 * reviveBytes reconstructs persisted ratchet key material (RK/CK/DH/MKSKIPPED)
 * from whatever JSON shape it round-tripped through. A wrong reconstruction is
 * silent: the bytes differ, the ratchet desyncs, and every later message fails
 * to decrypt with no error at this layer. These pin each accepted shape, the
 * numeric (not lexicographic) key ordering, and the strict rejection of
 * non-byte shapes. Twin of mobile/src/socket/__tests__/ratchetSerde.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  reviveBytes,
  reviveMkSkipped,
  isByteIndexedObject,
} from '../ratchetSerde';

describe('reviveBytes', () => {
  it('returns null for null/undefined', () => {
    expect(reviveBytes(null)).toBeNull();
    expect(reviveBytes(undefined)).toBeNull();
  });

  it('passes a Uint8Array through unchanged', () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(reviveBytes(u)).toBe(u);
  });

  it('revives a Buffer-shaped JSON object', () => {
    const out = reviveBytes({ type: 'Buffer', data: [10, 20, 30] });
    expect(out).toEqual(new Uint8Array([10, 20, 30]));
  });

  it('revives a plain number array', () => {
    expect(reviveBytes([4, 5, 6])).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('revives a number-keyed object and orders keys NUMERICALLY, not lexically', () => {
    // Keys deliberately out of order and crossing the 9→10 boundary where a
    // lexicographic sort ("10" < "2") would scramble the bytes.
    const obj: Record<string, number> = {
      '10': 110,
      '2': 2,
      '0': 0,
      '1': 1,
      '11': 111,
      '3': 3,
      '4': 4,
      '5': 5,
      '6': 6,
      '7': 7,
      '8': 8,
      '9': 9,
    };
    expect(reviveBytes(obj)).toEqual(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 110, 111]),
    );
  });

  it('rejects non-byte shapes (null result, never fabricated bytes)', () => {
    expect(reviveBytes('deadbeef')).toBeNull();
    expect(reviveBytes(42)).toBeNull();
    expect(reviveBytes({})).toBeNull(); // empty object is not a byte map
    expect(reviveBytes({ foo: 1 })).toBeNull(); // non-numeric key
    expect(reviveBytes({ '0': 256 })).toBeNull(); // out of byte range
    expect(reviveBytes({ '0': -1 })).toBeNull();
    expect(reviveBytes([1, 2, 'x'])).toBeNull(); // mixed array
    expect(reviveBytes({ type: 'Buffer', data: ['x'] })).toBeNull();
  });
});

describe('isByteIndexedObject', () => {
  it('rejects arrays and accepts only pure byte maps', () => {
    expect(isByteIndexedObject([1, 2, 3])).toBe(false);
    expect(isByteIndexedObject({ '0': 1, '1': 255 })).toBe(true);
    expect(isByteIndexedObject({})).toBe(false);
  });
});

describe('reviveMkSkipped', () => {
  it('returns an empty map for a non-array', () => {
    expect(reviveMkSkipped(null).size).toBe(0);
    expect(reviveMkSkipped({}).size).toBe(0);
  });

  it('revives valid [string, bytes] entries and skips malformed ones', () => {
    const raw = [
      ['k1', [1, 2, 3]], // valid
      ['k2', { type: 'Buffer', data: [9] }], // valid
      ['bad-no-value'], // wrong arity → skip
      [123, [1]], // non-string key → skip
      ['k3', 'not-bytes'], // un-revivable value → skip
    ];
    const map = reviveMkSkipped(raw);
    expect(map.size).toBe(2);
    expect(map.get('k1')).toEqual(new Uint8Array([1, 2, 3]));
    expect(map.get('k2')).toEqual(new Uint8Array([9]));
    expect(map.has('k3')).toBe(false);
  });
});
