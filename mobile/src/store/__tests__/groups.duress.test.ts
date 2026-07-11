/**
 * Duress containment — groups store (security regression).
 *
 * Found in manual QA: entering the coercion PIN showed the user's REAL groups
 * (the decoy only covered identity/contacts/messages), defeating the decoy.
 * These tests pin the containment contract for the groups store:
 *   1. hydrate() under duress serves an EMPTY list and never reads the DB.
 *   2. persistence helpers under duress never write the real DB.
 */

const mockLoadGroups = jest.fn();
const mockSaveGroup = jest.fn();
const mockDeleteGroup = jest.fn();
const mockDeleteContactMessages = jest.fn();

jest.mock('../../db/local', () => ({
  loadGroups: (...a: unknown[]) => mockLoadGroups(...a),
  saveGroup: (...a: unknown[]) => mockSaveGroup(...a),
  deleteGroup: (...a: unknown[]) => mockDeleteGroup(...a),
  deleteContactMessages: (...a: unknown[]) => mockDeleteContactMessages(...a),
}));

let mockDuressActive = false;
jest.mock('../preferences', () => ({
  usePreferences: { getState: () => ({ duressActive: mockDuressActive }) },
}));

// No identity → signAsAdmin returns null and the metadata broadcast is
// skipped; keeps the mutator test free of crypto/socket machinery.
jest.mock('../identity', () => ({
  useIdentity: { getState: () => ({ identity: null }) },
}));
jest.mock('../../socket/client', () => ({
  broadcastGroupMetadata: jest.fn(),
}));

// SUT after mocks.
import { useGroups } from '../groups';

describe('groups store — duress containment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDuressActive = false;
    useGroups.setState({ groups: [] });
  });

  it('hydrate() under duress serves an empty list WITHOUT reading the real DB', async () => {
    mockDuressActive = true;
    // Seed in-memory state as if real groups were loaded before the duress
    // unlock — hydrate must clear them, not merely skip loading.
    useGroups.setState({
      groups: [{ id: 'g1', name: 'REAL secret group', members: [], admin: 'me' } as never],
    });

    await useGroups.getState().hydrate();

    expect(useGroups.getState().groups).toEqual([]);
    expect(mockLoadGroups).not.toHaveBeenCalled();
  });

  it('hydrate() outside duress loads from the DB as before', async () => {
    const real = [{ id: 'g1', name: 'club', members: [], admin: 'me' }];
    mockLoadGroups.mockResolvedValue(real);

    await useGroups.getState().hydrate();

    expect(mockLoadGroups).toHaveBeenCalledTimes(1);
    expect(useGroups.getState().groups).toEqual(real);
  });

  it('mutators under duress update in-memory state but NEVER write the real DB', async () => {
    mockDuressActive = true;
    useGroups.setState({
      groups: [{ id: 'g1', name: 'old name', members: [], admin: 'me' } as never],
    });

    await useGroups.getState().renameGroup('g1', 'new name');

    // Decoy UI stays coherent (in-memory update applied)…
    expect(useGroups.getState().groups[0]).toMatchObject({ id: 'g1', name: 'new name' });
    // …but the real SQLite DB is untouched.
    expect(mockSaveGroup).not.toHaveBeenCalled();
    expect(mockDeleteGroup).not.toHaveBeenCalled();
    expect(mockDeleteContactMessages).not.toHaveBeenCalled();
  });

  it('the same mutator outside duress persists to the DB', async () => {
    useGroups.setState({
      groups: [{ id: 'g1', name: 'old name', members: [], admin: 'me' } as never],
    });

    await useGroups.getState().renameGroup('g1', 'new name');

    expect(mockSaveGroup).toHaveBeenCalledTimes(1);
  });
});
