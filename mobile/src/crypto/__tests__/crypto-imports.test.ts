/**
 * F-1 seam guard: production code gets NaCl and hash/MAC/KDF primitives ONLY
 * from `src/crypto/sodium`, so swapping the implementation for a native
 * libsodium binding is a change to that one directory.
 *
 * Allowed exceptions:
 *   - `tweetnacl-util` (base64/utf8 codecs, no key material).
 *   - `@noble/hashes/sha2|sha256` in `crypto/backup.ts`: PBKDF2 takes the hash
 *     object, and the password KDFs stay on @noble until the new backup format.
 *   - @noble argon2 / pbkdf2 / utils and @noble/post-quantum (not migrated in F-1).
 * Twin guards: `desktop/src/renderer/crypto/__tests__/crypto-imports.test.ts`,
 * `server/src/__tests__/crypto-imports.test.ts`.
 */
import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(MOBILE_ROOT, 'src');
const FACADE_DIR = path.join(SRC_ROOT, 'crypto', 'sodium') + path.sep;

const TWEETNACL = /(?:from\s+'tweetnacl'|require\('tweetnacl'\))/;
const NOBLE_MAC_KDF = /from\s+'@noble\/hashes\/(?:hmac|hkdf)(?:\.js)?'/;
const NOBLE_HASH = /from\s+'@noble\/hashes\/(?:sha2|sha256|sha512)(?:\.js)?'/;
const NOBLE_HASH_ALLOWED = [path.join('crypto', 'backup.ts')];

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

  it('no direct tweetnacl import outside the facade', () => {
    const offenders = files.filter(
      (p) => !p.startsWith(FACADE_DIR) && TWEETNACL.test(fs.readFileSync(p, 'utf8')),
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

  it('cryptoSetup installs the RNG without evaluating @noble first', () => {
    const src = fs.readFileSync(path.join(MOBILE_ROOT, 'cryptoSetup.ts'), 'utf8');
    expect(src).toMatch(/from '\.\/src\/crypto\/sodium\/random'/);
    const random = fs.readFileSync(path.join(FACADE_DIR, 'random.ts'), 'utf8');
    expect(random).not.toMatch(/from\s+'@noble|require\('@noble/);
  });
});
