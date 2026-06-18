/**
 * GroupAdminScreen — invite QR code
 *
 * Verifies:
 *  1. Renders without crashing for the group admin.
 *  2. Shows a QRCode with the universal group invite link as its value
 *     (https form, payload in the fragment — zero metadata to the server).
 *  3. Does NOT render the invite section (and therefore no QR) for a
 *     non-admin member.
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { encodeGroupInviteLinkUniversal } from '../../crypto/qr';
import type { StoredGroup } from '../../db/local';

// ── safe-area-context ──────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-i18next ──────────────────────────────────────────────────────────
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown> | string) => (typeof opts === 'string' ? opts : k) }),
}));

// ── ThemeContext ───────────────────────────────────────────────────────────
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000',
      surface: '#111',
      surface2: '#222',
      surface3: '#333',
      text: '#fff',
      textDim: '#aaa',
      textFaint: '#666',
      accent: '#05b875',
      accentDeep: '#0a2e1e',
      accentInk: '#000',
      danger: '#e63946',
      warn: '#f59e0b',
      border: '#222',
      borderStrong: '#333',
      divider: '#1a1a1a',
      bubbleIn: '#222',
      bubbleInText: '#fff',
      bubbleOut: '#05b875',
      bubbleOutText: '#000',
      radius: 12,
      radiusS: 8,
      radiusL: 20,
      font: 'System',
      fontMono: 'monospace',
      fontDisplay: 'System',
      dark: true,
    },
  }),
}));

// ── icons ──────────────────────────────────────────────────────────────────
jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

// ── TopBar ─────────────────────────────────────────────────────────────────
jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title, left }: { title: string; left?: import('react').ReactNode }) => {
    const React = require('react') as typeof import('react');
    const { View, Text } = require('react-native') as typeof import('react-native');
    return React.createElement(View, null, left, React.createElement(Text, null, title));
  },
}));

// ── QRCode — render-spy mock, exposes the `value` prop for assertions ──────
jest.mock('react-native-qrcode-svg', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => {
    const React = require('react') as typeof import('react');
    const { Text } = require('react-native') as typeof import('react-native');
    return React.createElement(Text, { testID: 'group-invite-qr' }, value);
  },
}));

// ── AvatarCropModal / ContactPickerSheet — render nothing, just need to mount
jest.mock('../../components/AvatarCropModal', () => ({
  AvatarCropModal: () => null,
}));
jest.mock('../../components/ContactPickerSheet', () => ({
  ContactPickerSheet: () => null,
}));
jest.mock('../../components/Avatar', () => ({
  Avatar: () => null,
}));

// ── stores ───────────────────────────────────────────────────────────────
const GROUP_ID = 'g-123';
const GROUP_NAME = 'Equipo Privado';
const ADMIN_ID = 'ADM-1111-2222-3333';

const mockBaseGroup: StoredGroup = {
  id: GROUP_ID,
  name: GROUP_NAME,
  members: [ADMIN_ID, 'BBB-4444-5555-6666'],
  createdAt: Date.now(),
  adminId: ADMIN_ID,
  adminOnlyInvite: true,
};

jest.mock('../../store/groups', () => ({
  useGroups: jest.fn((sel?: (s: unknown) => unknown) => {
    const state = {
      groups: [mockBaseGroup],
      renameGroup: jest.fn(),
      updateGroupAvatar: jest.fn(),
      addMember: jest.fn(),
      removeMember: jest.fn(),
      leaveGroup: jest.fn(),
    };
    return sel ? sel(state) : state;
  }),
}));

jest.mock('../../store/contacts', () => ({
  useContacts: jest.fn((sel: (s: unknown) => unknown) => sel({ contacts: [] })),
}));

jest.mock('../../store/identity', () => ({
  useIdentity: jest.fn((sel: (s: unknown) => unknown) =>
    sel({ identity: { aegisId: ADMIN_ID }, avatarImage: undefined, avatarColor: '#05b875' })
  ),
}));

// ── Subject under test (imported AFTER all mocks) ──────────────────────────
import { GroupAdminScreen } from '../GroupAdmin';
import { useIdentity } from '../../store/identity';

describe('GroupAdminScreen — invite QR', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useIdentity as unknown as jest.Mock).mockImplementation((sel: (s: unknown) => unknown) =>
      sel({ identity: { aegisId: ADMIN_ID }, avatarImage: undefined, avatarColor: '#05b875' })
    );
  });

  it('renders without crashing for the group admin', () => {
    const { toJSON } = render(<GroupAdminScreen group={mockBaseGroup} onBack={jest.fn()} />);
    expect(toJSON()).toBeTruthy();
  });

  it('shows a QR code with the universal group invite link as its value', () => {
    const { getByTestId } = render(<GroupAdminScreen group={mockBaseGroup} onBack={jest.fn()} />);
    const expected = encodeGroupInviteLinkUniversal(GROUP_ID, GROUP_NAME, ADMIN_ID);
    expect(getByTestId('group-invite-qr').props.children).toBe(expected);
  });

  it('does NOT render the invite QR for a non-admin member', () => {
    (useIdentity as unknown as jest.Mock).mockImplementation((sel: (s: unknown) => unknown) =>
      sel({ identity: { aegisId: 'BBB-4444-5555-6666' }, avatarImage: undefined, avatarColor: '#05b875' })
    );
    const { queryByTestId } = render(<GroupAdminScreen group={mockBaseGroup} onBack={jest.fn()} />);
    expect(queryByTestId('group-invite-qr')).toBeNull();
  });
});
