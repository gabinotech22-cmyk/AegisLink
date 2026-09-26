/**
 * The vault operations the sandboxed renderer may request over `vault:call`
 * (F-1b). Pure module (no Electron): tests drive it in-process
 * (`__tests__/directBridge.ts`). Handles are numbers; keys come back only
 * through `exportSecret`, after the user confirms it in a native dialog
 * (`VaultHooks`). Otherwise the renderer receives public keys, blobs,
 * signatures and the shared secrets that X3DH/ratchet still need in the
 * renderer until phase 3.
 *
 * `runVaultOp` never throws (sendSync cannot carry an exception): it returns an
 * envelope the renderer facade turns back into the same error.
 */
import { KeyVault, VaultError, type VaultKeyType } from './vault'

export type VaultResult =
  | { ok: true; value: unknown }
  | { ok: false; code: 'NOKEY' | 'REJECTED' | 'BAD_ARG' | 'DENIED' | 'FAIL'; message: string }

/** Why a raw key may leave the vault: the explicit exports of design doc §5. */
export type ExportPurpose = 'backup' | 'recoveryPhrase'
const PURPOSES: ReadonlySet<string> = new Set(['backup', 'recoveryPhrase'])

/**
 * Hooks the IPC layer supplies. `confirmExport` asks the USER, in a native
 * dialog of this process that the renderer cannot click, before any raw key
 * crosses to the renderer — so a compromised renderer can use keys while the
 * app runs but cannot silently exfiltrate them.
 */
export interface VaultHooks {
  confirmExport(purpose: ExportPurpose): boolean
}

const NO_EXPORTS: VaultHooks = { confirmExport: () => false }

class DeniedError extends Error {}

const TYPES: ReadonlySet<string> = new Set(['x25519', 'ed25519', 'mlkem768', 'secret32'])
const MAX_ARG_BYTES = 16 * 1024 * 1024

const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new VaultError('BAD_ARG', 'expected a string')
  return v
}
const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new VaultError('BAD_ARG', 'bad handle')
  return v
}
const bytes = (v: unknown): Uint8Array => {
  if (!(v instanceof Uint8Array)) throw new VaultError('BAD_ARG', 'unexpected type, use Uint8Array')
  if (v.byteLength > MAX_ARG_BYTES) throw new VaultError('BAD_ARG', 'payload too large')
  return v
}
const type = (v: unknown): VaultKeyType => {
  if (typeof v !== 'string' || !TYPES.has(v)) throw new VaultError('BAD_ARG', 'bad key type')
  return v as VaultKeyType
}

type Op = (vault: KeyVault, a: unknown[], hooks: VaultHooks) => unknown

const OPS: Record<string, Op> = {
  unlock: (v, a) => v.unlock(str(a[0])),
  lock: (v, a) => v.lock(str(a[0])),
  lockAll: (v) => v.lockAll(),
  destroyProfile: (v, a) => v.destroyProfile(str(a[0])),
  generate: (v, a) => v.generate(str(a[0]), type(a[1])),
  import: (v, a) => {
    const raw = bytes(a[2])
    try {
      return v.import(str(a[0]), type(a[1]), raw)
    } finally {
      raw.fill(0) // the IPC copy of a key being migrated
    }
  },
  load: (v, a) => v.load(str(a[0]), bytes(a[1])),
  deriveEd25519: (v, a) => v.deriveEd25519(num(a[0])),
  copy: (v, a) => v.copy(num(a[0]), str(a[1])),
  exportSecret: (v, a, h) => {
    const purpose = a[2]
    if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) throw new VaultError('BAD_ARG', 'bad export purpose')
    const t = type(a[1])
    const handle = num(a[0])
    if (!h.confirmExport(purpose as ExportPurpose)) throw new DeniedError('vault: export not confirmed by the user')
    return v.exportSecret(handle, t)
  },
  release: (v, a) => v.release(num(a[0])),
  sign: (v, a) => v.sign(num(a[0]), bytes(a[1])),
  scalarMult: (v, a) => v.scalarMult(num(a[0]), bytes(a[1])),
  box: (v, a) => v.box(num(a[0]), bytes(a[1]), bytes(a[2]), bytes(a[3])),
  boxOpen: (v, a) => v.boxOpen(num(a[0]), bytes(a[1]), bytes(a[2]), bytes(a[3])),
  mlkemDecapsulate: (v, a) => v.mlkemDecapsulate(num(a[0]), bytes(a[1])),
  liveKeys: (v) => v.liveKeys(),
}

export function runVaultOp(vault: KeyVault, op: unknown, args: unknown, hooks: VaultHooks = NO_EXPORTS): VaultResult {
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, op)) {
    return { ok: false, code: 'BAD_ARG', message: 'vault: unknown op' }
  }
  if (!Array.isArray(args) || args.length > 4) return { ok: false, code: 'BAD_ARG', message: 'vault: bad args' }
  try {
    return { ok: true, value: OPS[op](vault, args, hooks) }
  } catch (e) {
    if (e instanceof VaultError) return { ok: false, code: e.code, message: e.message }
    if (e instanceof DeniedError) return { ok: false, code: 'DENIED', message: e.message }
    return { ok: false, code: 'FAIL', message: e instanceof Error ? e.message : String(e) }
  }
}
