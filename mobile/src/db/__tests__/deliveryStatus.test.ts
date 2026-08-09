/**
 * Delivery-status transitions — regression tests.
 *
 * WHY THESE EXIST
 * ---------------
 * The status model used to be 'sent' | 'delivered' | 'read', with the DB column
 * defaulting to 'sent'. It could not represent a message that never left the
 * device, so a job stuck in the outbox rendered a tick exactly like a delivered
 * one — the UI lied. 'pending' and 'failed' close that hole.
 *
 * Adding states creates a second hazard: delivery signals RACE. A `delivered`
 * receipt from the peer can land before our own relay ack resolves, and a slow
 * outbox drain can settle after the peer already read the message. Applying
 * those in arrival order would flip two ticks back to one. nextDeliveryStatus is
 * the single rule both the DB and the in-memory store apply, so they can never
 * disagree about what a bubble should show.
 */

// db/messages pulls in ./core (expo-sqlite + secure store) at import time even
// though nextDeliveryStatus itself is pure — stub the native layer.
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  SQLiteDatabase: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  AFTER_FIRST_UNLOCK: 'after_first_unlock',
}));

import { nextDeliveryStatus } from '../messages';
import type { DeliveryStatus } from '../messages';

const FORWARD: DeliveryStatus[] = ['pending', 'sent', 'delivered', 'read'];

describe('nextDeliveryStatus — the happy path advances', () => {
  it('walks pending → sent → delivered → read', () => {
    expect(nextDeliveryStatus('pending', 'sent')).toBe('sent');
    expect(nextDeliveryStatus('sent', 'delivered')).toBe('delivered');
    expect(nextDeliveryStatus('delivered', 'read')).toBe('read');
  });

  it('allows skipping a step when a later signal arrives first', () => {
    expect(nextDeliveryStatus('pending', 'delivered')).toBe('delivered');
    expect(nextDeliveryStatus('pending', 'read')).toBe('read');
    expect(nextDeliveryStatus('sent', 'read')).toBe('read');
  });
});

describe('nextDeliveryStatus — never moves backwards', () => {
  it('ignores a stale signal for every backwards pair', () => {
    for (let i = 0; i < FORWARD.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(nextDeliveryStatus(FORWARD[i], FORWARD[j])).toBe(FORWARD[i]);
      }
    }
  });

  it('keeps two ticks when a late relay ack resolves after the read receipt', () => {
    // The exact race: outbox drain settles to `sent` after the peer read it.
    expect(nextDeliveryStatus('read', 'sent')).toBe('read');
    expect(nextDeliveryStatus('delivered', 'sent')).toBe('delivered');
  });

  it('is idempotent', () => {
    for (const s of [...FORWARD, 'failed' as const]) {
      expect(nextDeliveryStatus(s, s)).toBe(s);
    }
  });
});

describe('nextDeliveryStatus — failure is bounded', () => {
  it('can only fail a message that is still in flight', () => {
    expect(nextDeliveryStatus('pending', 'failed')).toBe('failed');
    expect(nextDeliveryStatus('sent', 'failed')).toBe('failed');
  });

  it('never marks an already-delivered or read message as failed', () => {
    // A message the peer demonstrably received must not turn red because our
    // own outbox bookkeeping expired late.
    expect(nextDeliveryStatus('delivered', 'failed')).toBe('delivered');
    expect(nextDeliveryStatus('read', 'failed')).toBe('read');
  });

  it('lets a manual retry — and ONLY a retry — lift a failed message', () => {
    // The retry path sets `pending` explicitly, so that is the one door in.
    expect(nextDeliveryStatus('failed', 'pending')).toBe('pending');
  });

  it('keeps a failed message failed when a late sibling succeeds', () => {
    // Groups make this concrete: a message is failed as soon as ONE member's
    // job expires, while other members' jobs may still be resolving. A late
    // `sent` must not quietly tell the user it went through after we already
    // told them it did not.
    expect(nextDeliveryStatus('failed', 'sent')).toBe('failed');
    expect(nextDeliveryStatus('failed', 'delivered')).toBe('failed');
    expect(nextDeliveryStatus('failed', 'read')).toBe('failed');
  });

  it('resumes normally once a retry has put it back in flight', () => {
    const afterRetry = nextDeliveryStatus('failed', 'pending');
    expect(nextDeliveryStatus(afterRetry, 'sent')).toBe('sent');
    expect(nextDeliveryStatus('sent', 'delivered')).toBe('delivered');
  });
});
