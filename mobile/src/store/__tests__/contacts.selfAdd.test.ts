/**
 * Contacts store — never add the local identity as its own contact
 *
 * Root cause of a real bug: a buggy/adversarial group could claim the local
 * user's own aegisId as a group admin/member id, and the group-metadata
 * resolver in socket/client.ts would call addByAegisId()/addFromQR() for that
 * claimed id with no self-check — silently creating a "contact" row for
 * yourself that then showed up in the Home chat list as "No messages yet".
 *
 * This suite verifies the store-level guard (isSelfAegisId in contacts.ts)
 * rejects both addByAegisId() and addFromQR() when the target aegisId
 * matches the local identity's aegisId, including case/whitespace variants
 * (normalizeAegisId compares uppercased+trimmed).
 */

const mockSaveContact = jest.fn().mockResolvedValue(undefined);
let mockExisting: Record<string, unknown> | null = null;
let mockSelfAegisId: string | null = 'SELF-AAAA-BBBB';

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

jest.mock('../../crypto/aegisId', () => {
  const actual = jest.requireActual('../../crypto/aegisId');
  return {
    ...actual,
    keyMatchesAegisId: () => true,
  };
});

jest.mock('../identity', () => ({
  useIdentity: { getState: () => ({ identity: mockSelfAegisId ? { aegisId: mockSelfAegisId } : null }) },
}));

import { useContacts } from '../contacts';

const OTHER_ID = 'AAA-BBBB-CCCC';

describe('contacts store — never self-add', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExisting = null;
    mockSelfAegisId = 'SELF-AAAA-BBBB';
    useContacts.setState({ contacts: [] });
  });

  it('addByAegisId rejects the local identity aegisId', async () => {
    await expect(useContacts.getState().addByAegisId(mockSelfAegisId as string)).rejects.toThrow(
      'Cannot add your own Aegis ID as a contact.'
    );
    expect(mockSaveContact).not.toHaveBeenCalled();
  });

  it('addByAegisId rejects a case/whitespace variant of the local identity aegisId', async () => {
    const variant = `  ${(mockSelfAegisId as string).toLowerCase()}  `;
    await expect(useContacts.getState().addByAegisId(variant)).rejects.toThrow(
      'Cannot add your own Aegis ID as a contact.'
    );
    expect(mockSaveContact).not.toHaveBeenCalled();
  });

  it('addByAegisId still works normally for a non-self aegisId', async () => {
    const contact = await useContacts.getState().addByAegisId(OTHER_ID, 'Alice');
    expect(contact.aegisId).toBe(OTHER_ID);
    expect(mockSaveContact).toHaveBeenCalledWith(expect.objectContaining({ aegisId: OTHER_ID }));
  });

  it('addFromQR rejects the local identity aegisId', async () => {
    await expect(
      useContacts.getState().addFromQR(mockSelfAegisId as string, 'PUBKEY_B64', 'Me')
    ).rejects.toThrow('Cannot add your own Aegis ID as a contact.');
    expect(mockSaveContact).not.toHaveBeenCalled();
  });

  it('addFromQR still works normally for a non-self aegisId', async () => {
    const result = await useContacts.getState().addFromQR(OTHER_ID, 'PUBKEY_B64', 'Alice');
    expect(result.kind).toBe('added');
    expect(mockSaveContact).toHaveBeenCalledWith(expect.objectContaining({ aegisId: OTHER_ID }));
  });

  it('does not reject when there is no local identity yet (hydration race)', async () => {
    mockSelfAegisId = null;
    const contact = await useContacts.getState().addByAegisId(OTHER_ID, 'Alice');
    expect(contact.aegisId).toBe(OTHER_ID);
  });
});
