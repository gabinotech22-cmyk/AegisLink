/**
 * The `vault:call` boundary (F-1b): a compromised renderer can only send
 * well-formed requests, and gets envelopes, never exceptions or keys.
 */
import { describe, it, expect } from 'vitest'
import { KeyVault } from '../vault'
import { runVaultOp } from '../ops'
import { memoryKekStore } from './directBridge'

describe('runVaultOp', () => {
  const vault = new KeyVault(memoryKekStore)

  it('rejects unknown ops, bad arguments and non-byte payloads', () => {
    expect(runVaultOp(vault, 'readKek', [])).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, '__proto__', [])).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, 'unlock', 'self')).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, 'unlock', ['../etc'])).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, 'generate', ['self', 'rsa'])).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, 'sign', [0, new Uint8Array(1)])).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, 'sign', [1, 'text'])).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, 'load', ['self', new Uint8Array(3)])).toMatchObject({ ok: false, code: 'REJECTED' })
  })

  it('never returns a secret: generate gives a handle, a public key and a blob', () => {
    expect(runVaultOp(vault, 'unlock', ['self'])).toEqual({ ok: true, value: undefined })
    const r = runVaultOp(vault, 'generate', ['self', 'x25519'])
    expect(r.ok).toBe(true)
    const value = (r as { value: Record<string, unknown> }).value
    expect(Object.keys(value).sort()).toEqual(['blob', 'handle', 'publicKey', 'type'])
    expect(runVaultOp(vault, 'lock', ['self'])).toEqual({ ok: true, value: undefined })
    expect(runVaultOp(vault, 'scalarMult', [value.handle, new Uint8Array(32).fill(9)])).toMatchObject({ ok: false, code: 'NOKEY' })
  })

  it('a raw key leaves only for a declared export, and only when the user confirms (native dialog)', () => {
    runVaultOp(vault, 'unlock', ['self'])
    const g = runVaultOp(vault, 'generate', ['self', 'x25519']) as { value: { handle: number } }
    const asked: string[] = []
    const yes = { confirmExport: (p: string) => (asked.push(p), true) }
    const no = { confirmExport: (p: string) => (asked.push(p), false) }
    // No hooks (the default): never.
    expect(runVaultOp(vault, 'exportSecret', [g.value.handle, 'x25519', 'backup'])).toMatchObject({ ok: false, code: 'DENIED' })
    // Declined in the dialog.
    expect(runVaultOp(vault, 'exportSecret', [g.value.handle, 'x25519', 'backup'], no)).toMatchObject({ ok: false, code: 'DENIED' })
    // A purpose outside the explicit exports is refused before asking anybody.
    expect(runVaultOp(vault, 'exportSecret', [g.value.handle, 'x25519', 'debug'], yes)).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(asked).toEqual(['backup'])
    // Confirmed: 32 raw bytes.
    const r = runVaultOp(vault, 'exportSecret', [g.value.handle, 'x25519', 'recoveryPhrase'], yes) as { ok: boolean; value: Uint8Array }
    expect(r.ok).toBe(true)
    expect(r.value).toHaveLength(32)
    expect(asked).toEqual(['backup', 'recoveryPhrase'])
    // Wrong declared type: not available.
    expect(runVaultOp(vault, 'exportSecret', [g.value.handle, 'ed25519', 'backup'], yes)).toMatchObject({ ok: false, code: 'NOKEY' })
    runVaultOp(vault, 'lock', ['self'])
  })

  it('copy re-wraps a key for another unlocked profile only', () => {
    runVaultOp(vault, 'unlock', ['self'])
    const g = runVaultOp(vault, 'generate', ['self', 'x25519']) as { value: { handle: number; publicKey: Uint8Array } }
    expect(runVaultOp(vault, 'copy', [g.value.handle, 'locked-slot'])).toMatchObject({ ok: false, code: 'NOKEY' })
    runVaultOp(vault, 'unlock', ['work'])
    const c = runVaultOp(vault, 'copy', [g.value.handle, 'work']) as { ok: boolean; value: { blob: Uint8Array; publicKey: Uint8Array } }
    expect(c.ok).toBe(true)
    expect(c.value.publicKey).toEqual(g.value.publicKey)
    expect(runVaultOp(vault, 'load', ['work', c.value.blob])).toMatchObject({ ok: true })
    expect(runVaultOp(vault, 'load', ['self', c.value.blob])).toMatchObject({ ok: false, code: 'REJECTED' })
    runVaultOp(vault, 'lockAll', [])
  })
})
