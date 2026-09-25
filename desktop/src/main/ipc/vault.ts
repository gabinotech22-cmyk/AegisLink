import { ipcMain } from 'electron'
import type { IpcMainEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { KeyVault } from '../crypto/vault/vault'
import { safeStorageKekStore } from '../crypto/vault/kekStore'
import { runVaultOp, type VaultResult } from '../crypto/vault/ops'

function assertTrustedSender(e: IpcMainEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

/**
 * F-1b: the desktop key vault lives in this process (crypto/vault/vault.ts).
 * `vault:call` is SYNCHRONOUS (sendSync), like `sodium:call`, so the renderer's
 * crypto keeps its synchronous API. Private keys never cross this channel
 * outward; nothing is logged.
 */
export function registerVaultHandlers(): void {
  const vault = new KeyVault(safeStorageKekStore)
  ipcMain.on('vault:call', (event, op: unknown, args: unknown) => {
    let result: VaultResult
    try {
      assertTrustedSender(event)
      result = runVaultOp(vault, op, args)
    } catch (e) {
      result = { ok: false, code: 'FAIL', message: e instanceof Error ? e.message : String(e) }
    }
    event.returnValue = result
  })
}
