/**
 * Ratchet session persistence.
 *
 * Since F-1b phase 3 a session is persisted as its vault-sealed state plus
 * non-secret metadata (format v3, below). Sessions saved before that are JSON
 * with the raw keys (RK/CKs/CKr/DHr/DHs/MKSKIPPED/PQ*); they are imported into
 * the vault ONCE when first loaded (design doc section 4) and re-saved as v3
 * by the caller's next save.
 *
 * Revival of those legacy raw fields: they come back as one of several shapes
 * depending on how they were serialized: a Buffer JSON object ({type:'Buffer',data:[...]}), a plain
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

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import type { RatchetState, RatchetInfo } from '../crypto/signal/ratchet';
import { vault, encodeRatchetState, type SkippedKey } from '../crypto/sodium/vault';

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

/** Persisted format of a vault-sealed session. */
const FORMAT = 3;

interface PersistedV3 {
  v: 3;
  slot: string;
  sealed: string;
  info: { Ns: number; Nr: number; PN: number; hybrid: boolean; hasCKs: boolean; hasCKr: boolean; dhs: string; dhr: string | null };
  x3dhInit?: RatchetState['x3dhInit'];
  createdAtMs?: number;
}

/** Serialize a session for persistence: the sealed state and its non-secret metadata. */
export function serializeRatchetState(state: RatchetState): string {
  const i = state.info;
  const out: PersistedV3 = {
    v: FORMAT,
    slot: state.slot,
    sealed: encodeBase64(state.sealed),
    info: {
      Ns: i.Ns,
      Nr: i.Nr,
      PN: i.PN,
      hybrid: i.hybrid,
      hasCKs: i.hasCKs,
      hasCKr: i.hasCKr,
      dhs: encodeBase64(i.dhsPublicKey),
      dhr: i.dhr ? encodeBase64(i.dhr) : null,
    },
    x3dhInit: state.x3dhInit,
    createdAtMs: state.createdAtMs,
  };
  return JSON.stringify(out);
}

/**
 * Parse a persisted session of profile `slot`. A v3 session must be sealed to
 * that profile (the vault refuses it otherwise on its next step, too); a
 * legacy one is imported into the vault now, and the caller's next save
 * persists it as v3.
 */
export function reviveRatchetState(json: string, slot: string): RatchetState {
  const s = JSON.parse(json);
  if (s && s.v === FORMAT) {
    const p = s as PersistedV3;
    if (p.slot !== slot) throw new Error('ratchetSerde: session of another profile');
    const info: RatchetInfo = {
      Ns: p.info.Ns,
      Nr: p.info.Nr,
      PN: p.info.PN,
      hybrid: p.info.hybrid,
      hasCKs: p.info.hasCKs,
      hasCKr: p.info.hasCKr,
      dhsPublicKey: decodeBase64(p.info.dhs),
      dhr: p.info.dhr ? decodeBase64(p.info.dhr) : null,
    };
    return { slot, sealed: decodeBase64(p.sealed), info, x3dhInit: p.x3dhInit, createdAtMs: p.createdAtMs };
  }
  return importLegacyRatchetState(s, slot);
}

/** Parse a legacy MKSKIPPED key `${base64(pub)}:${n}`. */
function parseSkippedKey(k: string): { pub: Uint8Array; n: number } | null {
  const idx = k.lastIndexOf(':');
  if (idx < 0) return null;
  const n = Number(k.slice(idx + 1));
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  try {
    const pub = decodeBase64(k.slice(0, idx));
    return pub.length === 32 ? { pub, n } : null;
  } catch {
    return null;
  }
}

/**
 * The one-time migration of a session saved before F-1b phase 3 (raw keys in
 * JSON) into the vault. The raw copies are zeroed; a state that is not
 * well-formed throws (fail closed: the session is re-keyed, never guessed).
 */
function importLegacyRatchetState(s: Record<string, unknown>, slot: string): RatchetState {
  const need = (b: Uint8Array | null, len: number, what: string): Uint8Array => {
    if (!b || b.length !== len) throw new Error(`ratchetSerde: legacy session: bad ${what}`);
    return b;
  };
  const opt = (b: Uint8Array | null, len: number, what: string): Uint8Array | null => (b ? need(b, len, what) : null);
  const counter = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`ratchetSerde: legacy session: bad ${what}`);
    return v;
  };
  const dhs = s.DHs as { publicKey?: unknown; secretKey?: unknown } | undefined;
  const pqs = s.PQs as { publicKey?: unknown; secretKey?: unknown } | null | undefined;
  const skipped: SkippedKey[] = [];
  for (const [k, mk] of reviveMkSkipped(s.MKSKIPPED)) {
    const parsed = parseSkippedKey(k);
    if (parsed && mk.length === 32) skipped.push({ ...parsed, mk });
  }
  // The vault keeps the MAX_SKIPPED_KEYS highest-n keys; hand it at most that
  // many (the lowest n go first, oldest first among equals, as before).
  const keep = skipped
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.n - b.e.n || a.i - b.i)
    .slice(Math.max(0, skipped.length - 50))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.e);
  const raw = {
    DHs: {
      publicKey: need(reviveBytes(dhs?.publicKey), 32, 'DHs.publicKey'),
      secretKey: need(reviveBytes(dhs?.secretKey), 32, 'DHs.secretKey'),
    },
    DHr: opt(reviveBytes(s.DHr), 32, 'DHr'),
    RK: need(reviveBytes(s.RK), 32, 'RK'),
    PQs: pqs
      ? {
          publicKey: need(reviveBytes(pqs.publicKey), 1184, 'PQs.publicKey'),
          secretKey: need(reviveBytes(pqs.secretKey), 2400, 'PQs.secretKey'),
        }
      : null,
    PQr: opt(reviveBytes(s.PQr), 1184, 'PQr'),
    pqSendCt: opt(reviveBytes(s.pqSendCt), 1088, 'pqSendCt'),
    CKs: opt(reviveBytes(s.CKs), 32, 'CKs'),
    CKr: opt(reviveBytes(s.CKr), 32, 'CKr'),
    Ns: counter(s.Ns, 'Ns'),
    Nr: counter(s.Nr, 'Nr'),
    PN: counter(s.PN, 'PN'),
    skipped: keep,
  };
  let encoded: Uint8Array;
  try {
    encoded = encodeRatchetState(raw);
  } finally {
    raw.DHs.secretKey.fill(0);
    raw.RK.fill(0);
    raw.CKs?.fill(0);
    raw.CKr?.fill(0);
    raw.PQs?.secretKey.fill(0);
    for (const e of skipped) e.mk.fill(0);
  }
  const { sealed, info } = vault.ratchetImport(slot, encoded);
  return {
    slot,
    sealed,
    info,
    x3dhInit: s.x3dhInit as RatchetState['x3dhInit'],
    createdAtMs: typeof s.createdAtMs === 'number' ? s.createdAtMs : undefined,
  };
}
