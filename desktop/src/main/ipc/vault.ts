import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { KeyVault } from '../crypto/vault/vault'
import { safeStorageKekStore } from '../crypto/vault/kekStore'
import { runVaultOp, type ExportPurpose, type VaultHooks, type VaultResult } from '../crypto/vault/ops'

const EXPORT_TEXT: Record<'es' | 'en', { title: string; detail: string; ok: string; cancel: string; purpose: Record<ExportPurpose, string> }> = {
  es: {
    title: 'AegisLink va a sacar tu clave privada de la bóveda',
    detail: 'Solo confirma si acabas de pedirlo tú. Cualquiera con esta clave puede hacerse pasar por ti.',
    ok: 'Permitir',
    cancel: 'Cancelar',
    purpose: { backup: 'Para crear el backup cifrado.', recoveryPhrase: 'Para mostrar tu frase de recuperación.' },
  },
  en: {
    title: 'AegisLink is about to take your private key out of the vault',
    detail: 'Only confirm if you just asked for it. Anyone holding this key can impersonate you.',
    ok: 'Allow',
    cancel: 'Cancel',
    purpose: { backup: 'To create the encrypted backup.', recoveryPhrase: 'To show your recovery phrase.' },
  },
}

/**
 * The ONLY gate on a raw key leaving the vault: a native dialog of this
 * process, which a compromised renderer can neither see nor click.
 */
const hooks: VaultHooks = {
  confirmExport(purpose) {
    const t = EXPORT_TEXT[app.getLocale().startsWith('es') ? 'es' : 'en']
    const opts = {
      type: 'warning' as const,
      message: t.title,
      detail: `${t.purpose[purpose]}\n\n${t.detail}`,
      buttons: [t.cancel, t.ok],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const win = BrowserWindow.getFocusedWindow()
    const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)
    return choice === 1
  },
}

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
 * crypto keeps its synchronous API. A private key crosses this channel outward
 * only through `exportSecret`, after the user allows it in a native dialog
 * (`hooks.confirmExport`); nothing is logged.
 */
export function registerVaultHandlers(): void {
  const vault = new KeyVault(safeStorageKekStore)
  ipcMain.on('vault:call', (event, op: unknown, args: unknown) => {
    let result: VaultResult
    try {
      assertTrustedSender(event)
      result = runVaultOp(vault, op, args, hooks)
    } catch (e) {
      result = { ok: false, code: 'FAIL', message: e instanceof Error ? e.message : String(e) }
    }
    event.returnValue = result
  })
}
