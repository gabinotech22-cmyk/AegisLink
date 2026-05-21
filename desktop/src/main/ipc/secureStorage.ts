import { ipcMain, safeStorage, app } from 'electron'
import fs from 'fs'
import path from 'path'

type Keystore = Record<string, string>

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
  ipcMain.handle('secureStorage:set', (_event, key: string, value: string): void => {
    const encrypted = safeStorage.encryptString(value)
    const keystore = readKeystore()
    keystore[key] = encrypted.toString('base64')
    writeKeystore(keystore)
  })

  ipcMain.handle('secureStorage:get', (_event, key: string): string | null => {
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

  ipcMain.handle('secureStorage:delete', (_event, key: string): void => {
    const keystore = readKeystore()
    delete keystore[key]
    writeKeystore(keystore)
  })
}
