/**
 * transportArgs — the tor command line for a bridge transport (torProcess.ts).
 *
 * The exact shape was validated against the real bundled tor 15.0.23 on
 * 2026-09-23: snowflake bootstrapped to 100% in 51s and obfs4 in 123s with
 * `--ClientTransportPlugin "<pt> exec pluggable_transports\lyrebird.exe"` (a path
 * RELATIVE to tor's cwd, because tor splits the value on spaces and installs
 * live under "Program Files") plus one `--Bridge` per line and `--UseBridges 1`.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() },
  webContents: { getAllWebContents: () => [] },
}))

import { transportArgs } from '../torProcess'
import BUILTIN from '../builtinBridges.json'

const LYREBIRD = join('pluggable_transports', process.platform === 'win32' ? 'lyrebird.exe' : 'lyrebird')
const OBFS4 = 'obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=AbC+d/EfG123= iat-mode=0'

let withPt: string
let withoutPt: string

beforeAll(() => {
  const a = mkdtempSync(join(tmpdir(), 'aegis-tor-'))
  mkdirSync(join(a, 'pluggable_transports'))
  writeFileSync(join(a, LYREBIRD), '')
  withPt = join(a, 'tor.exe')
  withoutPt = join(mkdtempSync(join(tmpdir(), 'aegis-tor-')), 'tor.exe')
})

describe('transportArgs', () => {
  it('direct: bridges explicitly off', () => {
    expect(transportArgs('direct', [], withPt)).toEqual(['--UseBridges', '0'])
  })

  it('snowflake: relative lyrebird exec, every built-in line, then UseBridges 1', () => {
    const args = transportArgs('snowflake', [], withPt)!
    expect(args.slice(0, 2)).toEqual(['--ClientTransportPlugin', `snowflake exec ${LYREBIRD}`])
    const bridges = args.filter((_, i) => args[i - 1] === '--Bridge')
    expect(bridges).toEqual(BUILTIN.bridges.snowflake)
    expect(args.slice(-2)).toEqual(['--UseBridges', '1'])
  })

  it('custom lines are re-validated: an injected directive never reaches the command line', () => {
    const args = transportArgs('custom', [OBFS4, 'UseBridges 0\nSocksPort 0.0.0.0:9050'], withPt)!
    expect(args.filter((a) => a === '--Bridge')).toHaveLength(1)
    expect(args.join(' ')).not.toContain('SocksPort')
  })

  it('fails CLOSED: custom with no valid line, or lyrebird missing', () => {
    expect(transportArgs('custom', ['not a bridge'], withPt)).toBeNull()
    expect(transportArgs('obfs4', [], withoutPt)).toBeNull()
    // Direct needs no transport binary.
    expect(transportArgs('direct', [], withoutPt)).toEqual(['--UseBridges', '0'])
  })
})
