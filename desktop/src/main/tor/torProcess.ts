/**
 * Embedded Tor lifecycle for the desktop client (sealed-sender Fase 4, desktop
 * parity with mobile/src/net/tor.ts — see docs/DESKTOP-BETA.md §Tor).
 *
 * Spawns the bundled C-Tor (`tor.exe` from the Tor Expert Bundle, fetched by
 * scripts/fetch-tor.mjs and shipped via electron-builder `extraResources`),
 * opens TWO SOCKS listeners and reports bootstrap progress:
 *
 *   - `controlSocksPort` → the whole Chromium session (control socket, HTTP,
 *     TURN-over-TCP) is proxied through it via `session.setProxy`.
 *   - `mailboxSocksPort` → the mailbox delivery socket (sioBridge.ts). Separate
 *     listener = separate Tor session group = separate circuits, so the relay
 *     cannot relink the opaque mailbox id to the aegisId control socket by
 *     seeing both arrive over one circuit.
 *
 * Fail-closed by construction: the proxy is pointed at `controlSocksPort`
 * BEFORE any window exists, so if Tor never bootstraps nothing reaches the
 * network — there is no clearnet fallback (golden rule: Tor always-on, no
 * toggle). Tor is a child with `__OwningControllerProcess` so it dies with us.
 */
import { app, webContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseBootstrapLine, isTorErrorLine } from './pure'

export type TorState = 'off' | 'starting' | 'on' | 'error'

export interface TorStatus {
  state: TorState
  /** 0-100 bootstrap progress (100 only when state === 'on'). */
  progress: number
  /** Tor's own phase summary, e.g. "Loading relay descriptors". */
  summary: string
  /** SOCKS port for the Chromium session (0 until chosen). */
  controlSocksPort: number
  /** SOCKS port for the isolated mailbox socket (0 until chosen). */
  mailboxSocksPort: number
}


let status: TorStatus = { state: 'off', progress: 0, summary: '', controlSocksPort: 0, mailboxSocksPort: 0 }
let child: ChildProcess | null = null
let readyResolvers: Array<() => void> = []
let stopping = false
let restartTimer: ReturnType<typeof setTimeout> | null = null
let restarts = 0

export function getTorStatus(): TorStatus {
  return { ...status }
}

function broadcast(): void {
  const snapshot = getTorStatus()
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('tor:status', snapshot)
  }
}

function setStatus(patch: Partial<TorStatus>): void {
  status = { ...status, ...patch }
  if (status.state === 'on') {
    const rs = readyResolvers
    readyResolvers = []
    for (const r of rs) r()
  }
  broadcast()
}

/** Resolves once Tor reports Bootstrapped 100%. Never rejects (fail-closed wait). */
export function whenTorReady(): Promise<void> {
  if (status.state === 'on') return Promise.resolve()
  return new Promise((resolve) => { readyResolvers.push(resolve) })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

/** Location of the bundled tor binary (packaged: resources/tor; dev: desktop/resources/tor/<platform>). */
export function torBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'tor.exe' : 'tor'
  if (app.isPackaged) return join(process.resourcesPath, 'tor', exe)
  return join(app.getAppPath(), 'resources', 'tor', `${process.platform}-${process.arch}`, exe)
}

/**
 * Pick the SOCKS ports (synchronously usable by the caller to configure the
 * session proxy) and start Tor. Idempotent. Returns the chosen ports.
 */
export async function startTor(): Promise<{ controlSocksPort: number; mailboxSocksPort: number }> {
  if (child) return { controlSocksPort: status.controlSocksPort, mailboxSocksPort: status.mailboxSocksPort }

  const controlSocksPort = await freePort()
  let mailboxSocksPort = await freePort()
  while (mailboxSocksPort === controlSocksPort) mailboxSocksPort = await freePort()
  setStatus({ state: 'starting', progress: 0, summary: 'Starting', controlSocksPort, mailboxSocksPort })

  const bin = torBinaryPath()
  if (!existsSync(bin)) {
    setStatus({ state: 'error', summary: `tor binary missing: ${bin}` })
    return { controlSocksPort, mailboxSocksPort }
  }

  const dataDir = join(app.getPath('userData'), 'tor')
  mkdirSync(dataDir, { recursive: true })
  spawnTor(bin, dataDir, controlSocksPort, mailboxSocksPort)
  return { controlSocksPort, mailboxSocksPort }
}

function spawnTor(bin: string, dataDir: string, controlSocksPort: number, mailboxSocksPort: number): void {
  const args = [
    '--DataDirectory', dataDir,
    '--SocksPort', `127.0.0.1:${controlSocksPort}`,
    '--SocksPort', `127.0.0.1:${mailboxSocksPort}`,
    '--ControlPort', '0',
    '--ClientOnly', '1',
    '--AvoidDiskWrites', '1',
    '--DormantCanceledByStartup', '1',
    '--Log', 'notice stdout',
    '--__OwningControllerProcess', String(process.pid),
  ]

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child = proc
  stopping = false

  let buf = ''
  const onData = (chunk: Buffer): void => {
    buf += chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const p = parseBootstrapLine(line)
      if (p) {
        if (p.progress >= 100) restarts = 0
        setStatus({ state: p.progress >= 100 ? 'on' : 'starting', progress: p.progress, summary: p.summary })
      }
      else if (isTorErrorLine(line)) setStatus({ state: 'error', summary: line.replace(/^.*\[err\]\s*/, '').slice(0, 200) })
    }
  }
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  proc.on('error', (e) => setStatus({ state: 'error', summary: e.message }))
  proc.on('exit', (code) => {
    child = null
    if (stopping) return
    // Tor died under us (crash, killed by AV, OOM). Reliability by engineering,
    // not by falling back to clearnet: respawn on the SAME ports (the session
    // proxy keeps pointing at them) with a capped backoff. Until it is back the
    // proxy refuses connections — still fail-closed.
    setStatus({ state: 'starting', progress: 0, summary: `tor exited (${code ?? 'signal'}) — restarting` })
    const delay = Math.min(30_000, 2_000 * 2 ** Math.min(restarts++, 4))
    restartTimer = setTimeout(() => { restartTimer = null; spawnTor(bin, dataDir, controlSocksPort, mailboxSocksPort) }, delay)
  })
}

export function stopTor(): void {
  stopping = true
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  if (!child) return
  try { child.kill() } catch { /* already gone */ }
  child = null
  setStatus({ state: 'off', progress: 0, summary: 'stopped' })
}
