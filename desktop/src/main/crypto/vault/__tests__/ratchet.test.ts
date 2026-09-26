/**
 * The Double Ratchet in the desktop key vault (F-1b phase 3), main process:
 * what the renderer can never see — the sealed state itself — and the IPC
 * contract of the ratchet ops. Twin checks on mobile: the C interop test
 * (`mobile/modules/aegis-sodium/test/ratchet-interop.mjs`) and
 * `mobile/src/socket/__tests__/ratchetSerde.persistence.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import sodium from 'sodium-native'
import { KeyVault } from '../vault'
import { VaultRatchet, prims } from '../ratchet'
import { runVaultOp } from '../ops'
import * as core from '../ratchetCore'
import { RATCHET_STATE_LEN, MAX_SKIPPED, decodeRatchetState } from '../ratchetState'
import { memoryKekStore } from './directBridge'

const vault = new KeyVault(memoryKekStore)
vault.unlock('self')
vault.unlock('selg')
const r = new VaultRatchet(vault)
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array | null | undefined): string | null => (b ? new TextDecoder().decode(b) : null)

/** The raw state inside a sealed blob: only the main process (and this test) can open it. */
const peek = (sealed: Uint8Array, slot = 'self') => decodeRatchetState(vault.openPayload(slot, 6, sealed, RATCHET_STATE_LEN))

function pair(hybrid: boolean) {
  const rk = crypto.getRandomValues(new Uint8Array(32))
  const spk = vault.generate('self', 'x25519prekey')
  const pq = hybrid ? vault.generate('self', 'mlkem768') : null
  const alice = r.initAlice('self', rk.slice(), spk.publicKey, pq ? pq.publicKey : null)
  const bob = r.initBob('self', rk.slice(), spk.handle, pq ? pq.handle : null)
  vault.release(spk.handle)
  if (pq) vault.release(pq.handle)
  return { a: alice.sealed, b: bob.sealed }
}

describe('VaultRatchet (main process)', () => {
  it('runs a hybrid conversation on sealed states only', () => {
    let { a, b } = pair(true)
    for (let i = 0; i < 3; i++) {
      const m = r.encrypt('self', a, enc(`a${i}`))
      a = m.sealed
      expect(m.header.pqPub).toHaveLength(1184)
      const d = r.decrypt('self', b, m.header, new Uint8Array([...m.nonce, ...m.ciphertext]))
      expect(text(d?.plaintext)).toBe(`a${i}`)
      b = d!.sealed
      const back = r.encrypt('self', b, enc(`b${i}`))
      b = back.sealed
      const d2 = r.decrypt('self', a, back.header, new Uint8Array([...back.nonce, ...back.ciphertext]))
      expect(text(d2?.plaintext)).toBe(`b${i}`)
      a = d2!.sealed
    }
    expect(peek(a).PQs).not.toBeNull()
  })

  it('caps the skipped message keys at MAX_SKIPPED inside the sealed state', () => {
    let { a, b } = pair(false)
    const msgs = []
    for (let i = 0; i <= MAX_SKIPPED; i++) {
      const m = r.encrypt('self', a, enc(`m${i}`))
      a = m.sealed
      msgs.push(m)
    }
    const last = msgs[MAX_SKIPPED]
    b = r.decrypt('self', b, last.header, new Uint8Array([...last.nonce, ...last.ciphertext]))!.sealed
    expect(peek(b).skipped).toHaveLength(MAX_SKIPPED)
    expect(() => {
      const more = []
      for (let i = 0; i <= MAX_SKIPPED + 1; i++) {
        const m = r.encrypt('self', a, enc('x'))
        a = m.sealed
        more.push(m)
      }
      const far = more[MAX_SKIPPED + 1]
      r.decrypt('self', b, far.header, new Uint8Array([...far.nonce, ...far.ciphertext]))
    }).toThrow(/Too many skipped/)
    const trimmed = r.trim('self', b, 10)
    expect(peek(trimmed.sealed).skipped.every((e) => e.n >= peek(b).Nr - 10)).toBe(true)
  })

  it('a forged message leaves no trace and returns null', () => {
    const { a, b } = pair(true)
    const m = r.encrypt('self', a, enc('hi'))
    const box = new Uint8Array([...m.nonce, ...m.ciphertext])
    box[30] ^= 1
    expect(r.decrypt('self', b, m.header, box)).toBeNull()
  })

  it('refuses a tampered, foreign, relabelled or locked state, and never loads one as a key', () => {
    const { a } = pair(false)
    const bad = a.slice()
    bad[bad.length - 1] ^= 1
    expect(() => r.encrypt('self', bad, enc('x'))).toThrow(/sealed state rejected/)
    expect(() => r.encrypt('selg', a, enc('x'))).toThrow(/sealed state rejected/)
    const relabel = a.slice()
    relabel[3] = 3
    expect(() => r.encrypt('self', relabel, enc('x'))).toThrow(/sealed state rejected/)
    expect(() => vault.load('self', a)).toThrow(/rejected/)
    const other = new KeyVault(memoryKekStore)
    expect(() => new VaultRatchet(other).encrypt('self', a, enc('x'))).toThrow(/locked/)
  })

  it("a session never starts from another profile's prekey", () => {
    const spk = vault.generate('selg', 'x25519prekey')
    expect(() => r.initBob('self', new Uint8Array(32).fill(1), spk.handle, null)).toThrow(/not available/)
  })

  it('imports a pre-phase-3 state once and refuses a malformed one', () => {
    const rk = crypto.getRandomValues(new Uint8Array(32))
    const spk = { publicKey: new Uint8Array(32), secretKey: crypto.getRandomValues(new Uint8Array(32)) }
    sodium.crypto_scalarmult_base(spk.publicKey, spk.secretKey)
    const alice = core.initAlice(prims, rk, spk.publicKey, null)
    const m = core.ratchetEncrypt(prims, alice, enc('legacy'))
    const imported = r.import('self', core.copyState(alice))
    expect(peek(imported.sealed).Ns).toBe(0)
    const bob = r.import('self', core.initBob(prims, rk, spk, null))
    expect(text(r.decrypt('self', bob.sealed, m.header, new Uint8Array([...m.nonce, ...m.ciphertext]))?.plaintext)).toBe('legacy')
    expect(() => r.import('self', { ...core.copyState(alice), RK: new Uint8Array(3) })).toThrow(/legacy session rejected/)
    expect(() => r.import('self', { DHs: {}, skipped: [] })).toThrow(/legacy session rejected/)
  })

  it('the vault algorithm zeroes the message key after sealing, also when sealing throws', () => {
    for (const fail of [false, true]) {
      const seen: Uint8Array[] = []
      const p: core.RatchetPrims = {
        ...prims,
        secretbox: (msg, n, k) => {
          seen.push(k)
          if (fail) throw new Error('seal failed')
          return prims.secretbox(msg, n, k)
        },
      }
      const s = core.initAlice(p, crypto.getRandomValues(new Uint8Array(32)), prims.x25519Keypair().publicKey, null)
      if (fail) expect(() => core.ratchetEncrypt(p, s, enc('x'))).toThrow('seal failed')
      else core.ratchetEncrypt(p, s, enc('x'))
      expect(seen).toHaveLength(1)
      expect(seen[0].every((x) => x === 0)).toBe(true)
    }
  })
})

describe('ratchet ops over vault:call', () => {
  it('return sealed states and public data only, never a key field', () => {
    const spk = vault.generate('self', 'x25519prekey')
    const init = runVaultOp(vault, 'ratchetInitAlice', ['self', new Uint8Array(32).fill(7), spk.publicKey, null])
    expect(init.ok).toBe(true)
    const v = (init as { value: Record<string, unknown> }).value
    expect(Object.keys(v).sort()).toEqual(['info', 'sealed'])
    expect(Object.keys(v.info as object).sort()).toEqual(['Nr', 'Ns', 'PN', 'dhr', 'dhsPublicKey', 'hasCKr', 'hasCKs', 'hybrid'])
    const e = runVaultOp(vault, 'ratchetEncrypt', ['self', v.sealed, enc('x')]) as { ok: boolean; value: Record<string, unknown> }
    expect(Object.keys(e.value).sort()).toEqual(['ciphertext', 'header', 'info', 'nonce', 'sealed'])
  })

  it('reject malformed arguments with BAD_ARG', () => {
    expect(runVaultOp(vault, 'ratchetEncrypt', ['self', 'nope', enc('x')])).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, 'ratchetTrim', ['self', new Uint8Array(1), -1])).toMatchObject({ ok: false, code: 'BAD_ARG' })
    expect(runVaultOp(vault, 'ratchetDecrypt', ['self', new Uint8Array(1), { n: -1 }, new Uint8Array(64)])).toMatchObject({ ok: false, code: 'BAD_ARG' })
  })
})
