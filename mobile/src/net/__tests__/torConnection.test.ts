/**
 * torConnection — the mobile bridge orchestrator (Tor always-on: a network that
 * blocks Tor is only reachable through a bridge, never clearnet).
 */
const mockStore = new Map<string, string>();
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  },
}));

const mockTor = {
  supported: true,
  hook: null as null | (() => Promise<void>),
  progressCb: null as null | ((p: { progress: number; summary: string }) => void),
  startTransports: jest.fn(async (pts: readonly string[]) =>
    Object.fromEntries(pts.map((p, i) => [p, 41000 + i])) as Record<string, number>),
  setTorConfig: jest.fn(async (_lines: readonly string[]) => undefined),
  getBootstrap: jest.fn(async (): Promise<{ progress: number; summary: string } | null> => null),
};
jest.mock('../tor', () => ({
  isTorAvailable: () => true,
  bridgesSupported: () => mockTor.supported,
  registerTorBeforeStart: (h: () => Promise<void>) => { mockTor.hook = h; },
  startTransports: (pts: readonly string[]) => mockTor.startTransports(pts),
  setTorConfig: (lines: readonly string[]) => mockTor.setTorConfig(lines),
  getBootstrap: () => mockTor.getBootstrap(),
  onTorBootstrapProgress: (cb: (p: { progress: number; summary: string }) => void) => { mockTor.progressCb = cb; return () => undefined; },
  onTorStatus: () => () => undefined,
}));

const OBFS4 = 'obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=AbC+d/EfG123= iat-mode=0';

type Mod = typeof import('../torConnection');
let mod: Mod;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.resetModules();
  mockStore.clear();
  mockTor.supported = true;
  mockTor.hook = null;
  mockTor.startTransports.mockClear();
  mockTor.setTorConfig.mockClear();
  mockTor.getBootstrap.mockReset().mockResolvedValue(null);
  mod = require('../torConnection') as Mod;
});

afterEach(() => { mod.__resetTorConnectionForTests(); jest.useRealTimers(); });

describe('first start', () => {
  it('registers a pre-start hook; default auto starts direct (UseBridges 0, no transport)', async () => {
    expect(mockTor.hook).not.toBeNull();
    await mockTor.hook!();
    expect(mockTor.startTransports).not.toHaveBeenCalled();
    expect(mockTor.setTorConfig).toHaveBeenCalledWith(['UseBridges 0']);
    expect(mod.useTorConnection.getState().transport).toBe('direct');
  });

  it('auto resumes from the transport that worked last time', async () => {
    mockStore.set('aegis.torConnection', JSON.stringify({ mode: 'auto', custom: [], lastWorking: 'obfs4' }));
    await mockTor.hook!();
    expect(mockTor.startTransports).toHaveBeenCalledWith(['obfs4']);
    const lines = mockTor.setTorConfig.mock.calls[0]![0];
    expect(lines[0]).toBe('ClientTransportPlugin obfs4 socks5 127.0.0.1:41000');
    expect(lines.filter((l) => l.startsWith('Bridge obfs4 '))).not.toHaveLength(0);
    expect(lines[lines.length - 1]).toBe('UseBridges 1');
  });

  it('a binary without the bridge natives stays direct and never calls them', async () => {
    mockTor.supported = false;
    mockStore.set('aegis.torConnection', JSON.stringify({ mode: 'snowflake', custom: [], lastWorking: null }));
    await mockTor.hook!();
    expect(mockTor.startTransports).not.toHaveBeenCalled();
    expect(mockTor.setTorConfig).not.toHaveBeenCalled();
    expect(mod.useTorConnection.getState().transport).toBe('direct');
  });

  it('a tampered store cannot inject torrc lines', () => {
    const s = mod.parseStoredSettings(JSON.stringify({ mode: 'custom', custom: [OBFS4, 'UseBridges 0\nSocksPort 0.0.0.0:1'], lastWorking: 'auto' }));
    expect(s).toEqual({ mode: 'custom', custom: [OBFS4], lastWorking: null });
    expect(mod.parseStoredSettings('{bad json')).toEqual({ mode: 'auto', custom: [], lastWorking: null });
  });
});

describe('setTorConnection', () => {
  it('custom with no valid line is refused and changes nothing', async () => {
    expect(await mod.setTorConnection('custom', 'not a bridge\nSocksPort 1')).toEqual({ ok: false, error: 'no_valid_bridges' });
    expect(mockTor.setTorConfig).not.toHaveBeenCalled();
  });

  it('custom lines are validated, persisted and applied live; rejects are counted', async () => {
    const r = await mod.setTorConnection('custom', `${OBFS4}\nnot a bridge`);
    expect(r).toEqual({ ok: true, accepted: 1, rejected: 1 });
    expect(mockTor.setTorConfig).toHaveBeenLastCalledWith([
      'ClientTransportPlugin obfs4 socks5 127.0.0.1:41000',
      `Bridge ${OBFS4}`,
      'UseBridges 1',
    ]);
    expect(JSON.parse(mockStore.get('aegis.torConnection')!)).toMatchObject({ mode: 'custom', custom: [OBFS4] });
  });

  it('an unknown mode is refused; a fixed transport on an old binary is refused', async () => {
    expect(await mod.setTorConnection('off', null)).toEqual({ ok: false, error: 'invalid_mode' });
    mockTor.supported = false;
    expect(await mod.setTorConnection('snowflake', null)).toEqual({ ok: false, error: 'bridges_unsupported' });
  });

  it('fails closed: a transport that will not start is reported, never replaced by direct', async () => {
    mockTor.startTransports.mockRejectedValueOnce(new Error('E_PT'));
    await mod.setTorConnection('snowflake', null);
    expect(mockTor.setTorConfig).not.toHaveBeenCalled();
    expect(mod.useTorConnection.getState()).toMatchObject({ transport: 'snowflake', error: 'transport_unavailable:snowflake' });
  });
});

describe('watchdog', () => {
  it('auto: a bootstrap stuck before the first hop moves to the next transport', async () => {
    jest.useFakeTimers();
    await mockTor.hook!();
    mockTor.getBootstrap.mockResolvedValue({ progress: 5, summary: 'Connecting' });
    for (let i = 0; i < 8; i++) { jest.advanceTimersByTime(5_000); await flush(); }
    expect(mod.useTorConnection.getState().transport).toBe('snowflake');
    expect(mockTor.startTransports).toHaveBeenLastCalledWith(['snowflake']);
  });

  it('remembers the transport that reached 100% (auto)', async () => {
    await mod.setTorConnection('snowflake', null);
    await mod.setTorConnection('auto', null);
    mockTor.progressCb!({ progress: 100, summary: 'Done' });
    await flush();
    expect(JSON.parse(mockStore.get('aegis.torConnection')!).lastWorking).toBe('direct');
  });
});
