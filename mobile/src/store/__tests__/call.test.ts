/**
 * call store — minimized state machine tests
 *
 * Verifies the new `minimized` field introduced alongside FloatingCallBar:
 * - initial value is false
 * - setMinimized toggling
 * - setStatus auto-resets minimized for all non-in-call transitions
 * - setStatus('in-call') preserves the current minimized value
 * - startOutgoing / startIncoming / reset all spread `initial` (minimized: false)
 * - setStatus('in-call') sets startedAt; other transitions do NOT overwrite it
 */

// Zustand stores are singletons. Reset between tests by calling reset().
import { useCall } from '../call';

describe('call store — minimized state machine', () => {
  beforeEach(() => {
    useCall.getState().reset();
  });

  // ── 1. Initial state ────────────────────────────────────────────────────────

  it('initial state has minimized: false', () => {
    expect(useCall.getState().minimized).toBe(false);
  });

  // ── 2. setMinimized ─────────────────────────────────────────────────────────

  it('setMinimized(true) sets minimized to true', () => {
    useCall.getState().setMinimized(true);
    expect(useCall.getState().minimized).toBe(true);
  });

  it('setMinimized(false) after setMinimized(true) resets to false', () => {
    useCall.getState().setMinimized(true);
    useCall.getState().setMinimized(false);
    expect(useCall.getState().minimized).toBe(false);
  });

  // ── 3. setStatus('in-call') preserves minimized ─────────────────────────────

  it('setStatus("in-call") preserves minimized when already true', () => {
    // Put call into in-call first, minimize, then transition again
    useCall.getState().setStatus('in-call');
    useCall.getState().setMinimized(true);
    useCall.getState().setStatus('in-call');
    expect(useCall.getState().minimized).toBe(true);
  });

  it('setStatus("in-call") preserves minimized when it is false', () => {
    useCall.getState().setStatus('in-call');
    expect(useCall.getState().minimized).toBe(false);
  });

  // ── 4–6. setStatus non-in-call transitions reset minimized ──────────────────

  it('setStatus("connecting") resets minimized to false', () => {
    useCall.getState().setStatus('in-call');
    useCall.getState().setMinimized(true);
    useCall.getState().setStatus('connecting');
    expect(useCall.getState().minimized).toBe(false);
  });

  it('setStatus("ended") resets minimized to false', () => {
    useCall.getState().setStatus('in-call');
    useCall.getState().setMinimized(true);
    useCall.getState().setStatus('ended');
    expect(useCall.getState().minimized).toBe(false);
  });

  it('setStatus("outgoing-ringing") resets minimized to false', () => {
    useCall.getState().setStatus('in-call');
    useCall.getState().setMinimized(true);
    useCall.getState().setStatus('outgoing-ringing');
    expect(useCall.getState().minimized).toBe(false);
  });

  it('setStatus("incoming-ringing") resets minimized to false', () => {
    useCall.getState().setStatus('in-call');
    useCall.getState().setMinimized(true);
    useCall.getState().setStatus('incoming-ringing');
    expect(useCall.getState().minimized).toBe(false);
  });

  // ── 7. startOutgoing resets minimized ───────────────────────────────────────

  it('startOutgoing() resets minimized to false (spreads initial)', () => {
    useCall.getState().setStatus('in-call');
    useCall.getState().setMinimized(true);
    useCall.getState().startOutgoing('peer-1', 'call-1', 'audio');
    expect(useCall.getState().minimized).toBe(false);
  });

  // ── 8. startIncoming resets minimized ───────────────────────────────────────

  it('startIncoming() resets minimized to false', () => {
    useCall.getState().setStatus('in-call');
    useCall.getState().setMinimized(true);
    useCall.getState().startIncoming('peer-2', 'call-2', 'audio', 'sdp-offer');
    expect(useCall.getState().minimized).toBe(false);
  });

  // ── 9. reset() resets minimized ─────────────────────────────────────────────

  it('reset() resets minimized to false', () => {
    useCall.getState().setStatus('in-call');
    useCall.getState().setMinimized(true);
    useCall.getState().reset();
    expect(useCall.getState().minimized).toBe(false);
  });

  // ── 10. setStatus('in-call') sets startedAt ─────────────────────────────────

  it('setStatus("in-call") sets startedAt to approximately Date.now()', () => {
    const before = Date.now();
    useCall.getState().setStatus('in-call');
    const after = Date.now();
    const startedAt = useCall.getState().startedAt;
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeGreaterThanOrEqual(before);
    expect(startedAt!).toBeLessThanOrEqual(after);
  });

  // ── 11. setStatus('connecting') does NOT change startedAt ───────────────────

  it('setStatus("connecting") does NOT overwrite startedAt', () => {
    // First go in-call to set startedAt
    useCall.getState().setStatus('in-call');
    const startedAt = useCall.getState().startedAt;
    expect(startedAt).not.toBeNull();

    // Now transition to connecting — startedAt should be unchanged
    useCall.getState().setStatus('connecting');
    expect(useCall.getState().startedAt).toBe(startedAt);
  });

  it('setStatus("ended") does NOT overwrite startedAt set during in-call', () => {
    useCall.getState().setStatus('in-call');
    const startedAt = useCall.getState().startedAt;
    useCall.getState().setStatus('ended');
    expect(useCall.getState().startedAt).toBe(startedAt);
  });
});
