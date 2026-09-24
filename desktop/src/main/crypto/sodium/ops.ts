/**
 * The operations the sandboxed renderer may run on native libsodium through
 * the `sodium:*` IPC channels (F-1). Pure module — no Electron import — so the
 * renderer test suite drives exactly this table in-process
 * (`src/renderer/crypto/sodium/__tests__/directBridge.ts`).
 *
 * `runSodiumOp` never throws: it returns an envelope, because
 * `ipcRenderer.sendSync` cannot carry an exception. The renderer facade
 * re-throws the error with the same class and message, so callers see the
 * TweetNaCl contract unchanged.
 */
import * as native from './native'
import * as hashes from './hashes'
import { boxBefore } from './boxBefore'

type Arg = Uint8Array | number | undefined
type OpFn = (...args: never[]) => unknown

const OPS = {
  randomBytes: native.randomBytes,
  verify: native.verify,
  box: native.box,
  boxOpen: native.boxOpen,
  boxBefore,
  boxKeyPair: native.boxKeyPair,
  boxKeyPairFromSecretKey: native.boxKeyPairFromSecretKey,
  secretbox: native.secretbox,
  secretboxOpen: native.secretboxOpen,
  scalarMult: native.scalarMult,
  scalarMultBase: native.scalarMultBase,
  signDetached: native.signDetached,
  signVerifyDetached: native.signVerifyDetached,
  signKeyPair: native.signKeyPair,
  signKeyPairFromSeed: native.signKeyPairFromSeed,
  hmacSha256: hashes.hmacSha256,
  hkdfSha256: hashes.hkdfSha256,
} satisfies Record<string, OpFn>

export type SodiumOp = keyof typeof OPS

export type SodiumResult =
  | { ok: true; value: unknown }
  | { ok: false; errorName: 'TypeError' | 'Error'; message: string }

/**
 * Defence-in-depth bounds on what a (possibly compromised) renderer can push
 * into the main process. Far above any legitimate call: sync calls carry keys,
 * ratchet frames and message bodies (the DB itself caps bodies at 8 MB); the
 * async path carries whole attachments.
 */
export const MAX_SYNC_ARG_BYTES = 64 * 1024 * 1024
export const MAX_ASYNC_ARG_BYTES = 1024 * 1024 * 1024
const MAX_RANDOM_BYTES = 1024 * 1024
const MAX_HKDF_BYTES = 255 * 32

export function isSodiumOp(op: unknown): op is SodiumOp {
  return typeof op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op)
}

function fail(errorName: 'TypeError' | 'Error', message: string): SodiumResult {
  return { ok: false, errorName, message }
}

export function runSodiumOp(op: unknown, args: unknown, maxArgBytes: number): SodiumResult {
  if (!isSodiumOp(op)) return fail('Error', 'unknown sodium op')
  if (!Array.isArray(args) || args.length > 5) return fail('Error', 'bad sodium args')
  let total = 0
  for (const a of args as Arg[]) {
    if (a === undefined) continue
    if (typeof a === 'number') {
      if (!Number.isSafeInteger(a) || a < 0) return fail('Error', 'bad sodium length')
      continue
    }
    if (!(a instanceof Uint8Array)) return fail('TypeError', 'unexpected type, use Uint8Array')
    total += a.byteLength
  }
  if (total > maxArgBytes) return fail('Error', 'sodium payload too large')
  if (op === 'randomBytes' && (args[0] as number) > MAX_RANDOM_BYTES) return fail('Error', 'bad sodium length')
  if (op === 'hkdfSha256' && (typeof args[3] !== 'number' || args[3] > MAX_HKDF_BYTES)) {
    return fail('Error', 'bad hkdf length')
  }
  try {
    return { ok: true, value: (OPS[op] as (...a: Arg[]) => unknown)(...(args as Arg[])) }
  } catch (e) {
    return fail(e instanceof TypeError ? 'TypeError' : 'Error', e instanceof Error ? e.message : String(e))
  }
}
