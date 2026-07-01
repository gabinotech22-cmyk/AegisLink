/**
 * Contacts store — message-request (pending) regression tests
 *
 * An unknown incoming sender must NOT land directly in a normal thread. They are
 * auto-added as a PENDING message request; the user then accepts/blocks/deletes.
 * Verifies:
 *   1. addByAegisId(..., { pending: true }) stores the contact as pending.
 *   2. A normal (user-initiated) add stores the contact as NOT pending.
 *   3. acceptContact() clears the pending flag.
 *   4. A user-initiated add of an already-pending contact implicitly accepts it.
 */

const mockSaveContact = jest.fn().mockResolvedValue(undefined);
let mockExisting: Record<string, unknown> | null = null;

jest.mock('../../db/local', () => ({
  loadContacts: jest.fn().mockResolvedValue([]),
  saveContact: (c: unknown) => mockSaveContact(c),
  getContact: jest.fn(async () => mockExisting),
  deleteContact: jest.fn().mockResolvedValue(undefined),
  deleteContactMessages: jest.fn().mockResolvedValue(undefined),
  deleteContactRatchetSession: jest.fn().mockResolvedValue(undefined),
  pinContact: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../api', () => ({
  lookupIdentity: jest.fn(async (aegisId: string) => ({
    aegisId,
    publicKey: 'PUBKEY_B64',
    signingPublicKey: 'SIGN_B64',
  })),
  ApiError: class ApiError extends Error {},
}));

jest.mock('../../crypto/aegisId', () => ({ keyMatchesAegisId: () => true }));

import { useContacts } from '../contacts';

const ID = 'AAA-BBBB-CCCC';

describe('contacts store — pending message requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExisting = null;
    useContacts.setState({ contacts: [] });
  });

  it('marks an unknown incoming sender as pending', async () => {
    const contact = await useContacts.getState().addByAegisId(ID, undefined, { pending: true });
    expect(contact.pending).toBe(true);
    expect(mockSaveContact).toHaveBeenCalledWith(expect.objectContaining({ aegisId: ID, pending: true }));
  });

  it('marks a user-initiated add as NOT pending', async () => {
    const contact = await useContacts.getState().addByAegisId(ID, 'Alice');
    expect(contact.pending).toBe(false);
    expect(mockSaveContact).toHaveBeenCalledWith(expect.objectContaining({ pending: false }));
  });

  it('acceptContact clears the pending flag', async () => {
    mockExisting = { aegisId: ID, publicKeyB64: 'PUBKEY_B64', name: 'x', verified: false, addedAt: 1, pending: true };
    useContacts.setState({ contacts: [mockExisting as never] });
    await useContacts.getState().acceptContact(ID);
    expect(mockSaveContact).toHaveBeenCalledWith(expect.objectContaining({ aegisId: ID, pending: false }));
    expect(useContacts.getState().contacts[0].pending).toBe(false);
  });

  it('implicitly accepts a pending contact when the user adds them', async () => {
    mockExisting = { aegisId: ID, publicKeyB64: 'PUBKEY_B64', name: 'x', verified: false, addedAt: 1, pending: true };
    const contact = await useContacts.getState().addByAegisId(ID, 'Alice');
    expect(contact.pending).toBe(false);
    expect(mockSaveContact).toHaveBeenCalledWith(expect.objectContaining({ pending: false }));
  });
});
