/**
 * db/groups — regression test for iOS audit finding #6: avatar_image must
 * be persisted as a container-independent relative pointer (never an
 * absolute file:// URI), and re-resolved to an absolute URI against the
 * CURRENT container on read (round-trip + hot-migration of stale rows).
 *
 * Mirrors the jest.resetModules() + requireLocal() pattern from
 * saveGroup.test.ts so each test gets a clean db/local module instance.
 */

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  SQLiteDatabase: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/',
  cacheDirectory: 'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Library/Caches/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  copyAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(mockFixedKeyB64),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

function makeMockDb() {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    withTransactionAsync: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

import type { StoredGroup } from '../local';

function makeGroup(overrides: Partial<StoredGroup> = {}): StoredGroup {
  return {
    id: 'group-abc-001',
    name: 'Secret Ops',
    members: ['alice-001', 'bob-002'],
    createdAt: 1_700_000_000_000,
    avatarColor: '#00FF88',
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as {
    ss: { get: jest.Mock; set: jest.Mock; delete: jest.Mock };
  };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

function requireLocal() {
  return require('../local') as typeof import('../local');
}

describe('db/groups avatar_image container-independent persistence', () => {
  it('persists a relative "doc:" pointer, never the absolute file:// URI', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { saveGroup } = requireLocal();
    const absoluteAvatar =
      'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/avatars/group_group-abc-001_avatar.jpg';

    await saveGroup(makeGroup({ avatarImage: absoluteAvatar }));

    const insertCall = (mockDb.runAsync.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT OR REPLACE INTO groups'),
    );
    expect(insertCall).toBeDefined();
    // Columns: id, name, members, created_at, avatar_color, avatar_image, ...
    const avatarImageArg = insertCall![6];
    expect(avatarImageArg).toBe('doc:avatars/group_group-abc-001_avatar.jpg');
  });

  it('resolves a stored relative pointer to an absolute URI on read', async () => {
    const mockDb = makeMockDb();
    mockDb.getAllAsync.mockResolvedValue([
      {
        id: 'group-abc-001',
        name: 'Secret Ops',
        members: JSON.stringify(['alice-001']),
        created_at: 1_700_000_000_000,
        avatar_color: '#00FF88',
        avatar_image: 'doc:avatars/group_group-abc-001_avatar.jpg',
        admin_only_invite: 1,
        moderate_new_members: 0,
        admin_id: null,
        admin_sig: null,
        moderators: null,
        roster_version: null,
        permissions: null,
        gov_sig: null,
        gov_version: null,
        pending: null,
      },
    ]);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { loadGroups } = requireLocal();
    const groups = await loadGroups();

    expect(groups[0].avatarImage).toBe(
      'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/avatars/group_group-abc-001_avatar.jpg',
    );
  });

  it('hot-migrates a stale absolute URI from a different container UUID on read', async () => {
    const mockDb = makeMockDb();
    mockDb.getAllAsync.mockResolvedValue([
      {
        id: 'group-abc-001',
        name: 'Secret Ops',
        members: JSON.stringify(['alice-001']),
        created_at: 1_700_000_000_000,
        avatar_color: '#00FF88',
        // Absolute URI from a PREVIOUS build/reinstall (different container UUID).
        avatar_image:
          'file:///var/mobile/Containers/Data/Application/OLD-UUID-BEFORE-REINSTALL/Documents/avatars/group_group-abc-001_avatar.jpg',
        admin_only_invite: 1,
        moderate_new_members: 0,
        admin_id: null,
        admin_sig: null,
        moderators: null,
        roster_version: null,
        permissions: null,
        gov_sig: null,
        gov_version: null,
        pending: null,
      },
    ]);
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { loadGroups } = requireLocal();
    const groups = await loadGroups();

    // Re-resolved against the CURRENT container, not the stale one.
    expect(groups[0].avatarImage).toBe(
      'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/avatars/group_group-abc-001_avatar.jpg',
    );
  });
});
