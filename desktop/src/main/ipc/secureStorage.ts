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

function assertKeyAllowed(key: string): void {
  // Audited against every secureStorage key the renderer actually writes
  // (grep for `aegis.` literals under src/renderer). Keep in sync when adding
  // new keys — a miss here fails silently at the feature level.
  const pattern =
    /^aegis\.(?:[a-zA-Z0-9_\-]+\.)?(secretKey\.b64|signSecretKey\.b64|activeProfile|activeSlotId|slotsList|profiles\.v1|displayName|avatarColor|avatarImage|profileStatus|workDisplayName|workAvatarColor|workAvatarImage|workProfileStatus|panic\.v1|preferences\.v1|polls\.v1|identity\.v1|prekeys\.v1|prekeysPublished|pin\.v1|pin\.salt\.v2|dbkek\.salt\.v1|group\.v1|deviceId|scheduled\.desktop\.v1|distribution\.v1|spkSecret\.b64|spkSecret\.\d+|spk\.keyId|pqSpkSecret\.\d+|pqSpk\.keyId|secdiag\.v1|opkIds\.json|opkSecret\.\d+|self\.ratchet\.[0-9A-HJKMNP-TV-Z\-]+)$/
  if (!pattern.test(key)) {
    throw new Error('Access denied: key is not whitelisted for renderer access')
  }
}

function assertValidValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 65536) throw new Error('invalid value')
}

function getKeystorePath(): string {
  return path.join(app.getPath('userData'), 'keystore.json')
}

export function readKeystore(): Keystore {
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

export function writeKeystore(keystore: Keystore): void {
  const keystorePath = getKeystorePath()
  fs.writeFileSync(keystorePath, JSON.stringify(keystore), { mode: 0o600 })
}

export function registerSecureStorageHandlers(): void {
  ipcMain.handle('secureStorage:set', (event, key: string, value: string): void => {
    assertTrustedSender(event)
    assertValidKey(key)
    assertKeyAllowed(key)
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
      // Dev-only fallback: base64 encoding (NOT encrypted) for local development
      // (the isPackaged branch above already failed closed in production).
      // nosemgrep: aegislink-no-plain-prefix-persist
      keystore[key] = 'plain:' + Buffer.from(value, 'utf-8').toString('base64')
    }
    writeKeystore(keystore)
  })

  ipcMain.handle('secureStorage:get', (event, key: string): string | null => {
    assertTrustedSender(event)
    assertValidKey(key)
    assertKeyAllowed(key)
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
    assertKeyAllowed(key)
    const keystore = readKeystore()
    delete keystore[key]
    writeKeystore(keystore)
  })

  // Panic-wipe support: remove every PREKEY SECRET from the keystore. The SQL
  // wipe (db:wipe-database) only clears tables; prekey secrets (SPK/OPK/PQSPK,
  // including the 2400-byte ML-KEM-768 PQSPK) live here and would otherwise
  // survive a panic. We also clear the local-only security diagnostics counter.
  // Keys are matched by pattern so unknown keyIds are covered without the
  // renderer having to enumerate them.
  ipcMain.handle('secureStorage:wipe-prekeys', (event): void => {
    assertTrustedSender(event)
    const pattern =
      /^aegis\.(?:[a-zA-Z0-9_\-]+\.)?(spkSecret\.b64|spkSecret\.\d+|spk\.keyId|pqSpkSecret\.\d+|pqSpk\.keyId|opkIds\.json|opkSecret\.\d+|secdiag\.v1)$/
    const keystore = readKeystore()
    let changed = false
    for (const key of Object.keys(keystore)) {
      if (pattern.test(key)) {
        delete keystore[key]
        changed = true
      }
    }
    if (changed) writeKeystore(keystore)
  })
}
