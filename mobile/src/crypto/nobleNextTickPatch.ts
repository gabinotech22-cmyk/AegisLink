/**
 * Make @noble/hashes *Async KDFs actually yield to the event loop.
 *
 * noble's asyncLoop awaits `nextTick()` between work slices, but its default
 * implementation is `async () => {}` — an EMPTY MICROTASK. Microtasks run
 * before the JS thread returns to the host scheduler, so timers, rendering
 * and touch events stay blocked for the whole derivation: argon2idAsync /
 * pbkdf2Async freeze the UI exactly like their sync variants (verified
 * empirically: zero setInterval ticks fire during a 2 s derivation).
 *
 * `nextTick` is a mutable CommonJS export and asyncLoop re-reads it on every
 * yield, so replacing it with a real macrotask is the supported escape hatch.
 * Import this module (for side effects) before calling any *Async KDF.
 *
 * Pair with an `asyncTick` of ~25 ms in KDF opts: yielding every 25 ms of
 * work keeps the UI at ~30 fps during long derivations while adding only a
 * few percent of total runtime.
 */
const nobleUtils = require('@noble/hashes/utils') as { nextTick: () => Promise<void> };

nobleUtils.nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Yield-to-event-loop interval (ms) for @noble *Async KDF opts. */
export const KDF_ASYNC_TICK_MS = 25 as const;
