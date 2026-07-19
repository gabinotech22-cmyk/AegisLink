/**
 * Regression guards for the embedded-Tor iOS bridge (plugins/withTorEmbeddedIOS.js).
 *
 * Production crash (TestFlight build 20, .ips 2026-07-19): SIGABRT with TWO
 * "Tor" threads in the process. Chain: slow bootstrap → the 60s circuit
 * watchdog failed the attempt with `running` still NO (the flip lived behind
 * the watchdog's settled-guard) → the mailbox retry loop called start() again
 * → the `if (self.running)` guard passed → a SECOND TORThread was allocated →
 * C-Tor's non-reentrant global state hit a fatal assertion → abort().
 *
 * C-Tor cannot restart in-process (upstream limitation), so the bridge must
 * never create more than one TORThread per process — retries RE-ATTACH to the
 * existing instance. These assertions pin that invariant in the plugin source
 * the same way audit-regression.test.ts pins App.tsx guards.
 */
import * as fs from 'fs';
import * as path from 'path';

const PLUGIN_PATH = path.join(__dirname, '..', '..', 'plugins', 'withTorEmbeddedIOS.js');
const SRC = fs.readFileSync(PLUGIN_PATH, 'utf8');

describe('embedded Tor iOS bridge — single-instance invariants', () => {
  it('allocates exactly ONE TORThread in the whole bridge', () => {
    const allocs = SRC.match(/\[\[TORThread alloc\]/g) ?? [];
    expect(allocs).toHaveLength(1);
  });

  it('start() re-attaches when a Tor thread already exists, before ever allocating', () => {
    const guard = SRC.indexOf('if (self.torThread) {');
    const alloc = SRC.indexOf('[[TORThread alloc]');
    expect(guard).toBeGreaterThan(-1);
    expect(alloc).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(alloc);
    // The re-attach branch polls the existing instance instead of returning a
    // bare error — a later startTor() must still resolve once Tor comes up.
    const reattachBlock = SRC.slice(guard, alloc);
    expect(reattachBlock).toContain('pollForControlPortFile');
  });

  it('circuit observer flips `running` unconditionally (no watchdog guard in front)', () => {
    const obsStart = SRC.indexOf('addObserverForCircuitEstablished');
    expect(obsStart).toBeGreaterThan(-1);
    const block = SRC.slice(obsStart, SRC.indexOf('}];', obsStart));
    expect(block).toContain('strongSelf.running = YES');
    // The old bug: `running = YES` sat behind a per-attempt `circuitSettled`
    // guard, so a circuit established after the 60s watchdog never flipped it.
    expect(block).not.toContain('circuitSettled');
  });

  it('stop() never nils torThread (a nil pointer would allow a second alloc)', () => {
    const stopStart = SRC.indexOf('- (void)stopWithCompletion');
    expect(stopStart).toBeGreaterThan(-1);
    const block = SRC.slice(stopStart, SRC.indexOf('@end', stopStart));
    expect(block).not.toMatch(/self\.torThread\s*=\s*nil/);
  });
});
