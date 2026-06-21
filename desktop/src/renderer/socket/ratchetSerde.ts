/**
 * Ratchet state JSON revival.
 *
 * Ratchet sessions are persisted as JSON, so the raw key fields (RK/CKs/CKr/
 * DHr/DHs/MKSKIPPED) come back as one of several shapes depending on how they
 * were serialized: a Buffer JSON object ({type:'Buffer',data:[...]}), a plain
 * number array, or a number-keyed object of byte values. We must reconstruct
 * the EXACT bytes — getting this wrong silently corrupts the ratchet and every
 * subsequent message fails to decrypt — while refusing anything that is not a
 * recognized byte shape (return null rather than fabricating bytes).
 *
 * We deliberately avoid `instanceof Object` as a catch-all (that fires for any
 * object, including MKSKIPPED whose values may already be plain objects). Only
 * Buffer-shaped objects, pure number arrays, and pure number-keyed objects of
 * byte values are converted to Uint8Array.
 *
 * Pure module (no Electron/window.aegis/socket imports) so it is unit-testable
 * in the plain-Node vitest environment. Twin of mobile/src/socket/ratchetSerde.ts.
 */

export function isBufferShape(o: unknown): o is { type: 'Buffer'; data: number[] } {
  return (
    typeof o === 'object' &&
    o !== null &&
    (o as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((o as { data?: unknown }).data) &&
    (o as { data: unknown[] }).data.every((x) => typeof x === 'number')
  );
}

export function isNumberArray(o: unknown): o is number[] {
  return Array.isArray(o) && o.every((x) => typeof x === 'number');
}

export function isByteIndexedObject(o: unknown): o is Record<string, number> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  const keys = Object.keys(o as object);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (!/^\d+$/.test(k)) return false;
    const v = (o as Record<string, unknown>)[k];
    if (typeof v !== 'number' || v < 0 || v > 255) return false;
  }
  return true;
}

export function reviveBytes(o: unknown): Uint8Array | null {
  if (o === null || o === undefined) return null;
  if (o instanceof Uint8Array) return o;
  if (isBufferShape(o)) return new Uint8Array(o.data);
  if (isNumberArray(o)) return new Uint8Array(o);
  if (isByteIndexedObject(o)) {
    const keys = Object.keys(o)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b);
    const out = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) out[i] = o[String(keys[i])];
    return out;
  }
  return null;
}

export function reviveMkSkipped(raw: unknown): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [k, v] = entry as [unknown, unknown];
    if (typeof k !== 'string') continue;
    const bytes = reviveBytes(v);
    if (bytes) out.set(k, bytes);
  }
  return out;
}
