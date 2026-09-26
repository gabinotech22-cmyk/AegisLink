/**
 * F-1b seam guard: private identity keys live in the key vault and leave it
 * only through the EXPLICIT exports of docs/F1B-KEY-VAULT-DESIGN.md §5 —
 * encrypted backup and recovery phrase (the desktop receives device links, it
 * never sends one). Every production call of
 * `vault.exportSecret` / `exportIdentitySecrets` must be on this allowlist, so
 * a new raw-key path cannot slip in unreviewed.
 * Twin guard: `mobile/src/crypto/__tests__/vaultExport.guard.test.ts`. On desktop the
 * main process also asks the user in a native dialog before any export.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../..');

const ALLOWED: Record<string, string> = {
  'crypto/sodium/vault.ts': 'defines exportSecret',
  'crypto/identity.ts': 'defines exportIdentitySecrets',
  'screens/Backup.tsx': 'encrypted backup + recovery phrase',
};

const EXPORT_CALL = /\b(?:exportSecret|exportIdentitySecrets)\s*\(/;

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

describe('vault keys leave the vault only through the explicit exports', () => {
  const files = productionFiles(SRC_ROOT);

  it('scans a non-trivial tree (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every export call is on the allowlist', () => {
    const offenders = files
      .map((p) => path.relative(SRC_ROOT, p).split(path.sep).join('/'))
      .filter((rel) => !(rel in ALLOWED) && EXPORT_CALL.test(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(EXPORT_CALL.test(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8'))).toBe(true);
    }
  });

  it('the Identity type carries no raw secret fields', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'crypto/identity.ts'), 'utf8');
    const body = src.slice(src.indexOf('export interface Identity {'), src.indexOf('}', src.indexOf('export interface Identity {')));
    expect(body).toMatch(/secretKey: VaultKey;/);
    expect(body).toMatch(/signingSecretKey: VaultKey;/);
    expect(body).not.toMatch(/SecretKeyB64|secretKeyB64/);
  });
});
