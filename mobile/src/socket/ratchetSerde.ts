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
 * Pure module (no expo/socket imports) so it is unit-testable under jest. Twin
 * of desktop/src/renderer/socket/ratchetSerde.ts.
 */

import type { RatchetState } from '../crypto/signal/ratchet';

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

// ─── Whole-state (de)serialization — SINGLE point of truth ───────────────────
//
// Every save/load of a ratchet session MUST go through these two functions.
// Hand-rolled copies have burned us twice: a save whitelist that omitted the
// hybrid PQ fields (PQs/PQr/pqSendCt) silently degraded every reloaded hybrid
// session to classic — the next inbound chain turn derived the root WITHOUT
// the PQ secret (permanent one-way desync), and our own chain turns stopped
// advertising PQ material (rejected by the peer as a downgrade attack).

/** Serialize the minimal next-state of a ratchet session for persistence. */
export function serializeRatchetState(state: RatchetState): string {
  return JSON.stringify({
    RK: state.RK,
    DHs: state.DHs,
    DHr: state.DHr,
    CKs: state.CKs,
    CKr: state.CKr,
    Ns: state.Ns,
    Nr: state.Nr,
    PN: state.PN,
    // Hybrid PQ ratchet (R1) material — REQUIRED for hybrid sessions.
    PQs: state.PQs,
    PQr: state.PQr,
    pqSendCt: state.pqSendCt,
    MKSKIPPED: Array.from(state.MKSKIPPED.entries()),
    x3dhInit: state.x3dhInit,
    createdAtMs: state.createdAtMs,
  });
}

/** Parse persisted JSON back into a live RatchetState (bytes revived). */
export function reviveRatchetState(json: string): RatchetState {
  const s = JSON.parse(json);
  s.RK = reviveBytes(s.RK);
  s.CKs = reviveBytes(s.CKs);
  s.CKr = reviveBytes(s.CKr);
  s.DHr = reviveBytes(s.DHr);
  s.DHs.publicKey = reviveBytes(s.DHs.publicKey);
  s.DHs.secretKey = reviveBytes(s.DHs.secretKey);
  // Hybrid PQ ratchet (R1): PQs/PQr/pqSendCt need the same byte revival as
  // DHs/DHr — without this, a reloaded hybrid session has plain JSON
  // arrays where ml_kem768.decapsulate/encapsulate expect Uint8Array.
  if (s.PQs) {
    s.PQs.publicKey = reviveBytes(s.PQs.publicKey);
    s.PQs.secretKey = reviveBytes(s.PQs.secretKey);
  }
  s.PQr = reviveBytes(s.PQr);
  s.pqSendCt = reviveBytes(s.pqSendCt);
  s.MKSKIPPED = reviveMkSkipped(s.MKSKIPPED);
  return s as RatchetState;
}
