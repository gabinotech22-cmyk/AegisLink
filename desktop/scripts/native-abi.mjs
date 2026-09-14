/**
 * Swap the prebuilt `better-sqlite3-multiple-ciphers` binary between the Node
 * ABI (what `npm ci` installs — needed by vitest) and the Electron ABI (what
 * the packaged app needs). electron-builder's own @electron/rebuild step proved
 * unreliable here (it reported success while leaving the Node-ABI binary in
 * place → packaged app failed with NODE_MODULE_VERSION mismatch, see
 * docs/DESKTOP-BETA.md), so `npm run package` calls this explicitly:
 *
 *   node scripts/native-abi.mjs electron   # before electron-builder
 *   node scripts/native-abi.mjs node       # after, so `npm test` works again
 *
 * Uses the module's own prebuild-install (official prebuilt binaries, no
 * compiler needed). Electron version is read from package.json devDependencies.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
if (target !== 'electron' && target !== 'node') {
  console.error('usage: native-abi.mjs <electron|node>')
  process.exit(1)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const moduleDir = join(root, 'node_modules', 'better-sqlite3-multiple-ciphers')
// Invoke the JS entry through node (no .cmd shim, no shell) so a workspace path
// with spaces cannot break the call.
const prebuildInstall = join(root, 'node_modules', 'prebuild-install', 'bin.js')

const args = ['--verbose']
if (target === 'electron') {
  const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  args.push('--runtime=electron', `--target=${electronVersion}`)
  console.log(`native-abi: installing Electron ${electronVersion} prebuilt`)
} else {
  console.log(`native-abi: installing Node ${process.versions.node} prebuilt`)
}
rmSync(join(moduleDir, 'build'), { recursive: true, force: true })
execFileSync(process.execPath, [prebuildInstall, ...args], { cwd: moduleDir, stdio: 'inherit' })
void pkg
console.log('native-abi: done')
