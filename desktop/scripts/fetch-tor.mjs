/**
 * Fetch the Tor Expert Bundle binary that the desktop app embeds
 * (main/tor/torProcess.ts). Run before `npm run package` — CI and developers
 * alike. The tarball is verified against a PINNED sha256 (taken from
 * dist.torproject.org/torbrowser/<ver>/sha256sums-signed-build.txt, which is
 * GPG-signed by the Tor Browser team) before anything is extracted, so a
 * tampered mirror/CDN cannot ship us a fake tor.exe.
 *
 * Output (gitignored): resources/tor/<platform>-<arch>/tor(.exe) + docs.
 * Bump TOR_VERSION + TOR_SHA256 together; never one without the other.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const TOR_VERSION = '15.0.23'
const PINNED = {
  'win32-x64': {
    file: `tor-expert-bundle-windows-x86_64-${TOR_VERSION}.tar.gz`,
    sha256: '231dad6b9cb401a54c260db7046965ef04e4f72ff071b140d423fb5da281ab1e',
    bin: 'tor/tor.exe',
    out: 'tor.exe',
  },
}

const here = dirname(fileURLToPath(import.meta.url))
const key = `${process.platform}-${process.arch}`
const pin = PINNED[key]
if (!pin) {
  console.error(`fetch-tor: no pinned Tor bundle for ${key} — add it to PINNED (with its sha256)`)
  process.exit(1)
}

const outDir = join(here, '..', 'resources', 'tor', key)
const outBin = join(outDir, pin.out)
if (existsSync(outBin) && process.argv[2] !== '--force') {
  console.log(`fetch-tor: ${outBin} already present (use --force to refetch)`)
  process.exit(0)
}

// dist.torproject.org only keeps the CURRENT release; older versions move to
// archive.torproject.org within days (bit us in CI the day 15.0.23 shipped).
// The pinned sha256 makes either mirror equally trustworthy.
const MIRRORS = [
  `https://dist.torproject.org/torbrowser/${TOR_VERSION}/${pin.file}`,
  `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/${pin.file}`,
]
let bytes = null
for (const url of MIRRORS) {
  console.log(`fetch-tor: downloading ${url}`)
  const res = await fetch(url)
  if (res.ok) { bytes = Buffer.from(await res.arrayBuffer()); break }
  console.warn(`fetch-tor: HTTP ${res.status}, trying next mirror`)
}
if (!bytes) { console.error('fetch-tor: all mirrors failed'); process.exit(1) }
const sha = createHash('sha256').update(bytes).digest('hex')
if (sha !== pin.sha256) {
  console.error(`fetch-tor: sha256 MISMATCH\n  expected ${pin.sha256}\n  got      ${sha}\nRefusing to extract.`)
  process.exit(1)
}
console.log(`fetch-tor: sha256 OK (${sha})`)

const tmp = join(here, '..', 'resources', 'tor', `.tmp-${key}`)
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
const tarball = join(tmp, pin.file)
writeFileSync(tarball, bytes)
// Relative path + cwd: GNU tar (Git Bash) treats `D:\...` as a remote host.
execFileSync('tar', ['-xzf', pin.file], { cwd: tmp, stdio: 'inherit' })

mkdirSync(outDir, { recursive: true })
copyFileSync(join(tmp, pin.bin), outBin)
for (const doc of ['docs/tor.txt', 'docs/libevent.txt', 'docs/openssl.txt', 'docs/zlib.txt']) {
  const src = join(tmp, doc)
  if (existsSync(src)) copyFileSync(src, join(outDir, `LICENSE.${doc.split('/').pop()}`))
}
writeFileSync(join(outDir, 'VERSION'), `${TOR_VERSION}\n${pin.file}\n${sha}\n`)
rmSync(tmp, { recursive: true, force: true })
console.log(`fetch-tor: installed ${outBin} (Tor Expert Bundle ${TOR_VERSION})`)
console.log(readFileSync(join(outDir, 'VERSION'), 'utf8'))
