import { ipcMain, safeStorage, app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import fs from 'fs'
import path from 'path'

type Keystore = Record<string, string>

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512)
    throw new Error('invalid key')
}

function assertValidValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 65536) throw new Error('invalid value')
}

function getKeystorePath(): string {
  return path.join(app.getPath('userData'), 'keystore.json')
}

function readKeystore(): Keystore {
  const keystorePath = getKeystorePath()
  if (!fs.existsSync(keystorePath)) {
    return {}
  }
  try {
    const raw = fs.readFileSync(keystorePath, 'utf-8')
    return JSON.parse(raw) as Keystore
  } catch {
    return {}
  }
}

function writeKeystore(keystore: Keystore): void {
  const keystorePath = getKeystorePath()
  fs.writeFileSync(keystorePath, JSON.stringify(keystore), { mode: 0o600 })
}

export function registerSecureStorageHandlers(): void {
  ipcMain.handle('secureStorage:set', (event, key: string, value: string): void => {
    assertTrustedSender(event)
    assertValidKey(key)
    assertValidValue(value)
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('secure encryption not available on this system')
    }
    const encrypted = safeStorage.encryptString(value)
    const keystore = readKeystore()
    keystore[key] = encrypted.toString('base64')
    writeKeystore(keystore)
  })

  ipcMain.handle('secureStorage:get', (event, key: string): string | null => {
    assertTrustedSender(event)
    assertValidKey(key)
    const keystore = readKeystore()
    const encoded = keystore[key]
    if (!encoded) return null
    try {
      const buffer = Buffer.from(encoded, 'base64')
      return safeStorage.decryptString(buffer)
    } catch {
      return null
    }
  })

  ipcMain.handle('secureStorage:delete', (event, key: string): void => {
    assertTrustedSender(event)
    assertValidKey(key)
    const keystore = readKeystore()
    delete keystore[key]
    writeKeystore(keystore)
  })
}
