#!/usr/bin/env node
/**
 * Regenerate the built-in Tor bridge list shipped by the mobile and desktop
 * clients (mobile/src/net/builtinBridges.json, desktop/src/main/tor/builtinBridges.json)
 * from the pt_config.json inside the pinned Tor Expert Bundle — the same list Tor
 * Browser ships. Idempotent; run it whenever desktop/scripts/fetch-tor.mjs bumps
 * TOR_VERSION.
 *
 *   node scripts/sync-tor-bridges.mjs <path/to/pt_config.json> "<bundle file> sha256 <hex>"
 *
 * The pt_config.json must come from a bundle whose sha256 matches the pin in
 * desktop/scripts/fetch-tor.mjs (that script extracts it next to tor.exe).
 * The second argument is recorded as provenance in the JSON.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [cfgPath, provenance] = process.argv.slice(2)
if (!cfgPath || !provenance) {
  console.error('usage: node scripts/sync-tor-bridges.mjs <pt_config.json> "<bundle> sha256 <hex>"')
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const pick = (key, pt) => {
  const lines = cfg.bridges?.[key]
  if (!Array.isArray(lines) || lines.length === 0) throw new Error(`pt_config.json has no ${key} bridges`)
  for (const l of lines) {
    if (typeof l !== 'string' || !l.startsWith(`${pt} `) || /[\r\n"'#\\]/.test(l)) {
      throw new Error(`unexpected ${key} bridge line: ${l}`)
    }
  }
  return lines
}

const out = {
  source: `Tor Browser built-in bridges (pt_config.json) from ${provenance}`,
  bridges: {
    obfs4: pick('obfs4', 'obfs4'),
    snowflake: pick('snowflake', 'snowflake'),
    meek: pick('meek', 'meek_lite'),
  },
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const json = JSON.stringify(out, null, 2) + '\n'
for (const target of ['mobile/src/net/builtinBridges.json', 'desktop/src/main/tor/builtinBridges.json']) {
  writeFileSync(join(root, target), json)
  console.log(`sync-tor-bridges: wrote ${target}`)
}
console.log(`obfs4 ${out.bridges.obfs4.length}, snowflake ${out.bridges.snowflake.length}, meek ${out.bridges.meek.length}`)
