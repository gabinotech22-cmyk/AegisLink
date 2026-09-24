/**
 * socket.io-over-Tor bridge (desktop port of the mobile `AegisTor.sio*` native
 * bridge, docs/FASE4-TOR-EMBEDDED-IMPL.md §2.2).
 *
 * A DUMB PIPE: the renderer keeps the whole mailbox protocol (possession-proof
 * signing, epoch catch-up, sealed v2) in `renderer/socket/mailboxSocket.ts`;
 * this module only owns a socket.io-client instance whose TCP goes through the
 * ISOLATED mailbox SOCKS listener (torProcess.ts) so its circuits never share
 * a session group with the aegisId control socket. Payloads are forwarded as
 * JSON strings and never interpreted here.
 *
 * Fail-closed: `sio-connect` waits for Tor to be bootstrapped before dialing;
 * the socket is created with `socks5h://` so hostname (.onion) resolution
 * happens inside Tor — no local DNS ever sees the relay address.
 */
import { ipcMain, webContents } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { io, type Socket } from 'socket.io-client'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { getTorStatus, whenTorReady, getTorConnection, setTorConnection } from './torProcess'
import { isOnionUrl } from './pure'

interface Forward {
  id: string
  event: string
  args: unknown[]
  ackId?: string
}

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

const sockets = new Map<string, Socket>()

function forward(msg: Forward): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('tor:sio-event', msg)
  }
}

/** Only .onion targets are allowed through this bridge — it exists for the hidden service. */
function assertOnionUrl(url: unknown): asserts url is string {
  if (!isOnionUrl(url)) throw new Error('sio bridge accepts http(s)://*.onion targets only')
}

export function registerTorSioHandlers(): void {
  ipcMain.handle('tor:sio-connect', async (event, id: unknown, url: unknown, authJson: unknown, eventsJson: unknown): Promise<boolean> => {
    assertTrustedSender(event)
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) throw new Error('invalid id')
    assertOnionUrl(url)
    if (typeof authJson !== 'string' || typeof eventsJson !== 'string') throw new Error('invalid args')
    const auth = JSON.parse(authJson) as Record<string, unknown>
    const events = JSON.parse(eventsJson) as string[]
    if (!Array.isArray(events) || !events.every((e) => typeof e === 'string')) throw new Error('invalid events')

    const prev = sockets.get(id)
    if (prev) { try { prev.removeAllListeners(); prev.disconnect() } catch { /* noop */ } sockets.delete(id) }

    await whenTorReady()
    const { mailboxSocksPort } = getTorStatus()
    if (!mailboxSocksPort) throw new Error('tor mailbox socks port unavailable')
    const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${mailboxSocksPort}`)

    const sock = io(url, {
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      auth,
      agent: agent as unknown as string, // engine.io typings declare `agent: string | boolean`; Node accepts an http.Agent
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      reconnectionAttempts: Infinity,
      timeout: 20000,
    })
    sockets.set(id, sock)

    sock.on('connect', () => forward({ id, event: 'connect', args: [] }))
    sock.on('disconnect', (reason) => forward({ id, event: 'disconnect', args: [reason] }))
    sock.on('connect_error', (e) => forward({ id, event: 'connect_error', args: [e?.message ?? 'connect_error'] }))
    for (const ev of events) {
      if (ev === 'connect' || ev === 'disconnect' || ev === 'connect_error') continue
      sock.on(ev, (...args: unknown[]) => forward({ id, event: ev, args }))
    }
    return true
  })

  ipcMain.handle('tor:sio-emit', (event, id: unknown, ev: unknown, payloadJson: unknown, ackId: unknown): boolean => {
    assertTrustedSender(event)
    if (typeof id !== 'string' || typeof ev !== 'string' || typeof payloadJson !== 'string') throw new Error('invalid args')
    const sock = sockets.get(id)
    if (!sock) return false
    const payload = JSON.parse(payloadJson) as unknown
    if (typeof ackId === 'string') {
      sock.emit(ev, payload, (...args: unknown[]) => forward({ id, event: '__ack', args, ackId }))
    } else {
      sock.emit(ev, payload)
    }
    return true
  })

  ipcMain.handle('tor:sio-disconnect', (event, id: unknown): boolean => {
    assertTrustedSender(event)
    if (typeof id !== 'string') throw new Error('invalid id')
    const sock = sockets.get(id)
    if (!sock) return false
    try { sock.removeAllListeners(); sock.disconnect() } catch { /* noop */ }
    sockets.delete(id)
    return true
  })

  ipcMain.handle('tor:status', (event) => {
    assertTrustedSender(event)
    return getTorStatus()
  })

  // Bridges (main/tor/bridges.ts). The renderer only proposes; main validates
  // the mode and every pasted line before anything reaches tor's arguments.
  ipcMain.handle('tor:get-connection', (event) => {
    assertTrustedSender(event)
    return getTorConnection()
  })
  ipcMain.handle('tor:set-connection', (event, mode: unknown, customText: unknown) => {
    assertTrustedSender(event)
    return setTorConnection(mode, customText === null ? undefined : customText)
  })
}

/** Tear down every bridged socket (app quit). */
export function disconnectAllTorSockets(): void {
  for (const [, s] of sockets) { try { s.removeAllListeners(); s.disconnect() } catch { /* noop */ } }
  sockets.clear()
}
