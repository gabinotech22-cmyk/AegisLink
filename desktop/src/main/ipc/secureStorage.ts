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
    const keystore = readKeystore()
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value)
      keystore[key] = 'enc:' + encrypted.toString('base64')
    } else {
      // safeStorage unavailable (e.g. Windows without Credential Manager session).
      if (app.isPackaged) {
        // Production: never write keys in plaintext — fail loudly.
        throw new Error(
          'AegisLink: safeStorage unavailable on production build. Cannot store keys securely.'
        )
      }
      // Dev-only fallback: base64 encoding (NOT encrypted) for local development.
      keystore[key] = 'plain:' + Buffer.from(value, 'utf-8').toString('base64')
    }
    writeKeystore(keystore)
  })

  ipcMain.handle('secureStorage:get', (event, key: string): string | null => {
    assertTrustedSender(event)
    assertValidKey(key)
    const keystore = readKeystore()
    const encoded = keystore[key]
    if (!encoded) return null
    try {
      if (encoded.startsWith('plain:')) {
        if (app.isPackaged) {
          // A plaintext entry must never exist in production. Refuse to serve it.
          throw new Error(
            'AegisLink: plaintext keystore entry found in production build. Key storage is compromised.'
          )
        }
        return Buffer.from(encoded.slice(6), 'base64').toString('utf-8')
      }
      // Legacy entries without prefix and new 'enc:' entries are both encrypted.
      const raw = encoded.startsWith('enc:') ? encoded.slice(4) : encoded
      const buffer = Buffer.from(raw, 'base64')
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
