/**
 * torConnection — HOW the embedded Tor reaches the Tor network (bridges).
 * Mobile twin of desktop/src/main/tor/torProcess.ts's bridge half; the pure
 * rules live in net/torBridges.ts (byte-identical with desktop).
 *
 *   - Settings (mode, custom bridge lines, last transport that worked) are
 *     device-wide in SecureStore: the network belongs to the device, not to a
 *     profile. No timestamps, no network names: configuration, not usage data.
 *   - Before tor's first start (tor.ts registerTorBeforeStart) the chosen
 *     transport is applied, so the first bootstrap already uses it.
 *   - Watchdog: tor's bootstrap progress (iOS events, Android polling). When it
 *     stalls in "auto", switch live to the next transport (direct → snowflake →
 *     obfs4 → meek, then round again). Never clearnet.
 *   - A binary without the bridge natives (built before bridges, reached by
 *     OTA) can only connect direct: "auto" stays on direct there. The UI says so.
 */
import { create } from 'zustand';
import { logger } from '../utils/logger';
import { ss } from '../utils/secureStore';
import {
  AUTO_ORDER,
  bridgeLinesFor,
  initialTransport,
  isBootstrapStalled,
  isConnectionMode,
  nextAutoTransport,
  parseBridgeLines,
  ptsNeeded,
  torrcFor,
  type PtName,
  type TorConnectionMode,
  type TorTransport,
} from './torBridges';
import {
  bridgesSupported,
  getBootstrap,
  isTorAvailable,
  onTorBootstrapProgress,
  onTorStatus,
  registerTorBeforeStart,
  setTorConfig as nativeSetTorConfig,
  startTransports as nativeStartTransports,
} from './tor';

const STORAGE_KEY = 'aegis.torConnection';
const WATCHDOG_TICK_MS = 5_000;

interface Settings {
  mode: TorConnectionMode;
  custom: string[];
  lastWorking: TorTransport | null;
}
const DEFAULTS: Settings = { mode: 'auto', custom: [], lastWorking: null };

interface TorConnectionState {
  mode: TorConnectionMode;
  custom: string[];
  /** Transport tor is using (or trying) now. */
  transport: TorTransport;
  /** 0-100 bootstrap progress; 100 = connected. */
  progress: number;
  /** false on a binary built before bridges (direct only). */
  bridgesAvailable: boolean;
  /** Last transport switch failed (e.g. a transport would not start). */
  error: string | null;
}

export const useTorConnection = create<TorConnectionState>(() => ({
  mode: 'auto',
  custom: [],
  transport: 'direct',
  progress: 0,
  bridgesAvailable: bridgesSupported(),
  error: null,
}));

let settings: Settings = DEFAULTS;
let boot = { startedAt: 0, lastProgressAt: 0, progress: 0 };
let watchdog: ReturnType<typeof setInterval> | null = null;
let applying = false;

/** Load and RE-VALIDATE (a tampered store must not inject torrc lines). */
export function parseStoredSettings(raw: string | null): Settings {
  if (!raw) return DEFAULTS;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    const mode = isConnectionMode(p.mode) ? p.mode : 'auto';
    const custom = Array.isArray(p.custom)
      ? parseBridgeLines(p.custom.filter((l): l is string => typeof l === 'string').join('\n')).lines
      : [];
    const lastWorking = isConnectionMode(p.lastWorking) && p.lastWorking !== 'auto' ? p.lastWorking : null;
    return { mode, custom, lastWorking };
  } catch {
    return DEFAULTS;
  }
}

async function save(next: Settings): Promise<void> {
  settings = next;
  useTorConnection.setState({ mode: next.mode, custom: [...next.custom] });
  try { await ss.set(STORAGE_KEY, JSON.stringify(next)); } catch { /* in-memory still applies */ }
}

/**
 * Point tor at `t`: start its pluggable transport, build the torrc lines and
 * hand them to native (applied live if tor is running). Returns false when the
 * transport cannot be used. The caller then does NOT connect direct instead:
 * that would defeat the user's choice (fail closed).
 */
async function apply(t: TorTransport): Promise<boolean> {
  if (!bridgesSupported()) return t === 'direct';
  const lines = bridgeLinesFor(t, settings.custom);
  if (t !== 'direct' && lines.length === 0) return false;
  try {
    const pts = ptsNeeded(lines);
    const ports = pts.length > 0 ? await nativeStartTransports(pts) : {};
    const plugin: Partial<Record<PtName, string>> = {};
    for (const pt of pts) if (ports[pt] > 0) plugin[pt] = `socks5 127.0.0.1:${ports[pt]}`;
    const torrc = torrcFor(lines, plugin);
    if (!torrc) return false;
    await nativeSetTorConfig(torrc);
    return true;
  } catch (e) {
    if (__DEV__) logger.warn('[torConnection] apply failed:', (e as Error).message);
    return false;
  }
}

async function switchTo(t: TorTransport): Promise<void> {
  if (applying) return;
  applying = true;
  try {
    const ok = await apply(t);
    boot = { startedAt: Date.now(), lastProgressAt: Date.now(), progress: 0 };
    useTorConnection.setState({ transport: t, progress: 0, error: ok ? null : `transport_unavailable:${t}` });
  } finally {
    applying = false;
  }
}

function onProgress(progress: number): void {
  if (progress !== boot.progress) boot = { ...boot, progress, lastProgressAt: Date.now() };
  useTorConnection.setState({ progress });
  if (progress >= 100) {
    const t = useTorConnection.getState().transport;
    // "auto" resumes from the transport that just worked on the next launch.
    if (settings.mode === 'auto' && settings.lastWorking !== t) void save({ ...settings, lastWorking: t });
  }
}

function startWatchdog(): void {
  if (watchdog) return;
  onTorBootstrapProgress((p) => onProgress(p.progress));
  onTorStatus((s) => { if (s.state === 'on') onProgress(100); });
  watchdog = setInterval(() => {
    void (async () => {
      if (boot.progress >= 100 || applying) return;
      const polled = await getBootstrap();
      if (polled) onProgress(polled.progress);
      if (boot.progress >= 100) return;
      if (!isBootstrapStalled({ ...boot, now: Date.now() })) return;
      if (settings.mode === 'auto' && bridgesSupported()) {
        await switchTo(nextAutoTransport(useTorConnection.getState().transport) ?? AUTO_ORDER[0]);
      } else {
        boot = { ...boot, startedAt: Date.now(), lastProgressAt: Date.now() };
      }
    })();
  }, WATCHDOG_TICK_MS);
}

/** Load settings and apply the first transport. Runs before tor's first start. */
async function beforeFirstStart(): Promise<void> {
  settings = parseStoredSettings(await ss.get(STORAGE_KEY).catch(() => null));
  useTorConnection.setState({ mode: settings.mode, custom: [...settings.custom], bridgesAvailable: bridgesSupported() });
  const first = bridgesSupported() ? initialTransport(settings.mode, settings.lastWorking) : 'direct';
  await switchTo(first);
  startWatchdog();
}

if (isTorAvailable()) registerTorBeforeStart(beforeFirstStart);

export type SetTorConnectionResult =
  | { ok: true; accepted: number; rejected: number }
  | { ok: false; error: 'invalid_mode' | 'no_valid_bridges' | 'bridges_unsupported' };

/**
 * Change how tor connects (Privacy → Network → Tor connection). `customText`
 * is what the user pasted; validated here. Applied live.
 */
export async function setTorConnection(mode: unknown, customText: string | null): Promise<SetTorConnectionResult> {
  if (!isConnectionMode(mode)) return { ok: false, error: 'invalid_mode' };
  if (mode !== 'auto' && mode !== 'direct' && !bridgesSupported()) return { ok: false, error: 'bridges_unsupported' };
  const parsed = parseBridgeLines(customText ?? '');
  const custom = customText !== null ? parsed.lines : settings.custom;
  if (mode === 'custom' && custom.length === 0) return { ok: false, error: 'no_valid_bridges' };
  await save({ mode, custom, lastWorking: mode === 'auto' ? settings.lastWorking : null });
  await switchTo(bridgesSupported() ? initialTransport(mode, settings.lastWorking) : 'direct');
  startWatchdog();
  return { ok: true, accepted: custom.length, rejected: parsed.rejected };
}

/** Test seam. */
export function __resetTorConnectionForTests(): void {
  settings = DEFAULTS;
  boot = { startedAt: 0, lastProgressAt: 0, progress: 0 };
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  applying = false;
}
