import type { Socket } from 'socket.io';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { prekeysRepo, identityRepo } from '../../db/client.js';
import { PreKeyUpload, PreKeyFetch, type PreKeyBundle } from '../schemas.js';

const { decodeBase64 } = naclUtil;

export interface PrekeysDeps {
  me: string;
  deviceId: string | undefined;
}

export function attachPrekeys(socket: Socket, { me, deviceId }: PrekeysDeps): void {
  socket.on('prekeys:upload', (raw, ack?: (res: { ok: boolean; error?: string }) => void) => {
    const parsed = PreKeyUpload.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: 'invalid_payload' });
      return;
    }

    // Verify SPK signature server-side — defence in depth against DB tampering.
    // identityRepo.get is async so the entire upload flow runs inside the promise chain.
    void identityRepo.get(me).then(async (uploaderIdentity) => {
      if (uploaderIdentity?.signing_public_key_b64) {
        const spkBytes = decodeBase64(parsed.data.signedPreKey.publicKeyB64);
        const sigBytes = decodeBase64(parsed.data.signedPreKey.signatureB64);
        const signingKey = decodeBase64(uploaderIdentity.signing_public_key_b64);
        if (!nacl.sign.detached.verify(spkBytes, sigBytes, signingKey)) {
          ack?.({ ok: false, error: 'invalid_spk_signature' });
          return;
        }

        // PQXDH (v2): verify the Ed25519 signature over the PQ signed prekey the
        // SAME way as the classic SPK above — defence in depth. The relay never
        // inspects the ML-KEM public key itself beyond this signature check; it
        // is stored and served as an opaque blob. Optional field: absent ⇒ this
        // upload stays v1-only, no rejection.
        if (parsed.data.pqSignedPreKey) {
          const pqBytes = decodeBase64(parsed.data.pqSignedPreKey.publicKeyB64);
          const pqSigBytes = decodeBase64(parsed.data.pqSignedPreKey.signatureB64);
          if (!nacl.sign.detached.verify(pqBytes, pqSigBytes, signingKey)) {
            ack?.({ ok: false, error: 'invalid_pq_spk_signature' });
            return;
          }
        }
      }
      const now = Date.now();
      await prekeysRepo.upsertSigned({
        aegis_id: me,
        device_id: parsed.data.deviceId ?? deviceId ?? 'default',
        key_id: parsed.data.signedPreKey.keyId,
        public_key_b64: parsed.data.signedPreKey.publicKeyB64,
        signature_b64: parsed.data.signedPreKey.signatureB64,
        created_at: now,
      });
      if (parsed.data.pqSignedPreKey) {
        await prekeysRepo.upsertPqSigned({
          aegis_id: me,
          device_id: parsed.data.deviceId ?? deviceId ?? 'default',
          key_id: parsed.data.pqSignedPreKey.keyId,
          public_key_b64: parsed.data.pqSignedPreKey.publicKeyB64,
          signature_b64: parsed.data.pqSignedPreKey.signatureB64,
          created_at: now,
        });
      }
      for (const opk of parsed.data.oneTimePreKeys) {
        await prekeysRepo.insertOneTime({
          aegis_id: me,
          device_id: parsed.data.deviceId ?? deviceId ?? 'default', // M-2: per-device OPK
          key_id: opk.keyId,
          public_key_b64: opk.publicKeyB64,
          created_at: now,
        });
      }
      ack?.({ ok: true });
    }).catch(() => {
      ack?.({ ok: false, error: 'db_error' });
    });
  });

  socket.on('prekeys:fetch', (raw, ack?: (res: { ok: boolean; bundle?: PreKeyBundle; error?: string }) => void) => {
    const parsed = PreKeyFetch.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: 'invalid_payload' });
      return;
    }
    prekeysRepo.getBundle(parsed.data.aegisId).then((bundle) => {
      if (!bundle) {
        ack?.({ ok: false, error: 'not_found' });
        return;
      }
      ack?.({ ok: true, bundle });
    }).catch(() => {
      ack?.({ ok: false, error: 'db_error' });
    });
  });
}
