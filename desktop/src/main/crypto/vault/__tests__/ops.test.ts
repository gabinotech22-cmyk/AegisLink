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
})
