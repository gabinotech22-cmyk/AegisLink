import { describe, test, expect } from 'vitest';
/**
 * pin.test.ts — desktop app-lock PIN hashing (C-2 Fase 1, pure core).
 *
 * Mirrors mobile/src/lock/__tests__/pin.test.ts. The storage-bound wrappers
 * (setPIN/verifyPIN) touch window.aegis and are out of node-env scope, so we
 * test the PURE primitives (hashPin/verifyPinHash/constantTimeEq) with an
 * injected salt — the security-critical part. Regla #11.
 */

import { hashPin, verifyPinHash, constantTimeEq } from '../pin';

const enc = new TextEncoder();
const salt = (fill: number) => new Uint8Array(16).fill(fill);

describe('desktop PIN hashing (a3 / Argon2id)', () => {
  test('hashPin produces an a3-prefixed base64 hash', async () => {
    const h = await hashPin('1234', salt(7));
    expect(h.startsWith('a3:')).toBe(true);
    // base64 of a 32-byte digest is 44 chars → total length is stable.
    expect(h.length).toBeGreaterThan(40);
  });

  test('same (pin, salt) is deterministic; different pin diverges', async () => {
    const a = await hashPin('1234', salt(7));
    const b = await hashPin('1234', salt(7));
    const c = await hashPin('9999', salt(7));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('the same PIN under different salts yields different hashes', async () => {
    const a = await hashPin('1234', salt(1));
    const b = await hashPin('1234', salt(2));
    expect(a).not.toBe(b);
  });

  test('verifyPinHash accepts the correct PIN and rejects the wrong one', async () => {
    const stored = await hashPin('1234', salt(7));
    expect(await verifyPinHash('1234', salt(7), stored)).toBe(true);
    expect(await verifyPinHash('0000', salt(7), stored)).toBe(false);
  });

  test('verifyPinHash rejects a non-a3 / corrupt stored value without throwing', async () => {
    await expect(verifyPinHash('1234', salt(7), 'plain:1234')).resolves.toBe(false);
    await expect(verifyPinHash('1234', salt(7), '')).resolves.toBe(false);
  });

  test('constantTimeEq matches === semantics for equal/unequal/diff-length', () => {
    expect(constantTimeEq('abcd', 'abcd')).toBe(true);
    expect(constantTimeEq('abcd', 'abce')).toBe(false);
    expect(constantTimeEq('abc', 'abcd')).toBe(false);
  });
});
