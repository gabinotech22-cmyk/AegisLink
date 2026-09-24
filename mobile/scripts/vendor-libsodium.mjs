#!/usr/bin/env node
/**
 * Vendor libsodium's C sources into modules/aegis-sodium/vendor/libsodium (F-1 B2).
 *
 * The mobile crypto module compiles libsodium FROM SOURCE inside the app build
 * (no prebuilt binaries: reproducible builds + F-Droid). The sources live in
 * the repo so the build needs no network. This script is how they get there,
 * and how anyone re-verifies them:
 *
 *   node scripts/vendor-libsodium.mjs          # (re)vendor VERSION
 *   node scripts/vendor-libsodium.mjs --check  # re-download, verify, diff vs repo
 *
 * Steps: download the official release tarball + .minisig from GitHub, verify
 * the minisign signature (Ed25519 over BLAKE2b-512, plus the global signature
 * over the trusted comment) against libsodium's published key using only
 * node:crypto, check the pinned tarball SHA-256, then copy src/libsodium,
 * LICENSE and the release's pre-generated version.h, and write
 * libsodium.manifest.json with a SHA-256 per file. The jest test
 * `modules/aegis-sodium/__tests__/vendor-manifest.test.ts` fails on any vendored
 * file that differs from the manifest.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.22';
const TARBALL = `libsodium-${VERSION}.tar.gz`;
const TARBALL_SHA256 = 'adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349';
const BASE_URL = `https://github.com/jedisct1/libsodium/releases/download/${VERSION}-RELEASE`;
/** libsodium's minisign public key (https://libsodium.gitbook.io/doc/installation). */
const MINISIGN_PUBKEY = 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(MOBILE, 'modules', 'aegis-sodium', 'vendor', 'libsodium');
const MANIFEST = path.join(MOBILE, 'modules', 'aegis-sodium', 'vendor', 'libsodium.manifest.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minisign verification (prehashed "ED" signatures only, as libsodium publishes). */
function verifyMinisign(file, minisig) {
  const pub = Buffer.from(MINISIGN_PUBKEY, 'base64');
  if (pub.subarray(0, 2).toString() !== 'Ed') throw new Error('minisign: unexpected public key algorithm');
  const keyId = pub.subarray(2, 10);
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.subarray(10, 42)]),
    format: 'der',
    type: 'spki',
  });
  const lines = minisig.toString('utf8').split('\n');
  const sigBlob = Buffer.from(lines[1].trim(), 'base64');
  if (sigBlob.subarray(0, 2).toString() !== 'ED') throw new Error('minisign: expected a prehashed (ED) signature');
  if (!sigBlob.subarray(2, 10).equals(keyId)) throw new Error('minisign: signature made with a different key');
  const sig = sigBlob.subarray(10, 74);
  const digest = createHash('blake2b512').update(file).digest();
  if (!verify(null, digest, key, sig)) throw new Error('minisign: BAD file signature');
  const trusted = lines[2].replace(/^trusted comment: /, '');
  const globalSig = Buffer.from(lines[3].trim(), 'base64');
  if (!verify(null, Buffer.concat([sig, Buffer.from(trusted)]), key, globalSig)) {
    throw new Error('minisign: BAD global signature (trusted comment)');
  }
  return trusted;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

async function buildTree(outDir) {
  const tarball = await download(`${BASE_URL}/${TARBALL}`);
  const minisig = await download(`${BASE_URL}/${TARBALL}.minisig`);
  const trusted = verifyMinisign(tarball, minisig);
  if (sha256(tarball) !== TARBALL_SHA256) throw new Error(`tarball sha256 mismatch: ${sha256(tarball)}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-libsodium-'));
  try {
    fs.writeFileSync(path.join(work, TARBALL), tarball);
    execFileSync('tar', ['-xzf', TARBALL], { cwd: work });
    const root = path.join(work, `libsodium-${VERSION}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.cpSync(path.join(root, 'src', 'libsodium'), path.join(outDir, 'src', 'libsodium'), { recursive: true });
    // Build-system files are not needed (the module compiles with its own CMake/podspec).
    for (const f of listFiles(path.join(outDir, 'src', 'libsodium'))) {
      if (!/\.(c|h|S)$/.test(f)) fs.rmSync(path.join(outDir, 'src', 'libsodium', f));
    }
    // version.h is normally generated by ./configure; the release ships the
    // same header pre-generated for MSVC — sodium-native uses it the same way.
    fs.copyFileSync(
      path.join(root, 'builds', 'msvc', 'version.h'),
      path.join(outDir, 'src', 'libsodium', 'include', 'sodium', 'version.h'),
    );
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const files = Object.fromEntries(listFiles(outDir).map((f) => [f, sha256(fs.readFileSync(path.join(outDir, f)))]));
  return {
    version: VERSION,
    source: `${BASE_URL}/${TARBALL}`,
    tarballSha256: TARBALL_SHA256,
    minisignPublicKey: MINISIGN_PUBKEY,
    minisignTrustedComment: trusted,
    files,
  };
}

async function main() {
  if (process.argv.includes('--check')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-libsodium-check-'));
    try {
      const fresh = await buildTree(tmp);
      const current = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      const diff = [];
      const all = new Set([...Object.keys(fresh.files), ...Object.keys(current.files)]);
      for (const f of all) if (fresh.files[f] !== current.files[f]) diff.push(f);
      for (const f of listFiles(VENDOR)) {
        if (sha256(fs.readFileSync(path.join(VENDOR, f))) !== fresh.files[f]) diff.push(`${f} (on disk)`);
      }
      if (diff.length) {
        console.error(`vendor-libsodium --check: ${diff.length} file(s) differ from the signed release:\n  ${diff.join('\n  ')}`);
        process.exit(1);
      }
      console.log(`vendor-libsodium --check: vendored libsodium ${VERSION} matches the signed release (${all.size} files).`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  const manifest = await buildTree(VENDOR);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
  console.log(`vendored libsodium ${VERSION}: ${Object.keys(manifest.files).length} files → ${path.relative(MOBILE, VENDOR)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
