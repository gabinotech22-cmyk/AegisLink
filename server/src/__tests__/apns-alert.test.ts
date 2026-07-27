/**
 * apns-alert.test.ts — direct-APNs message wake sender (push/apns-alert.ts).
 *
 * The provider-token / ES256 path is shared with (and tested by) apns-voip; here
 * we lock the one piece unique to the alert sender: the payload is a GENERIC,
 * ZERO-METADATA visible alert — no sender, recipient, count, or content (privacy
 * golden rule #2). A regression that leaked an identity into the banner would be
 * a metadata leak that APNs (and anyone watching the device) could read.
 */
import { buildAlertPayload } from '../push/apns-alert.js';

describe('apns-alert payload (zero-metadata)', () => {
  it('is a generic visible alert — no sender/recipient/content fields', () => {
    const raw = buildAlertPayload();
    const payload = JSON.parse(raw) as {
      aps?: { alert?: { title?: string; body?: string }; sound?: string };
    };

    // Exactly the generic, non-identifying banner.
    expect(payload.aps?.alert?.title).toBe('AegisLink');
    expect(payload.aps?.alert?.body).toBe('Nuevo mensaje cifrado · E2EE');
    expect(payload.aps?.sound).toBe('default');

    // No identity/content field anywhere at the top level.
    for (const forbidden of ['from', 'fromAegisId', 'sender', 'to', 'aegisId', 'name', 'handle', 'ciphertext', 'text']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it('is stable across calls — carries no per-message metadata (id/time/count)', () => {
    // Two calls must be byte-identical: any embedded timestamp, counter, or id
    // would be metadata the relay must never put on the wire.
    expect(buildAlertPayload()).toBe(buildAlertPayload());
  });
});
