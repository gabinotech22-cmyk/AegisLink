/**
 * F-1 seam guard: production code gets NaCl and hash/MAC/KDF primitives ONLY
 * from `src/crypto/sodium`, which runs them on native libsodium
 * (`modules/aegis-sodium`, F-1 B2). TweetNaCl is gone from production code
 * entirely (a devDependency, kept as the test oracle), and only the facade may
 * touch the native module.
 *
 * Allowed exceptions:
 *   - `tweetnacl-util` (base64/utf8 codecs, no key material).
 *   - `@noble/hashes/sha2|sha256` in `crypto/backup.ts`: PBKDF2 takes the hash
 *     object (legacy v1/v2 backups only).
 *   - @noble pbkdf2 / utils (legacy backups, codecs).
 * Argon2id and ML-KEM-768 are native (the facade's `argon2id` and `ml_kem768`):
 * no @noble argon2 or @noble/post-quantum in production.
 * Twin guards: `desktop/src/renderer/crypto/__tests__/crypto-imports.test.ts`,
 * `server/src/__tests__/crypto-imports.test.ts`.
 */
import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(MOBILE_ROOT, 'src');
const FACADE_DIR = path.join(SRC_ROOT, 'crypto', 'sodium') + path.sep;

const TWEETNACL = /(?:from\s+'tweetnacl'|require\('tweetnacl'\))/;
const NATIVE_MODULE = /(?:from\s+|require\()'[^']*modules\/aegis-sodium[^']*'/;
const NOBLE_MAC_KDF = /from\s+'@noble\/hashes\/(?:hmac|hkdf)(?:\.js)?'/;
const NOBLE_HASH = /from\s+'@noble\/hashes\/(?:sha2|sha256|sha512)(?:\.js)?'/;
const NOBLE_HASH_ALLOWED = [path.join('crypto', 'backup.ts')];
const NOBLE_ARGON2 = /(?:from\s+|require\()'@noble\/hashes\/argon2(?:\.js)?'/;
const NOBLE_PQ = /(?:from\s+|require\(|import\()'@noble\/post-quantum[^']*'/;

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') productionFiles(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe('crypto primitives come only from src/crypto/sodium', () => {
  const files = [...productionFiles(SRC_ROOT), path.join(MOBILE_ROOT, 'cryptoSetup.ts')];

  it('scans a non-trivial tree (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no tweetnacl import anywhere in production code, the facade included', () => {
    const offenders = files.filter((p) => TWEETNACL.test(fs.readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('only the facade reaches the native libsodium module', () => {
    const offenders = files.filter(
      (p) => !p.startsWith(FACADE_DIR) && NATIVE_MODULE.test(fs.readFileSync(p, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no direct @noble HMAC/HKDF import outside the facade', () => {
    const offenders = files.filter(
      (p) => !p.startsWith(FACADE_DIR) && NOBLE_MAC_KDF.test(fs.readFileSync(p, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no direct @noble SHA-2 import outside the facade (PBKDF2 in backup.ts excepted)', () => {
    const offenders = files.filter(
      (p) =>
        !p.startsWith(FACADE_DIR) &&
        !NOBLE_HASH_ALLOWED.some((a) => p.endsWith(path.sep + a)) &&
        NOBLE_HASH.test(fs.readFileSync(p, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no @noble Argon2 anywhere in production code: the PIN and backup KDFs run natively', () => {
    const offenders = files.filter((p) => NOBLE_ARGON2.test(fs.readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no @noble/post-quantum anywhere in production code: ML-KEM-768 runs natively', () => {
    const offenders = files.filter((p) => NOBLE_PQ.test(fs.readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('cryptoSetup installs the RNG without evaluating @noble first', () => {
    const src = fs.readFileSync(path.join(MOBILE_ROOT, 'cryptoSetup.ts'), 'utf8');
    expect(src).toMatch(/from '\.\/src\/crypto\/sodium\/random'/);
    const random = fs.readFileSync(path.join(FACADE_DIR, 'random.ts'), 'utf8');
    expect(random).not.toMatch(/from\s+'@noble|require\('@noble/);
  });
});
