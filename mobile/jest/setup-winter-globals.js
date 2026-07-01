/**
 * Pre-warm Expo SDK 54's "winter" web globals under Jest 30.
 *
 * Expo's winter runtime installs web globals (TextEncoder/TextDecoder/URL/
 * atob/btoa/structuredClone) lazily via a Proxy whose `get` trap `require()`s
 * the polyfill on first property access (expo/src/winter/installGlobal.ts ->
 * runtime.native.ts). Jest 30 forbids a `require()` that runs mid-test —
 * jest-runtime's `throwIfBetweenTests` throws "You are trying to `require` a
 * file outside of the scope of the test code." Jest 29 tolerated it; jest-expo
 * ~54 is a jest-29 preset and does not pre-warm these.
 *
 * A parser that first touches `TextDecoder` inside a test (e.g. the fuzz
 * campaign's `unpad` target) therefore crashes the whole suite. Force each
 * lazy require to run now — during setup, an allowed scope — so the first
 * in-test access is a cached hit. Referencing the property fires the Proxy
 * get; instantiating the class-likes is belt-and-suspenders.
 */
/* eslint-disable no-unused-expressions */
try {
  new globalThis.TextEncoder();
  new globalThis.TextDecoder();
  globalThis.URL;
  globalThis.atob;
  globalThis.btoa;
  globalThis.structuredClone;
} catch {
  // A missing global here is not fatal — the point is only to trigger the
  // lazy install for the ones that exist; parsers guard their own usage.
}
