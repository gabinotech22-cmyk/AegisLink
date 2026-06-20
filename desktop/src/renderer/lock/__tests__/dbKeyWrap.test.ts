import { describe, test, expect } from 'vitest';
/**
 * dbKeyWrap.test.ts — desktop DB-key KEK derivation (C-2 Fase 2, pure core).
 *
 * The storage-bound wrapper (getDbKEK) touches window.aegis and is out of
 * node-env scope, so we test the PURE primitive `deriveKEKBytes` with an injected
 * salt — the security-critical derivation. The wrap/unwrap of the DB key under
 * this KEK is covered main-side in database.pinwrap.test.ts. Regla #11.
 */

import nacl from 'tweetnacl';
import { deriveKEKBytes } from '../dbKeyWrap';

const salt = (fill: number) => new Uint8Array(16).fill(fill);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

describe('desktop DB-key KEK (Argon2id)', () => {
  test('derives a 32-byte KEK', async () => {
    const kek = await deriveKEKBytes('1234', salt(7));
    expect(kek).toBeInstanceOf(Uint8Array);
    expect(kek.length).toBe(32);
  });

  test('same (pin, salt) is deterministic; different pin diverges', async () => {
    const a = await deriveKEKBytes('1234', salt(7));
    const b = await deriveKEKBytes('1234', salt(7));
    const c = await deriveKEKBytes('9999', salt(7));
    expect(b64(a)).toBe(b64(b));
    expect(b64(a)).not.toBe(b64(c));
  });

  test('same PIN under different salts yields different KEKs', async () => {
    const a = await deriveKEKBytes('1234', salt(1));
    const b = await deriveKEKBytes('1234', salt(2));
    expect(b64(a)).not.toBe(b64(b));
  });

  test('the derived KEK actually opens a secretbox it sealed (and a wrong PIN does not)', async () => {
    const dbKey = nacl.randomBytes(32);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const good = await deriveKEKBytes('1234', salt(5));
    const ct = nacl.secretbox(dbKey, nonce, good);

    const openedGood = nacl.secretbox.open(ct, nonce, good);
    expect(openedGood && b64(openedGood)).toBe(b64(dbKey));

    const wrong = await deriveKEKBytes('0000', salt(5));
    expect(nacl.secretbox.open(ct, nonce, wrong)).toBeNull();
  });
});
