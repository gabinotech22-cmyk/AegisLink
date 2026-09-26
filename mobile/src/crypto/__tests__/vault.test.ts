/**
 * F-1b key vault facade (`crypto/sodium/vault.ts`) over the Jest stand-in of
 * the C vault (`modules/aegis-sodium/jest/nodeVault.ts`, same contract). The C
 * vault itself is diffed against TweetNaCl/@noble by
 * `modules/aegis-sodium/test/differential.mjs`.
 */
import tweetnacl from 'tweetnacl';
import { ml_kem768 as nobleMlKem } from '@noble/post-quantum/ml-kem.js';
import { vault, VaultBlobRejectedError, VaultKeyUnavailableError } from '../sodium/vault';

const rand = (n: number): Uint8Array => tweetnacl.randomBytes(n);

describe('key vault', () => {
  afterEach(() => vault.lockAll());

  it('by handle gives the bytes of the raw-key operation, for the identity as the app derives it', async () => {
    await vault.unlock('self');
    const xsk = rand(32);
    const ed = tweetnacl.sign.keyPair.fromSeed(xsk);
    const xpk = tweetnacl.scalarMult.base(xsk);
    const { key: x, blob: xBlob } = vault.import('self', 'x25519', xsk.slice());
    expect(x.publicKey).toEqual(xpk);
    const { key: e } = vault.deriveEd25519(x);
    expect(e.publicKey).toEqual(ed.publicKey);

    const peer = tweetnacl.box.keyPair();
    const msg = rand(200);
    const nonce = rand(24);
    expect(vault.scalarMult(x, peer.publicKey)).toEqual(tweetnacl.scalarMult(xsk, peer.publicKey));
    expect(vault.sign(e, msg)).toEqual(tweetnacl.sign.detached(msg, ed.secretKey));
    expect(vault.box(x, msg, nonce, peer.publicKey)).toEqual(tweetnacl.box(msg, nonce, peer.publicKey, xsk));
    expect(vault.boxOpen(x, tweetnacl.box(msg, nonce, xpk, peer.secretKey), nonce, peer.publicKey)).toEqual(msg);
    expect(vault.boxOpen(x, rand(msg.length + 16), nonce, peer.publicKey)).toBeNull();

    // The stored blob loads back into a working handle.
    const again = vault.load('self', xBlob);
    expect(again.type).toBe('x25519');
    expect(vault.scalarMult(again, peer.publicKey)).toEqual(tweetnacl.scalarMult(xsk, peer.publicKey));
  });

  it('import zeroes the caller\'s raw copy', async () => {
    await vault.unlock('self');
    const raw = rand(32);
    vault.import('self', 'x25519', raw);
    expect(raw.every((b) => b === 0)).toBe(true);
  });

  it('decapsulates ML-KEM-768 with keys the app made on @noble', async () => {
    await vault.unlock('self');
    const k = nobleMlKem.keygen();
    const e = nobleMlKem.encapsulate(k.publicKey);
    const { key } = vault.import('self', 'mlkem768', k.secretKey.slice());
    expect(key.publicKey).toEqual(k.publicKey);
    expect(vault.mlkemDecapsulate(key, e.cipherText)).toEqual(e.sharedSecret);
  });

  it('keeps profiles apart and rejects tampered blobs', async () => {
    await vault.unlock('self');
    await vault.unlock('work');
    const { blob } = vault.generate('self', 'x25519');
    expect(() => vault.load('work', blob)).toThrow(VaultBlobRejectedError);
    const tampered = blob.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(() => vault.load('self', tampered)).toThrow(VaultBlobRejectedError);
    expect(() => vault.load('self', new Uint8Array(3))).toThrow(VaultBlobRejectedError);
  });

  it('released handles and locked profiles do not operate', async () => {
    await vault.unlock('self');
    const { key, blob } = vault.generate('self', 'ed25519');
    vault.release(key);
    expect(() => vault.sign(key, rand(8))).toThrow(VaultKeyUnavailableError);
    const k2 = vault.load('self', blob);
    vault.lock('self');
    expect(() => vault.sign(k2, rand(8))).toThrow(VaultKeyUnavailableError);
    expect(() => vault.load('self', blob)).toThrow(VaultKeyUnavailableError);
    // Unlocking again (next launch) reads the same KEK: the blob loads.
    await vault.unlock('self');
    expect(vault.load('self', blob).type).toBe('ed25519');
    expect(vault.liveKeys()).toBe(1);
  });

  it('destroyProfile is a cryptographic erase: old blobs never load again', async () => {
    await vault.unlock('panic');
    const { blob } = vault.generate('panic', 'x25519');
    await vault.destroyProfile('panic');
    await vault.unlock('panic'); // a fresh KEK
    expect(() => vault.load('panic', blob)).toThrow(VaultBlobRejectedError);
  });

  it('refuses wrong key types, sizes and slot names', async () => {
    await vault.unlock('self');
    const { key: x } = vault.generate('self', 'x25519');
    expect(() => vault.sign(x, rand(8))).toThrow(/needs a ed25519 key/);
    expect(() => vault.import('self', 'x25519', rand(31))).toThrow(/32 bytes/);
    expect(() => vault.generate('bad slot!', 'x25519')).toThrow(/bad slot/);
    const badEd = tweetnacl.sign.keyPair().secretKey;
    badEd[40] ^= 1; // public half no longer matches the seed
    expect(() => vault.import('self', 'ed25519', badEd)).toThrow(/import failed/);
    const { key: s } = vault.generate('self', 'secret32');
    expect(s.publicKey.length).toBe(0);
  });
});
