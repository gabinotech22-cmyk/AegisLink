/**
 * The vendored libsodium must be exactly the signed release: every file hashes
 * to the manifest written by `scripts/vendor-libsodium.mjs` (which verified the
 * release's minisign signature and pinned tarball SHA-256), and nothing was
 * added or removed. A hand edit to vendor/ — or a file slipped in — fails here.
 * Re-verify against the network with `node scripts/vendor-libsodium.mjs --check`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VENDOR = path.resolve(__dirname, '..', 'vendor', 'libsodium');
const MANIFEST = path.resolve(__dirname, '..', 'vendor', 'libsodium.manifest.json');

interface Manifest {
  version: string;
  tarballSha256: string;
  minisignPublicKey: string;
  files: Record<string, string>;
}

function listFiles(dir: string, base = dir): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]))
    .sort();
}

describe('vendored libsodium', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;

  it('is the pinned, signed release', () => {
    expect(manifest.version).toBe('1.0.22');
    expect(manifest.tarballSha256).toBe('adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349');
    // libsodium's published minisign key (https://libsodium.gitbook.io/doc/installation).
    expect(manifest.minisignPublicKey).toBe('RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3');
  });

  it('contains exactly the manifest files, byte for byte', () => {
    const onDisk = listFiles(VENDOR);
    expect(onDisk).toEqual(Object.keys(manifest.files).sort());
    const mismatched = onDisk.filter(
      (f) => createHash('sha256').update(fs.readFileSync(path.join(VENDOR, f))).digest('hex') !== manifest.files[f],
    );
    expect(mismatched).toEqual([]);
  });
});
