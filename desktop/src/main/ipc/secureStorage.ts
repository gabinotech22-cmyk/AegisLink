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
  //
  // Public channels are matched separately: their keys are suffixed with a
  // channel id, so they do not fit the "aegis.<slot>.<name>" shape the main
  // pattern below assumes.
  if (
    /^aegis\.pubchannel\.(cek|cap|sign|head|meta|applyesk|banned)\.v1\.[A-Za-z0-9_-]{1,128}$/.test(key) || // base64url channel id, unpadded
    /^aegis\.pubchannel\.(index|applyindex)\.v1$/.test(key) ||
    /^aegis\.channelKey(Index)?\.v1$/.test(key)
  ) {
    return
  }
  // Sealed-sender v2 + mailbox mode (Fase 4) keys were MISSING here until the
  // desktop Tor cutover: every `aegis.deliveryToken.*` / `aegis.mailboxRoot.*`
  // write threw "Access denied" → v2 silently degraded to v1 per contact and
  // the mailbox socket could never derive a root. Regression-tested in
  // __tests__/secureStorage.test.ts ("sealed-sender v2 / mailbox keys").
  const r = String.raw
  const AEGIS_ID = r`[0-9A-HJKMNP-TV-Z\-]+` // Crockford base32 id (no I/L/O/U)
  const pattern = new RegExp(
    r`^aegis\.(?:[a-zA-Z0-9_\-]+\.)?(` +
      [
        r`secretKey\.b64`, r`signSecretKey\.b64`, 'activeProfile', 'activeSlotId', 'slotsList', r`profiles\.v1`,
        'displayName', 'avatarColor', 'avatarImage', 'profileStatus',
        'workDisplayName', 'workAvatarColor', 'workAvatarImage', 'workProfileStatus',
        r`panic\.v1`, r`preferences\.v1`, r`polls\.v1`, r`identity\.v1`, r`prekeys\.v1`,
        'prekeysPublished', r`prekeysPublished\.[a-zA-Z0-9_\-]+`,
        r`pin\.v1`, r`pin\.salt\.v2`, r`dbkek\.salt\.v1`, r`group\.v1`, 'deviceId',
        r`scheduled\.desktop\.v1`, r`scheduled\.grouposts\.v1`, r`distribution\.v1`,
        r`spkSecret\.b64`, r`spkSecret\.\d+`, r`spk\.keyId`, r`spk\.createdAt`,
        r`pqSpkSecret\.\d+`, r`pqSpk\.keyId`, r`secdiag\.v1`, r`opkIds\.json`, r`opkSecret\.\d+`,
        r`self\.ratchet\.` + AEGIS_ID,
        // sealed-sender v2 delivery tokens (crypto/deliveryToken.ts)
        r`deliveryToken\.self`, r`deliveryToken\.peer\.` + AEGIS_ID,
        // mailbox roots + last-connect epoch (crypto/mailboxStore.ts)
        r`mailboxRoot\.self`, r`mailboxRoot\.peer\.` + AEGIS_ID, r`mailboxRoot\.lastEpoch`,
        // last-broadcast profile hash (socket/profileBroadcast.ts)
        r`pbh\.` + AEGIS_ID,
      ].join('|') +
      ')$',
  )
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
