/**
 * Test-only replacement for the renderer's `sodiumIpcBridge.ts` (wired by the
 * alias in vitest.config.ts). Runs the SAME operation table the `sodium:*` IPC
 * handler runs (`../ops.ts`, real sodium-native), and round-trips arguments and
 * results through structuredClone exactly like Electron IPC does, so renderer
 * tests exercise the production path minus the process hop.
 *
 * Structurally matches `SodiumBridge` (src/renderer/crypto/ipc-types.ts); kept
 * free of renderer imports because main and renderer are separate TS projects.
 */
import { runSodiumOp, MAX_SYNC_ARG_BYTES, MAX_ASYNC_ARG_BYTES } from '../ops'

const bridge = {
  call: (op: string, args: unknown[]): unknown =>
    structuredClone(runSodiumOp(op, structuredClone(args), MAX_SYNC_ARG_BYTES)),
  callAsync: async (op: string, args: unknown[]): Promise<unknown> =>
    structuredClone(runSodiumOp(op, structuredClone(args), MAX_ASYNC_ARG_BYTES)),
}

export function sodiumBridge(): typeof bridge {
  return bridge
}
