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
 *
 * Bridges (bridges.ts): where the network blocks Tor, tor reaches the network
 * through a pluggable transport run by the bundled `lyrebird` (obfs4,
 * webtunnel, meek_lite, snowflake). Mode "auto" (default) starts from the last
 * transport that worked and, when the bootstrap stalls, restarts tor on the
 * next one (direct → snowflake → obfs4 → meek, then round again). It never
 * falls back to clearnet. The mode, custom bridge lines and last working transport
 * live in userData/tor-connection.json. That is local configuration, not usage
 * metadata: no timestamps, no networks.
 */
import { app, webContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseBootstrapLine, isTorErrorLine } from './pure'
import {
  AUTO_ORDER,
  SUPPORTED_PTS,
  bridgeLinesFor,
  initialTransport,
  isBootstrapStalled,
  isConnectionMode,
  nextAutoTransport,
  parseBridgeLines,
  torrcFor,
  type PtName,
  type TorConnectionMode,
  type TorTransport,
} from './bridges'

export type TorState = 'off' | 'starting' | 'on' | 'error'

export interface TorStatus {
  /** How the user asked tor to connect ("auto" or a fixed transport). */
  mode: TorConnectionMode
  /** The transport tor is using right now. */
  transport: TorTransport
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


let status: TorStatus = {
  mode: 'auto', transport: 'direct', state: 'off', progress: 0, summary: '', controlSocksPort: 0, mailboxSocksPort: 0,
}
let child: ChildProcess | null = null
let readyResolvers: Array<() => void> = []
let stopping = false
let restartTimer: ReturnType<typeof setTimeout> | null = null
let restarts = 0

// ── Bridge / transport state ─────────────────────────────────────────────────
interface ConnectionSettings {
  mode: TorConnectionMode
  /** Validated custom bridge lines (bridges.ts parseBridgeLines). */
  custom: string[]
  /** "auto" resumes from here next launch. */
  lastWorking: TorTransport | null
}
const DEFAULT_SETTINGS: ConnectionSettings = { mode: 'auto', custom: [], lastWorking: null }
let settings: ConnectionSettings = DEFAULT_SETTINGS
let transport: TorTransport = 'direct'
/** Set while we deliberately kill tor to switch transport: respawn at once, no crash backoff. */
let switching = false
let spawnArgs: { bin: string; dataDir: string; controlSocksPort: number; mailboxSocksPort: number } | null = null
let boot = { startedAt: 0, lastProgressAt: 0, progress: 0 }
let watchdog: ReturnType<typeof setInterval> | null = null
const WATCHDOG_TICK_MS = 5_000

function settingsPath(): string {
  return join(app.getPath('userData'), 'tor-connection.json')
}

/** Load and RE-VALIDATE (a tampered file must not inject torrc lines). */
function loadSettings(): ConnectionSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Record<keyof ConnectionSettings, unknown>>
    const mode = isConnectionMode(raw.mode) ? raw.mode : 'auto'
    const custom = Array.isArray(raw.custom)
      ? parseBridgeLines(raw.custom.filter((l): l is string => typeof l === 'string').join('\n')).lines
      : []
    const lastWorking = isConnectionMode(raw.lastWorking) && raw.lastWorking !== 'auto' ? raw.lastWorking : null
    return { mode, custom, lastWorking }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(next: ConnectionSettings): void {
  settings = next
  try { writeFileSync(settingsPath(), JSON.stringify(next)) } catch { /* in-memory still applies */ }
}

/** Path of the bundled pluggable-transport client, next to tor. */
function lyrebirdPath(bin: string): string {
  return join(dirname(bin), 'pluggable_transports', process.platform === 'win32' ? 'lyrebird.exe' : 'lyrebird')
}

/**
 * tor command-line arguments for a transport, or null when it cannot be used
 * (no custom lines, lyrebird missing): the caller fails CLOSED instead of
 * silently connecting direct. The exec path is RELATIVE to tor's cwd (its own
 * directory): tor splits `ClientTransportPlugin` on spaces, and the install
 * path may contain them ("Program Files").
 */
export function transportArgs(t: TorTransport, custom: readonly string[], bin: string): string[] | null {
  const lines = bridgeLinesFor(t, custom)
  if (t !== 'direct' && lines.length === 0) return null
  if (lines.length > 0 && !existsSync(lyrebirdPath(bin))) return null
  const rel = join('pluggable_transports', process.platform === 'win32' ? 'lyrebird.exe' : 'lyrebird')
  const plugin: Partial<Record<PtName, string>> = {}
  for (const pt of SUPPORTED_PTS) plugin[pt] = `exec ${rel}`
  const torrc = torrcFor(lines, plugin)
  if (!torrc) return null
  return torrc.flatMap((l) => {
    const i = l.indexOf(' ')
    return [`--${l.slice(0, i)}`, l.slice(i + 1)]
  })
}

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
  settings = loadSettings()
  transport = initialTransport(settings.mode, settings.lastWorking)
  spawnArgs = { bin, dataDir, controlSocksPort, mailboxSocksPort }
  spawnTor(bin, dataDir, controlSocksPort, mailboxSocksPort)
  startWatchdog()
  return { controlSocksPort, mailboxSocksPort }
}

function spawnTor(bin: string, dataDir: string, controlSocksPort: number, mailboxSocksPort: number): void {
  const bridgeArgs = transportArgs(transport, settings.custom, bin)
  if (!bridgeArgs) {
    // Fail closed: never "fix" an unusable bridge config by connecting direct.
    setStatus({ mode: settings.mode, transport, state: 'error', progress: 0, summary: `bridge transport unavailable: ${transport}` })
    boot = { startedAt: Date.now(), lastProgressAt: Date.now(), progress: 0 }
    return
  }
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
    ...bridgeArgs,
  ]

  // cwd = tor's own directory: the relative lyrebird path in bridgeArgs resolves there.
  const proc = spawn(bin, args, { cwd: dirname(bin), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child = proc
  stopping = false
  boot = { startedAt: Date.now(), lastProgressAt: Date.now(), progress: 0 }
  setStatus({ mode: settings.mode, transport, state: 'starting', progress: 0, summary: 'Starting' })

  let buf = ''
  const onData = (chunk: Buffer): void => {
    buf += chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const p = parseBootstrapLine(line)
      if (p) {
        if (p.progress !== boot.progress) boot = { ...boot, progress: p.progress, lastProgressAt: Date.now() }
        if (p.progress >= 100) {
          restarts = 0
          // "auto" resumes from the transport that just worked on the next launch.
          if (settings.mode === 'auto' && settings.lastWorking !== transport) saveSettings({ ...settings, lastWorking: transport })
        }
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
    if (switching) {
      // Deliberate transport switch (watchdog / user): come back at once on the
      // same ports with the new transport.
      switching = false
      spawnTor(bin, dataDir, controlSocksPort, mailboxSocksPort)
      return
    }
    // Tor died under us (crash, killed by AV, OOM). Reliability by engineering,
    // not by falling back to clearnet: respawn on the SAME ports (the session
    // proxy keeps pointing at them) with a capped backoff. Until it is back the
    // proxy refuses connections — still fail-closed.
    setStatus({ state: 'starting', progress: 0, summary: `tor exited (${code ?? 'signal'}) — restarting` })
    const delay = Math.min(30_000, 2_000 * 2 ** Math.min(restarts++, 4))
    restartTimer = setTimeout(() => { restartTimer = null; spawnTor(bin, dataDir, controlSocksPort, mailboxSocksPort) }, delay)
  })
}

/** Restart tor on `next` (same SOCKS ports: the session proxy keeps working). */
function switchTransport(next: TorTransport): void {
  transport = next
  if (child) {
    switching = true
    try { child.kill() } catch { switching = false }
    return
  }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  if (spawnArgs) spawnTor(spawnArgs.bin, spawnArgs.dataDir, spawnArgs.controlSocksPort, spawnArgs.mailboxSocksPort)
}

/**
 * Bootstrap watchdog. In "auto" a stalled bootstrap moves to the next transport
 * (and round again after the last: a network can unblock). A fixed mode keeps
 * trying the transport the user chose; the UI shows it as stalled.
 */
function startWatchdog(): void {
  if (watchdog) return
  watchdog = setInterval(() => {
    if (stopping || status.state === 'on') return
    if (!isBootstrapStalled({ ...boot, now: Date.now() })) return
    if (settings.mode === 'auto') {
      switchTransport(nextAutoTransport(transport) ?? AUTO_ORDER[0])
    } else {
      boot = { ...boot, startedAt: Date.now(), lastProgressAt: Date.now() }
      setStatus({ summary: `stalled on ${transport}` })
    }
  }, WATCHDOG_TICK_MS)
  watchdog.unref?.()
}

/** Current connection settings for the Privacy → Network screen. */
export function getTorConnection(): { mode: TorConnectionMode; custom: string[]; transport: TorTransport } {
  return { mode: settings.mode, custom: [...settings.custom], transport }
}

/**
 * Change how tor connects. `customText` is what the user pasted (validated here,
 * never trusted from the renderer). "custom" with no valid line is refused and
 * nothing changes. Tor restarts at once on the new transport.
 */
export function setTorConnection(
  mode: unknown,
  customText: unknown,
): { ok: true; accepted: number; rejected: number } | { ok: false; error: 'invalid_mode' | 'no_valid_bridges' } {
  if (!isConnectionMode(mode)) return { ok: false, error: 'invalid_mode' }
  const parsed = parseBridgeLines(typeof customText === 'string' ? customText : '')
  const custom = typeof customText === 'string' ? parsed.lines : settings.custom
  if (mode === 'custom' && custom.length === 0) return { ok: false, error: 'no_valid_bridges' }
  saveSettings({ mode, custom, lastWorking: mode === 'auto' ? settings.lastWorking : null })
  setStatus({ mode })
  switchTransport(initialTransport(mode, settings.lastWorking))
  return { ok: true, accepted: custom.length, rejected: parsed.rejected }
}

export function stopTor(): void {
  stopping = true
  if (watchdog) { clearInterval(watchdog); watchdog = null }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  if (!child) return
  try { child.kill() } catch { /* already gone */ }
  child = null
  setStatus({ state: 'off', progress: 0, summary: 'stopped' })
}
