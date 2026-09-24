/**
 * F-1 seam guard: relay code gets NaCl primitives ONLY from `src/crypto/sodium`,
 * so the switch to native libsodium (sodium-native) is a change to that one
 * directory. `tweetnacl-util` (base64 codecs) stays allowed.
 * Twin guards: `mobile/src/crypto/__tests__/crypto-imports.test.ts`,
 * `desktop/src/renderer/crypto/__tests__/crypto-imports.test.ts`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACADE_DIR = path.join(SRC_ROOT, 'crypto', 'sodium') + path.sep;
const TWEETNACL = /(?:from\s+'tweetnacl'|require\('tweetnacl'\))/;

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') productionFiles(p, out);
    } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe('crypto primitives come only from src/crypto/sodium', () => {
  const files = productionFiles(SRC_ROOT);

  it('scans a non-trivial tree (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('no direct tweetnacl import outside the facade', () => {
    const offenders = files.filter((p) => !p.startsWith(FACADE_DIR) && TWEETNACL.test(fs.readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
