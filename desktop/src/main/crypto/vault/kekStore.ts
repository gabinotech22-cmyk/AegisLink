/**
 * The desktop vault's per-profile KEK store (F-1b): 32 random bytes per profile
 * slot, encrypted with Electron `safeStorage` (DPAPI / Keychain / libsecret)
 * in `<userData>/vault-kek.json`. The renderer never reaches this file or the
 * KEK: it lives only in the main process and the vault's secure memory.
 *
 * Fail closed like `ipc/secureStorage.ts`: a packaged build without safeStorage
 * refuses to create or read a KEK; an entry that does not decrypt is reported
 * as lost (never silently replaced, which would orphan every blob).
 */
import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import type { KekStore } from './vault'

type KekFile = Record<string, string>

function filePath(): string {
  return path.join(app.getPath('userData'), 'vault-kek.json')
}

function read(): KekFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath(), 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as KekFile) : {}
  } catch {
    return {}
  }
}

function write(file: KekFile): void {
  const p = filePath()
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

export const safeStorageKekStore: KekStore = {
  getOrCreate(slot: string): Uint8Array {
    const file = read()
    const stored = file[slot]
    if (stored) {
      if (stored.startsWith('plain:')) {
        if (app.isPackaged) throw new Error('vault: plaintext KEK found in a production build')
        return new Uint8Array(Buffer.from(stored.slice(6), 'base64'))
      }
      let b64: string
      try {
        b64 = safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      } catch {
        throw new Error('vault: KEK lost (safeStorage cannot decrypt it)')
      }
      return new Uint8Array(Buffer.from(b64, 'base64'))
    }
    const kek = new Uint8Array(randomBytes(32))
    if (safeStorage.isEncryptionAvailable()) {
      file[slot] = 'enc:' + safeStorage.encryptString(Buffer.from(kek).toString('base64')).toString('base64')
    } else if (app.isPackaged) {
      kek.fill(0)
      throw new Error('vault: safeStorage unavailable on a production build')
    } else {
      // Dev-only (unpackaged) fallback, refused above in production.
      // nosemgrep: aegislink-no-plain-prefix-persist
      file[slot] = 'plain:' + Buffer.from(kek).toString('base64')
    }
    write(file)
    return kek
  },

  destroy(slot: string): void {
    const file = read()
    if (slot in file) {
      delete file[slot]
      write(file)
    }
  },
}
