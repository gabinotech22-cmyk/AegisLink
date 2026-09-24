/**
 * F-1 seam guard: production code gets NaCl and hash/MAC/KDF primitives ONLY
 * from `src/renderer/crypto/sodium` (renderer) or `src/main/crypto/sodium`
 * (main process), so swapping the implementation for native libsodium is a
 * change to those two directories.
 *
 * Allowed exceptions:
 *   - `tweetnacl-util` (base64/utf8 codecs, no key material).
 *   - `@noble/hashes/sha2` in `crypto/backup.ts`: PBKDF2 takes the hash object,
 *     and the password KDFs stay on @noble until the new backup format.
 *   - @noble argon2 / pbkdf2 / utils and @noble/post-quantum (not migrated in F-1).
 * Twin guards: `mobile/src/crypto/__tests__/crypto-imports.test.ts`,
 * `server/src/__tests__/crypto-imports.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../..');
const FACADE_DIRS = [
  path.join(SRC_ROOT, 'renderer', 'crypto', 'sodium') + path.sep,
  path.join(SRC_ROOT, 'main', 'crypto', 'sodium') + path.sep,
];

const TWEETNACL = /(?:from\s+'tweetnacl'|require\('tweetnacl'\))/;
const NOBLE_MAC_KDF = /from\s+'@noble\/hashes\/(?:hmac|hkdf)(?:\.js)?'/;
const NOBLE_HASH = /from\s+'@noble\/hashes\/(?:sha2|sha256|sha512)(?:\.js)?'/;
const NOBLE_HASH_ALLOWED = [path.join('renderer', 'crypto', 'backup.ts')];

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

const inFacade = (p: string): boolean => FACADE_DIRS.some((d) => p.startsWith(d));

describe('crypto primitives come only from the sodium facades', () => {
  const files = productionFiles(SRC_ROOT);

  it('scans a non-trivial tree (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no direct tweetnacl import outside the facades', () => {
    const offenders = files.filter((p) => !inFacade(p) && TWEETNACL.test(fs.readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no direct @noble HMAC/HKDF import outside the facades', () => {
    const offenders = files.filter((p) => !inFacade(p) && NOBLE_MAC_KDF.test(fs.readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no direct @noble SHA-2 import outside the facades (PBKDF2 in backup.ts excepted)', () => {
    const offenders = files.filter(
      (p) =>
        !inFacade(p) &&
        !NOBLE_HASH_ALLOWED.some((a) => p.endsWith(path.sep + a)) &&
        NOBLE_HASH.test(fs.readFileSync(p, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
