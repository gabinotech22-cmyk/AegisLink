/**
 * Audit regression tests (Section #14 of the production security audit).
 *
 * These are static-analysis (grep/AST-ish) and behavioural tests that lock in
 * the fixes for the May-2026 audit so a future careless edit doesn't silently
 * re-introduce a vulnerability. Each test maps to a finding ID (C-1, C-2,
 * H-1, H-2, H-3, H-5) and fails loud if the regression returns.
 */

import fs from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';
import { decodeUTF8, encodeBase64 } from 'tweetnacl-util';
import { handlePanicDeepLink } from '../utils/panicLink';
import { useIdentity } from '../store/identity';

const SRC = path.resolve(__dirname, '..');

/** Recursively collect *.ts and *.tsx files under `dir`, skipping tests/mocks. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__mocks__' || entry.name === 'node_modules') continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function grepFiles(re: RegExp, files: string[]): Array<{ file: string; line: number; match: string }> {
  const hits: Array<{ file: string; line: number; match: string }> = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) hits.push({ file: path.relative(SRC, f), line: i + 1, match: m[0] });
    }
  }
  return hits;
}

describe('C-1 — no hardcoded Tenor / Google API keys', () => {
  it('rejects any AIzaSy* literal in the source tree', () => {
    const allFiles = walk(SRC);
    const hits = grepFiles(/AIzaSy[A-Za-z0-9_-]{33}/g, allFiles);
    expect(hits).toEqual([]);
  });

  it('rejects any TENOR_KEY hardcoded constant', () => {
    const allFiles = walk(SRC);
    const hits = grepFiles(/const\s+TENOR_KEY\s*=\s*['"][^'"]+['"]/g, allFiles);
    expect(hits).toEqual([]);
  });
});

describe('C-2 / H-2 — no direct third-party fetches that leak the user IP', () => {
  it('GifPicker never calls tenor.googleapis.com directly', () => {
    const gifPicker = path.join(SRC, 'components', 'GifPicker.tsx');
    const src = fs.readFileSync(gifPicker, 'utf8');
    expect(src).not.toMatch(/tenor\.googleapis\.com/);
    expect(src).toMatch(/\/proxy\/gif/); // must use relay proxy
  });

  it('LinkPreview never calls external URLs directly', () => {
    const linkPreview = path.join(SRC, 'components', 'LinkPreview.tsx');
    const src = fs.readFileSync(linkPreview, 'utf8');
    // The fetch call should target the relay's /proxy/linkpreview endpoint
    expect(src).toMatch(/\/proxy\/linkpreview/);
    // It should NOT pass an external URL straight to fetch()
    expect(src).not.toMatch(/await fetch\(url[,\s)]/);
  });
});

describe('H-1 — SecureStore wrapper enforces AFTER_FIRST_UNLOCK', () => {
  it('utils/secureStore.ts exists and passes AFTER_FIRST_UNLOCK', () => {
    const wrapper = path.join(SRC, 'utils', 'secureStore.ts');
    expect(fs.existsSync(wrapper)).toBe(true);
    const src = fs.readFileSync(wrapper, 'utf8');
    expect(src).toMatch(/AFTER_FIRST_UNLOCK/);
  });

  it('migrated callers no longer import SecureStore directly', () => {
    const migratedFiles = [
      'store/profiles.ts',
      'lock/pin.ts',
      'screens/Backup.tsx',
      'screens/AppIcon.tsx',
      'store/preferences.ts',
      'screens/Panic.tsx',
    ];
    for (const rel of migratedFiles) {
      const p = path.join(SRC, rel);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, 'utf8');
      // Either they import { ss } from the wrapper, OR they don't import SecureStore at all.
      const importsWrapper = /from\s+['"][./]+utils\/secureStore['"]/.test(src);
      const importsRawSS = /import\s+\*\s+as\s+SecureStore\s+from\s+['"]expo-secure-store['"]/.test(src);
      // Migrated files MUST import the wrapper. They MAY also keep a raw import
      // ONLY if they need APIs the wrapper doesn't expose (e.g. AFTER_FIRST_UNLOCK
      // constant or getValueWithKeyAsync). Bare raw import + no wrapper = regression.
      expect(importsWrapper || !importsRawSS).toBe(true);
    }
  });
});

describe('H-3 — Backup is on Argon2id v3, still reads v1/v2', () => {
  it('BACKUP_VERSION is 3', () => {
    const backup = path.join(SRC, 'crypto', 'backup.ts');
    const src = fs.readFileSync(backup, 'utf8');
    expect(src).toMatch(/BACKUP_VERSION\s*=\s*3\s+as\s+const/);
  });

  it('decryptBackup handles all three versions (v1, v2, v3)', () => {
    const backup = path.join(SRC, 'crypto', 'backup.ts');
    const src = fs.readFileSync(backup, 'utf8');
    // The dispatch must reference all three version numbers somewhere
    expect(src).toMatch(/===\s*1/);
    expect(src).toMatch(/===\s*2/);
    expect(src).toMatch(/===\s*3|=== BACKUP_VERSION/);
  });
});

describe('H-5 — handlePanicDeepLink rejects malformed / unsigned tokens', () => {
  beforeEach(() => {
    // Reset identity store so we can plant a controlled keypair below.
    useIdentity.setState({ identity: null } as never, false);
  });

  it('rejects URLs that are not aegislink://panic', async () => {
    const ok = await handlePanicDeepLink('https://example.com/?token=x&sig=y');
    expect(ok).toBe(false);
  });

  it('rejects panic URLs without a sig parameter', async () => {
    const ok = await handlePanicDeepLink('aegislink://panic?token=abcd');
    expect(ok).toBe(false);
  });

  it('rejects panic URLs when identity is not loaded', async () => {
    const ok = await handlePanicDeepLink('aegislink://panic?token=abcd&sig=xyz');
    expect(ok).toBe(false);
  });

  it('rejects panic URLs with a forged (non-matching) signature', async () => {
    // Plant a fake identity in the store.
    const realKp = nacl.sign.keyPair();
    const attackerKp = nacl.sign.keyPair();
    useIdentity.setState({
      identity: {
        aegisId: 'AAA-AAAA-AAAA',
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(32),
        publicKeyB64: '',
        secretKeyB64: '',
        signingPublicKey: realKp.publicKey,
        signingSecretKey: realKp.secretKey,
        signingPublicKeyB64: encodeBase64(realKp.publicKey),
        signingSecretKeyB64: encodeBase64(realKp.secretKey),
        createdAt: Date.now(),
      },
    } as never, false);

    // Attacker signs the same token with their key — should be rejected.
    const token = 'forged-token-uuid';
    const forgedSig = encodeBase64(nacl.sign.detached(decodeUTF8(token), attackerKp.secretKey));
    const ok = await handlePanicDeepLink(`aegislink://panic?token=${token}&sig=${encodeURIComponent(forgedSig)}`);
    expect(ok).toBe(false);
  });
});

describe('M-2 — certificate pinning manifest entries exist', () => {
  it('Android network_security_config.xml exists with a pin-set', () => {
    const nsc = path.resolve(SRC, '..', 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml');
    expect(fs.existsSync(nsc)).toBe(true);
    const src = fs.readFileSync(nsc, 'utf8');
    expect(src).toMatch(/<pin-set/);
    expect(src).toMatch(/aegislink\.duckdns\.org/);
  });

  it('AndroidManifest.xml references the network security config', () => {
    const manifest = path.resolve(SRC, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    const src = fs.readFileSync(manifest, 'utf8');
    expect(src).toMatch(/networkSecurityConfig="@xml\/network_security_config"/);
  });

  it('iOS app.json declares NSPinnedDomains for the relay', () => {
    const appJson = path.resolve(SRC, '..', 'app.json');
    const src = fs.readFileSync(appJson, 'utf8');
    expect(src).toMatch(/NSPinnedDomains/);
    expect(src).toMatch(/aegislink\.duckdns\.org/);
  });
});
