/**
 * torBridges — the platform-independent bridge core (Tor always-on: no clearnet
 * fallback, so a network that blocks Tor is only reachable through a bridge).
 * Twin of desktop/src/main/tor/__tests__/bridges.test.ts.
 */
import BUILTIN from '../builtinBridges.json';
import {
  normalizeBridgeLine,
  parseBridgeLines,
  bridgeLinesFor,
  ptsNeeded,
  torrcFor,
  nextAutoTransport,
  initialTransport,
  isBootstrapStalled,
  isConnectionMode,
  MAX_CUSTOM_BRIDGES,
  STALL_NO_PROGRESS_MS,
  STALL_CONNECTED_NO_PROGRESS_MS,
  STALL_TOTAL_MS,
} from '../torBridges';

const OBFS4 =
  'obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=AbC+d/EfG123= iat-mode=0';
const WEBTUNNEL =
  'webtunnel [2001:db8::1]:443 0123456789ABCDEF0123456789ABCDEF01234567 url=https://example.org/path ver=0.0.1';

describe('built-in bridges (Tor Browser pt_config.json)', () => {
  it('every built-in line passes our own validator — none would fail closed silently', () => {
    const all = [...BUILTIN.bridges.obfs4, ...BUILTIN.bridges.snowflake, ...BUILTIN.bridges.meek];
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const l of all) expect(normalizeBridgeLine(l)).toBe(l);
  });
  it('each transport maps to its own PT', () => {
    expect(ptsNeeded(bridgeLinesFor('obfs4'))).toEqual(['obfs4']);
    expect(ptsNeeded(bridgeLinesFor('snowflake'))).toEqual(['snowflake']);
    expect(ptsNeeded(bridgeLinesFor('meek'))).toEqual(['meek_lite']);
    expect(bridgeLinesFor('direct')).toEqual([]);
  });
});

describe('custom bridge lines — strict validation (they become torrc/SETCONF input)', () => {
  it('accepts obfs4, webtunnel (IPv6), vanilla and a leading "Bridge " keyword', () => {
    expect(normalizeBridgeLine(OBFS4)).toBe(OBFS4);
    expect(normalizeBridgeLine(WEBTUNNEL)).toBe(WEBTUNNEL);
    expect(normalizeBridgeLine('203.0.113.5:9001 0123456789ABCDEF0123456789ABCDEF01234567')).not.toBeNull();
    expect(normalizeBridgeLine(`Bridge ${OBFS4}`)).toBe(OBFS4);
    expect(normalizeBridgeLine(`  ${OBFS4.replace(/ /g, '   ')}  `)).toBe(OBFS4);
  });

  it('rejects anything that could inject a torrc directive', () => {
    for (const bad of [
      `${OBFS4}\nUseBridges 0`,
      `${OBFS4}\rSocksPort 0.0.0.0:9050`,
      `${OBFS4} "x"`,
      `${OBFS4} # comment`,
      `${OBFS4} a=b\\`,
      `obfs4 192.0.2.10:443 ${'A'.repeat(40)} cert=x\u0000`,
      'ClientTransportPlugin obfs4 exec /bin/sh',
      'SocksPort 0.0.0.0:9050',
      'obfs4 example.org:443',
      'conjure 192.0.2.1:80',
      '',
      'x'.repeat(2000),
    ]) {
      expect(normalizeBridgeLine(bad)).toBeNull();
    }
  });

  it('parseBridgeLines skips blanks/comments, dedupes, counts rejects, caps the list', () => {
    const r = parseBridgeLines(`# from the bot\n\n${OBFS4}\nBridge ${OBFS4}\nnot a bridge\n${WEBTUNNEL}\n`);
    expect(r.lines).toEqual([OBFS4, WEBTUNNEL]);
    expect(r.rejected).toBe(1);
    const many = Array.from({ length: 30 }, (_, i) => OBFS4.replace('192.0.2.10', `192.0.2.${i + 1}`)).join('\n');
    expect(parseBridgeLines(many).lines).toHaveLength(MAX_CUSTOM_BRIDGES);
  });

  it('custom transport re-validates stored lines (a tampered store cannot inject)', () => {
    expect(bridgeLinesFor('custom', [OBFS4, 'UseBridges 0\nSocksPort 1'])).toEqual([OBFS4]);
  });
});

describe('torrcFor', () => {
  it('direct → UseBridges 0', () => {
    expect(torrcFor([], {})).toEqual(['UseBridges 0']);
  });
  it('plugins first, then bridges, then UseBridges 1', () => {
    expect(torrcFor([OBFS4, WEBTUNNEL], { obfs4: 'socks5 127.0.0.1:4001', webtunnel: 'socks5 127.0.0.1:4002' })).toEqual([
      'ClientTransportPlugin obfs4 socks5 127.0.0.1:4001',
      'ClientTransportPlugin webtunnel socks5 127.0.0.1:4002',
      `Bridge ${OBFS4}`,
      `Bridge ${WEBTUNNEL}`,
      'UseBridges 1',
    ]);
  });
  it('fails CLOSED when a needed PT has no plugin', () => {
    expect(torrcFor([OBFS4, WEBTUNNEL], { obfs4: 'socks5 127.0.0.1:4001' })).toBeNull();
  });
});

describe('auto escalation and the bootstrap watchdog', () => {
  it('direct → snowflake → obfs4 → meek → give up', () => {
    expect(nextAutoTransport('direct')).toBe('snowflake');
    expect(nextAutoTransport('snowflake')).toBe('obfs4');
    expect(nextAutoTransport('obfs4')).toBe('meek');
    expect(nextAutoTransport('meek')).toBeNull();
    expect(nextAutoTransport('custom')).toBeNull();
  });
  it('auto starts from the last transport that worked; a fixed mode is itself', () => {
    expect(initialTransport('auto', null)).toBe('direct');
    expect(initialTransport('auto', 'obfs4')).toBe('obfs4');
    expect(initialTransport('auto', 'custom')).toBe('direct');
    expect(initialTransport('snowflake', 'obfs4')).toBe('snowflake');
  });
  it('before the first hop: 30s of silence means blocked', () => {
    const t0 = 1_000_000;
    expect(isBootstrapStalled({ startedAt: t0, lastProgressAt: t0, progress: 10, now: t0 + STALL_NO_PROGRESS_MS - 1 })).toBe(false);
    expect(isBootstrapStalled({ startedAt: t0, lastProgressAt: t0, progress: 10, now: t0 + STALL_NO_PROGRESS_MS + 1 })).toBe(true);
  });
  it('after the first hop: a slow directory download is NOT a stall (real obfs4: ~100s silent at 50%)', () => {
    const t0 = 1_000_000;
    expect(isBootstrapStalled({ startedAt: t0, lastProgressAt: t0 + 22_000, progress: 50, now: t0 + 122_000 })).toBe(false);
    expect(isBootstrapStalled({ startedAt: t0, lastProgressAt: t0, progress: 50, now: t0 + STALL_CONNECTED_NO_PROGRESS_MS + 1 })).toBe(true);
  });
  it('never connected after the total budget → stalled; at 100% → never', () => {
    const t0 = 1_000_000;
    expect(isBootstrapStalled({ startedAt: t0, lastProgressAt: t0 + STALL_TOTAL_MS - 5_000, progress: 90, now: t0 + STALL_TOTAL_MS + 1 })).toBe(true);
    expect(isBootstrapStalled({ startedAt: t0, lastProgressAt: t0, progress: 100, now: t0 + 999_999 })).toBe(false);
  });
  it('isConnectionMode guards stored values', () => {
    expect(isConnectionMode('auto')).toBe(true);
    expect(isConnectionMode('custom')).toBe(true);
    expect(isConnectionMode('off')).toBe(false);
    expect(isConnectionMode(undefined)).toBe(false);
  });
});
