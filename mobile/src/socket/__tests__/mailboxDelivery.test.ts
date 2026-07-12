/**
 * Mailbox delivery-confirmation contract (regression for the silent 1:1 loss bug).
 *
 * Bug: the 1:1 send path treated ANY successful mailbox ack (`ok:true`) as
 * terminal — including a merely-`queued` ack, which the relay returns when the
 * recipient's mailbox socket is OFFLINE. On mobile the recipient's Tor mailbox
 * often never bootstraps, so those queued blobs silently expired undelivered and
 * the reliable aegisId fallback was never taken. Messages vanished with no error.
 *
 * Fix: `mailboxAckConfirmsDelivery` is the single predicate the send path uses to
 * decide whether the mailbox send is terminal. It confirms delivery ONLY on
 * `delivered:true` (recipient mailbox was LIVE). Everything else — `queued`,
 * `ok` without `delivered`, `!ok`, `null` — is unconfirmed and MUST fall through
 * to the aegisId transport. This pins that truth table so a future edit can't
 * regress to trusting a bare `ok` again.
 */

// Stub the heavy/native deps mailboxSocket.ts pulls at import time so this pure
// predicate can be exercised without the embedded-Tor bridge or SecureStore.
jest.mock('../../net/tor', () => ({
  __esModule: true,
  isTorAvailable: () => false,
  startTor: jest.fn(),
  TorSioSocket: function () { /* unused */ },
}));
jest.mock('../../config', () => ({ __esModule: true, ONION_URL: '', MAILBOX_ENABLED: false }));
jest.mock('../../crypto/mailboxStore', () => ({
  __esModule: true,
  getOwnCurrentMailbox: jest.fn(),
  getOwnMailboxesForEpochs: jest.fn(),
  getLastMailboxConnectEpoch: jest.fn(),
  setLastMailboxConnectEpoch: jest.fn(),
}));

import { mailboxAckConfirmsDelivery, type EnvelopeAck } from '../mailboxSocket';

describe('mailboxAckConfirmsDelivery', () => {
  it('confirms delivery ONLY when the relay reports delivered:true (recipient live)', () => {
    expect(mailboxAckConfirmsDelivery({ ok: true, delivered: true })).toBe(true);
  });

  it('does NOT confirm a merely-queued ack — recipient mailbox offline, may never drain', () => {
    // This is the exact ack that caused the silent loss: relay accepted + stored,
    // recipient never came online to drain it.
    expect(mailboxAckConfirmsDelivery({ ok: true, delivered: false, queued: true })).toBe(false);
  });

  it('does NOT confirm a bare ok:true without a delivered flag (the reverted-bug shape)', () => {
    expect(mailboxAckConfirmsDelivery({ ok: true })).toBe(false);
  });

  it('does NOT confirm an explicit failure ack', () => {
    expect(mailboxAckConfirmsDelivery({ ok: false, error: 'rate_limited' })).toBe(false);
  });

  it('does NOT confirm a null/undefined ack (socket not authed / timed out)', () => {
    expect(mailboxAckConfirmsDelivery(null)).toBe(false);
    expect(mailboxAckConfirmsDelivery(undefined)).toBe(false);
  });

  it('treats delivered:true as terminal even if queued is also somehow set', () => {
    // Defensive: delivered wins — a live forward is a real delivery.
    const ack: EnvelopeAck = { ok: true, delivered: true, queued: true };
    expect(mailboxAckConfirmsDelivery(ack)).toBe(true);
  });
});
