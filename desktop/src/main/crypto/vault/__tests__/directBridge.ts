/**
 * Test-only replacement for the renderer's `vaultIpcBridge.ts` (vitest alias):
 * runs the SAME vault operation table as the `vault:call` handler
 * (`../ops.ts`, real sodium-native secure memory) with an in-memory KEK store
 * standing in for safeStorage, and clones arguments and results like Electron
 * IPC does.
 */
import { KeyVault, type KekStore } from '../vault'
import { runVaultOp } from '../ops'

const keks = new Map<string, Uint8Array>()
export const memoryKekStore: KekStore = {
  getOrCreate(slot) {
    let k = keks.get(slot)
    if (!k) {
      k = crypto.getRandomValues(new Uint8Array(32))
      keks.set(slot, k)
    }
    return k.slice()
  },
  destroy(slot) {
    keks.delete(slot)
  },
}

const vault = new KeyVault(memoryKekStore)

const bridge = {
  call: (op: string, args: unknown[]): unknown => structuredClone(runVaultOp(vault, op, structuredClone(args))),
}

export function vaultBridge(): typeof bridge {
  return bridge
}
