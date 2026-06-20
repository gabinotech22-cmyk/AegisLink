/**
 * GroupPostsScreen — unit tests (B-4: critical screens without coverage)
 *
 * Verifies the admin-only scheduled-announcement flows:
 *  1.  Renders title, group context and the owner role label
 *  2.  Compose → typing content and scheduling calls scheduleGroupPost('pending')
 *  3.  "Save as draft" schedules with status 'draft'
 *  4.  Queue tab lists scheduled posts and deleting is confirm-gated → cancelScheduled
 *  5.  Poll composer rejects an empty question
 */

import React from 'react';

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
import { themedAlert } from '../../components/AlertHost';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// i18n: honour string fallback so labels are deterministic
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fb?: unknown, opts?: { n?: number }) => {
      let s = typeof fb === 'string' ? fb : k;
      if (opts && opts.n != null) s = s.replace('{{n}}', String(opts.n));
      return s;
    },
  }),
}));

jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', surface2: '#222', surface3: '#333', text: '#fff',
      textDim: '#aaa', textFaint: '#666', accent: '#05b875', accentInk: '#000',
      danger: '#e63946', warn: '#f59e0b', border: '#222', divider: '#1a1a1a',
      radius: 12, radiusS: 8, radiusL: 20, font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));

jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../../components/SchedulePicker', () => ({ SchedulePicker: () => null }));

jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title, left }: { title: string; left?: import('react').ReactNode }) => {
    const React = require('react') as typeof import('react');
    const { View, Text } = require('react-native') as typeof import('react-native');
    return React.createElement(View, null, left, React.createElement(Text, null, title));
  },
}));

jest.mock('../../components/Button', () => {
  const React = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native') as typeof import('react-native');
  const Btn = ({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) =>
    React.createElement(Pressable, { onPress, disabled }, React.createElement(Text, null, label));
  return { PrimaryButton: Btn, GhostButton: Btn };
});

// ── pickers / media (compose attachments — not exercised in these tests) ─────
jest.mock('../../utils/pickingGuard', () => ({ withPickingGuard: (fn: () => unknown) => fn() }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true }),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true }) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));

// ── db/local (dynamic import for decryptBody in the queue effect) ───────────
jest.mock('../../db/local', () => ({ decryptBody: jest.fn().mockResolvedValue('Queued body') }));

// ── stores ──────────────────────────────────────────────────────────────────
const mockIdentityState = { identity: { aegisId: 'AEGIS-OWNER' }, avatarImage: null as string | null };
jest.mock('../../store/identity', () => ({
  useIdentity: (sel: (s: typeof mockIdentityState) => unknown) => sel(mockIdentityState),
}));
jest.mock('../../store/groups', () => ({
  useGroups: (sel: (s: { groups: unknown[] }) => unknown) => sel({ groups: [] }),
}));

const mockScheduleGroupPost = jest.fn().mockResolvedValue(undefined);
const mockCancelScheduled = jest.fn().mockResolvedValue(undefined);
const mockLoadPending = jest.fn().mockResolvedValue(undefined);
let mockScheduled: Array<Record<string, unknown>> = [];
jest.mock('../../store/scheduledMessages', () => ({
  useScheduledMessages: (sel?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      scheduled: mockScheduled,
      scheduleGroupPost: mockScheduleGroupPost,
      cancelScheduled: mockCancelScheduled,
      loadPending: mockLoadPending,
    };
    return sel ? sel(state) : state;
  },
  canScheduleGroupPost: () => true,
  DEFAULT_POST_OPTIONS: { asGroup: true, pinned: false, notify: true, replies: true, repeatWeekly: false },
}));

import { GroupPostsScreen } from '../GroupPosts';

const GROUP = {
  id: 'g1',
  name: 'Equipo Cripto',
  adminId: 'AEGIS-OWNER',
  avatarColor: '#05b875',
  members: ['AEGIS-OWNER', 'AEGIS-2'],
} as never;

describe('GroupPostsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleGroupPost.mockResolvedValue(undefined);
    mockScheduled = [];
  });

  it('renders the title, group name and owner role', () => {
    const { getByText, getAllByText } = render(<GroupPostsScreen group={GROUP} onBack={jest.fn()} />);
    expect(getByText('Publicaciones')).toBeTruthy();
    // name shows in both the group-context header and the composer author row
    expect(getAllByText('Equipo Cripto').length).toBeGreaterThanOrEqual(1);
    // owner role label appears in the group-context sub line
    expect(getByText(/TÚ ERES DUEÑO/)).toBeTruthy();
  });

  it('schedules a pending post with the composed text', async () => {
    const { getByText, getByPlaceholderText } = render(<GroupPostsScreen group={GROUP} onBack={jest.fn()} />);
    fireEvent.changeText(getByPlaceholderText('Escribe el anuncio…'), 'Hola equipo');
    await act(async () => {
      fireEvent.press(getByText('Programar publicación'));
    });
    await waitFor(() => expect(mockScheduleGroupPost).toHaveBeenCalledTimes(1));
    expect(mockScheduleGroupPost).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g1', plaintext: 'Hola equipo', status: 'pending' }),
    );
  });

  it('saves a draft with status "draft"', async () => {
    const { getByText, getByPlaceholderText } = render(<GroupPostsScreen group={GROUP} onBack={jest.fn()} />);
    fireEvent.changeText(getByPlaceholderText('Escribe el anuncio…'), 'Borrador');
    await act(async () => {
      fireEvent.press(getByText('Guardar como borrador'));
    });
    await waitFor(() => expect(mockScheduleGroupPost).toHaveBeenCalledTimes(1));
    expect(mockScheduleGroupPost).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g1', plaintext: 'Borrador', status: 'draft' }),
    );
  });

  it('lists queued posts and confirm-gates deletion', async () => {
    mockScheduled = [
      { id: 'm1', groupId: 'g1', status: 'pending', sendAt: 2_000_000_000_000, encryptedPayload: 'enc' },
    ];
    const alertSpy = themedAlert as jest.Mock;
    const { getByText, findByLabelText } = render(<GroupPostsScreen group={GROUP} onBack={jest.fn()} />);

    // switch to the queue tab (label includes the count)
    fireEvent.press(getByText('EN COLA · 1'));
    const delBtn = await findByLabelText('Eliminar publicación');
    fireEvent.press(delBtn);
    expect(alertSpy).toHaveBeenCalledWith('Eliminar publicación', expect.any(String), expect.any(Array));
    expect(mockCancelScheduled).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void }>;
    const confirm = buttons.find((b) => b.style === 'destructive');
    confirm?.onPress?.();
    expect(mockCancelScheduled).toHaveBeenCalledWith('m1');
  });

  it('rejects a poll with an empty question', () => {
    const alertSpy = themedAlert as jest.Mock;
    const { getByLabelText, getByText } = render(<GroupPostsScreen group={GROUP} onBack={jest.fn()} />);
    fireEvent.press(getByLabelText('Encuesta')); // open poll composer
    fireEvent.press(getByText('OK'));
    expect(alertSpy).toHaveBeenCalledWith('Falta la pregunta', 'Escribe la pregunta de la encuesta.');
  });
});
