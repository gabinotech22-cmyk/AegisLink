import { ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { runSodiumOp, MAX_SYNC_ARG_BYTES, MAX_ASYNC_ARG_BYTES } from '../crypto/sodium/ops'
import type { SodiumResult } from '../crypto/sodium/ops'

function assertTrustedSender(e: IpcMainEvent | IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

/**
 * F-1: the sandboxed renderer's crypto primitives run on native libsodium in
 * this process (the renderer cannot load native addons).
 *
 * - `sodium:call` is SYNCHRONOUS (`ipcRenderer.sendSync`) so the renderer's
 *   ratchet / X3DH / sealed-sender code keeps its synchronous API and stays in
 *   lockstep with mobile. Each call costs ~0.2 ms (measured: X25519 over IPC is
 *   faster than it was in pure JS).
 * - `sodium:call-async` (`invoke`) carries whole attachments without blocking
 *   the renderer.
 *
 * Keys crossing this channel stay on the device (renderer ↔ main of the same
 * app); nothing is logged. Envelopes, not exceptions: sendSync cannot carry one.
 */
export function registerSodiumHandlers(): void {
  ipcMain.on('sodium:call', (event, op: unknown, args: unknown) => {
    let result: SodiumResult
    try {
      assertTrustedSender(event)
      result = runSodiumOp(op, args, MAX_SYNC_ARG_BYTES)
    } catch (e) {
      result = { ok: false, errorName: 'Error', message: e instanceof Error ? e.message : String(e) }
    }
    event.returnValue = result
  })

  ipcMain.handle('sodium:call-async', (event, op: unknown, args: unknown): SodiumResult => {
    assertTrustedSender(event)
    return runSodiumOp(op, args, MAX_ASYNC_ARG_BYTES)
  })
}
