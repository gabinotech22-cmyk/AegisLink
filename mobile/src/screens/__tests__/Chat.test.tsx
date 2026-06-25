/**
 * ChatScreen — unit tests (RNTL)
 *
 * Coverage:
 *  1.  renderiza sin crashear con lista vacía
 *  2.  muestra offline-banner cuando online=false
 *  3.  NO muestra offline-banner cuando online=true
 *  4.  llama loadChat al montar
 *  5.  handleSend con texto llama sendMessage
 *  6.  después de send exitoso el input queda vacío
 *  7.  SoundFX.msgSent() se llama tras envío exitoso
 *  8.  con input vacío send NO llama sendMessage
 *  9.  si sendMessage rechaza, el texto se restaura en el input
 *  10. al confirmar delete, softDelete llamado con (chatId, messageId)
 *  11. softDelete recibe exactamente 'alice-id' y 'msg-1'
 *  12. handleDeleteForAll: softDelete llamado con (chatId, messageId)
 *  13. handleDeleteForAll: sendDeleteForEveryone llamado con (contactAegisId, messageId)
 *  14. cuando ephemeralSecs=86400 se muestra el indicador de timer
 *  15. presionar el botón timer llama onEphemeral
 *  16. presionar el botón de adjuntar llama onAttach
 *  17. cuando mockMessages tiene un mensaje, su body se renderiza en pantalla
 *  18. un mensaje con deleted:true NO muestra el body original
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert, TextInput, Pressable, Text } from 'react-native';
import { themedAlert } from '../../components/AlertHost';
import type { StoredContact, StoredMessage } from '../../db/local';

// ── Nativos ──────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

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
      fontMono: 'Courier',
      fontDisplay: 'System',
      dark: true,
    },
  }),
}));

// Inert mock incl. the modern Gesture builder API used by MediaEditorModal.
jest.mock('react-native-gesture-handler', () => {
  const chain = () => {
    const g: Record<string, () => unknown> = {};
    ['enabled', 'minDistance', 'onStart', 'onUpdate', 'onEnd', 'onChange', 'runOnJS',
      'onBegin', 'onFinalize', 'hitSlop', 'simultaneousWithExternalGesture',
      'requireExternalGestureToFail'].forEach((m) => { g[m] = () => g; });
    return g;
  };
  const P = (props: { children?: React.ReactNode }) => (props && props.children != null ? props.children : null);
  return {
    __esModule: true,
    Gesture: { Pan: chain, Pinch: chain, Tap: chain, Simultaneous: () => chain(), Race: () => chain(), Exclusive: () => chain() },
    GestureDetector: P, GestureHandlerRootView: P, Swipeable: P,
    State: {}, Directions: {},
  };
});

jest.mock('react-native-svg', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  Path: () => null,
  Svg: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid-1234' }));

jest.mock('tweetnacl-util', () => ({
  decodeBase64: (_s: string) => new Uint8Array(32),
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ uri: 'compressed://img.jpg' }),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file://cache/',
  downloadAsync: jest.fn().mockResolvedValue({ uri: 'file://cache/gif.gif' }),
  getInfoAsync: jest.fn().mockResolvedValue({ size: 100 }),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  readAsStringAsync: jest.fn().mockResolvedValue('base64encodeddata'),
  EncodingType: { Base64: 'base64' },
}));

// ── Módulos internos ──────────────────────────────────────────────────────────
const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockSendDeleteForEveryone = jest.fn();

jest.mock('../../socket/client', () => ({
  sendMessage: (...a: unknown[]) => mockSendMessage(...a),
  emitTyping: jest.fn(),
  sendReadReceipts: jest.fn(),
  sendDeleteForEveryone: (...a: unknown[]) => mockSendDeleteForEveryone(...a),
  getSocket: jest.fn().mockReturnValue(null),
}));

jest.mock('../../socket/calls', () => ({ startCall: jest.fn() }));

// Chat confirms destructive actions via themedAlert() (in-app themed dialog),
// not RN's Alert.alert. Mock it so tests can drive the confirm button.
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));

jest.mock('../../hooks/usePanicGesture', () => ({
  usePanicGesture: jest.fn(),
}));

jest.mock('../../hooks/useSoundFX', () => ({
  SoundFX: {
    msgSent: jest.fn().mockResolvedValue(undefined),
    msgReceived: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../db/local', () => ({ wipeDatabase: jest.fn() }));

// Return the same publicKey as the fixture contact so key-mismatch logic
// does not fire setMismatchKey (which causes un-wrapped-in-act warnings).
jest.mock('../../api', () => ({
  lookupIdentity: jest.fn().mockImplementation(() =>
    Promise.resolve({
      publicKey: Buffer.from(new Uint8Array(32)).toString('base64'),
    })
  ),
}));

jest.mock('../../notifications/push', () => ({
  setActiveChatNotificationId: jest.fn(),
  showCriticalSecurityNotification: jest.fn(),
}));

jest.mock('../../crypto/media', () => ({
  encryptAndUploadMedia: jest.fn().mockResolvedValue('encrypted://blob.bin'),
}));

jest.mock('../../utils/parseLocationMessage', () => ({
  parseLocationMessage: jest.fn().mockReturnValue(null),
}));

jest.mock('../../components/WallpaperPicker', () => ({
  loadWallpaper: jest.fn().mockResolvedValue(0),
  wallpaperBg: jest.fn().mockReturnValue(undefined),
  ChatWallpaper: () => null,
}));

jest.mock('../../runtime', () => ({ WEBRTC_AVAILABLE: false }));

jest.mock('../../components/icons', () => ({
  I: new Proxy({}, { get: () => () => null }),
}));

jest.mock('../../components/TopBar', () => ({
  TopBar: ({ title }: { title: string }) => {
    const { Text: MockText } = require('react-native') as typeof import('react-native');
    return <MockText testID="topbar-title">{title}</MockText>;
  },
}));

jest.mock('../../components/FormattedText', () => ({
  FormattedText: ({ body }: { body: string }) => {
    const { Text: MockText } = require('react-native') as typeof import('react-native');
    return <MockText>{body}</MockText>;
  },
}));

jest.mock('../../components/AudioWaveform', () => ({ AudioWaveform: () => null }));
jest.mock('../../components/LinkPreview', () => ({ LinkPreview: () => null }));
jest.mock('../../components/GifPicker', () => ({ GifPicker: () => null }));
jest.mock('../../components/ImageViewerModal', () => ({ ImageViewerModal: () => null }));

jest.mock('../../components/SwipeableMessage', () => ({
  SwipeableMessage: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../../components/Avatar', () => ({ Avatar: () => null }));
jest.mock('../../components/SchedulePicker', () => ({ SchedulePicker: () => null }));
jest.mock('../../components/ForwardModal', () => ({ ForwardModal: () => null }));

// MessageActionsSheet expone handlers directamente para tests
jest.mock('../../components/MessageActionsSheet', () => ({
  MessageActionsSheet: ({
    onDelete,
    onDeleteForAll,
    visible,
  }: {
    onDelete?: () => void;
    onDeleteForAll?: () => void;
    visible?: boolean;
  }) => {
    if (!visible) return null;
    const { Pressable: MockPressable } = require('react-native') as typeof import('react-native');
    return (
      <>
        {onDelete && (
          <MockPressable testID="action-delete" onPress={onDelete} />
        )}
        {onDeleteForAll && (
          <MockPressable testID="action-delete-all" onPress={onDeleteForAll} />
        )}
      </>
    );
  },
}));

// Stickers — needed because Bubble can require() VaultPack dynamically
jest.mock('../../components/stickers/VaultPack', () => ({
  VaultSticker: () => null,
}));

// ── Stores mockeados ──────────────────────────────────────────────────────────
// Stable store objects — mutated in beforeEach / per-test helpers to avoid
// creating new object references on every selector call, which would cause
// the search useEffect's `list` dependency to fire infinitely.
const mockStoreMessages: Record<string, StoredMessage[]> = { 'alice-id': [] };
const mockStoreEphemeral: Record<string, number> = {};
let mockOnline = true;

const mockAppend = jest.fn().mockResolvedValue(undefined);
const mockLoadChat = jest.fn().mockResolvedValue(undefined);
const mockSoftDelete = jest.fn().mockResolvedValue(undefined);
const mockMarkRead = jest.fn().mockResolvedValue(undefined);
const mockSaveDraft = jest.fn().mockResolvedValue(undefined);
const mockSetPendingMedia = jest.fn();
const mockToggleReaction = jest.fn().mockResolvedValue(undefined);
const mockToggleStar = jest.fn().mockResolvedValue(undefined);
const mockTogglePin = jest.fn().mockResolvedValue(undefined);

// Stable store state object — mutating fields rather than replacing the object
// keeps selector results referentially stable between renders.
const mockMessagesState = {
  byChat: mockStoreMessages,
  previews: {},
  pinnedMsg: {},
  ephemeralTimers: mockStoreEphemeral,
  drafts: {},
  pendingMediaUri: null as string | null,
  unreadCounts: {},
  loadChat: mockLoadChat,
  append: mockAppend,
  softDelete: mockSoftDelete,
  markRead: mockMarkRead,
  saveDraft: mockSaveDraft,
  setPendingMedia: mockSetPendingMedia,
  toggleReaction: mockToggleReaction,
  toggleStar: mockToggleStar,
  togglePin: mockTogglePin,
};

jest.mock('../../store/messages', () => {
  const hook = jest.fn((sel: (s: unknown) => unknown) => sel(mockMessagesState)) as jest.Mock & {
    getState: () => typeof mockMessagesState;
  };
  hook.getState = () => mockMessagesState;
  return { useMessages: hook };
});

jest.mock('../../store/identity', () => {
  // Zustand stores expose .getState() as a static method on the hook itself.
  // Chat.tsx calls: const { identity } = useIdentity()   (line 83)
  //            and: useIdentity.getState().reset()         (line 89)
  const mockHook = jest.fn(() => ({
    identity: { aegisId: 'my-id', secretKey: new Uint8Array(32) },
    displayName: 'Me',
  })) as jest.Mock & { getState: () => { reset: () => Promise<void> } };
  mockHook.getState = jest.fn(() => ({
    reset: jest.fn().mockResolvedValue(undefined) as () => Promise<void>,
  }));
  return { useIdentity: mockHook };
});

jest.mock('../../store/connection', () => ({
  useConnection: jest.fn((sel: (s: unknown) => unknown) => sel({ online: mockOnline })),
}));

jest.mock('../../store/typing', () => ({
  useTyping: jest.fn((sel: (s: unknown) => unknown) => sel({ typing: {} })),
}));

jest.mock('../../store/preferences', () => ({
  usePreferences: jest.fn((sel: (s: unknown) => unknown) =>
    sel({
      readReceipts: true,
      typingIndicator: true,
      duressActive: false,
    })
  ),
}));

jest.mock('../../store/contacts', () => ({
  useContacts: jest.fn((sel: (s: unknown) => unknown) =>
    sel({
      contacts: [
        {
          aegisId: 'alice-id',
          name: 'Alice',
          publicKeyB64: Buffer.from(new Uint8Array(32)).toString('base64'),
          color: '#05b875',
          avatarImage: null,
          verified: false,
          addedAt: 0,
          blocked: false,
          zeroTrust: false,
          archived: false,
          muted: false,
        },
      ],
    })
  ),
}));

jest.mock('../../store/scheduledMessages', () => ({
  useScheduledMessages: jest.fn(() => ({
    scheduleMessage: jest.fn(),
    scheduled: [],
  })),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────
function makeContact(overrides: Partial<StoredContact> = {}): StoredContact {
  return {
    aegisId: 'alice-id',
    name: 'Alice',
    publicKeyB64: Buffer.from(new Uint8Array(32)).toString('base64'),
    color: '#05b875',
    avatarImage: null,
    verified: false,
    addedAt: Date.now(),
    status: undefined,
    lastSeenAt: undefined,
    blocked: false,
    zeroTrust: false,
    archived: false,
    muted: false,
    ...overrides,
  };
}

function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    chatId: 'alice-id',
    direction: 'out' as const,
    body: 'hello world',
    createdAt: Date.now(),
    type: 'text' as const,
    mediaUri: null,
    deleted: false,
    starred: false,
    pinned: false,
    deliveryStatus: 'sent' as const,
    reactions: {},
    replyToId: null,
    expiresAt: null,
    ...overrides,
  };
}

const DEFAULT_PROPS = {
  contact: makeContact(),
  onBack: jest.fn(),
  onContactDetail: jest.fn(),
  onAttach: jest.fn(),
  onEphemeral: jest.fn(),
};

// Imported AFTER all mocks
import { ChatScreen } from '../Chat';
import { SoundFX } from '../../hooks/useSoundFX';

// ── Reset state before each test ──────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  // Reset stable store to empty state — mutate in-place to keep references stable
  mockStoreMessages['alice-id'] = [];
  mockStoreEphemeral['alice-id'] = 0;
  mockMessagesState.pendingMediaUri = null;
  mockOnline = true;
  mockSendMessage.mockResolvedValue(undefined);
  mockLoadChat.mockResolvedValue(undefined);
  mockSoftDelete.mockResolvedValue(undefined);
  mockAppend.mockResolvedValue(undefined);
  // Reset useConnection to online
  const { useConnection } = require('../../store/connection') as { useConnection: jest.Mock };
  useConnection.mockImplementation((sel: (s: { online: boolean }) => unknown) =>
    sel({ online: true })
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// describe: rendering básico
// ═════════════════════════════════════════════════════════════════════════════
describe('rendering básico', () => {
  it('1. renderiza sin crashear con lista vacía', () => {
    expect(() => render(<ChatScreen {...DEFAULT_PROPS} />)).not.toThrow();
  });

  it('2. muestra testID=offline-banner cuando online=false', async () => {
    mockOnline = false;

    // useConnection mock reads mockOnline at call-time via the selector
    const { useConnection } = require('../../store/connection') as {
      useConnection: jest.Mock;
    };
    useConnection.mockImplementation((sel: (s: { online: boolean }) => unknown) =>
      sel({ online: false })
    );

    const { getByTestId } = render(<ChatScreen {...DEFAULT_PROPS} />);
    expect(getByTestId('offline-banner')).toBeTruthy();
  });

  it('3. NO muestra offline-banner cuando online=true', () => {
    const { queryByTestId } = render(<ChatScreen {...DEFAULT_PROPS} />);
    expect(queryByTestId('offline-banner')).toBeNull();
  });

  it('4. llama loadChat al montar', async () => {
    render(<ChatScreen {...DEFAULT_PROPS} />);
    await waitFor(() => {
      expect(mockLoadChat).toHaveBeenCalledWith('alice-id');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// describe: handleSend — texto
// ═════════════════════════════════════════════════════════════════════════════
describe('handleSend — texto', () => {
  it('5. con texto en el input presionar send llama sendMessage', async () => {
    const { UNSAFE_getByType, getByTestId } = render(
      <ChatScreen {...DEFAULT_PROPS} />
    );

    const input = UNSAFE_getByType(TextInput);
    fireEvent.changeText(input, 'Hola mundo');
    fireEvent.press(getByTestId('send-button'));

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('6. después de send exitoso el input queda vacío', async () => {
    const { UNSAFE_getByType, getByTestId } = render(
      <ChatScreen {...DEFAULT_PROPS} />
    );

    const input = UNSAFE_getByType(TextInput);
    fireEvent.changeText(input, 'Texto a enviar');
    fireEvent.press(getByTestId('send-button'));

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    // After successful send the draft is cleared
    expect(input.props.value).toBe('');
  });

  it('7. SoundFX.msgSent() se llama tras envío exitoso', async () => {
    const { UNSAFE_getByType, getByTestId } = render(
      <ChatScreen {...DEFAULT_PROPS} />
    );

    fireEvent.changeText(UNSAFE_getByType(TextInput), 'test sound');
    fireEvent.press(getByTestId('send-button'));

    await waitFor(() => {
      expect(SoundFX.msgSent).toHaveBeenCalledTimes(1);
    });
  });

  it('8. con input vacío send NO llama sendMessage', async () => {
    const { getByTestId } = render(<ChatScreen {...DEFAULT_PROPS} />);

    fireEvent.press(getByTestId('send-button'));

    // Give any async path a chance to run
    await act(async () => {});

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('8b. la tecla "enviar" del teclado (onSubmitEditing) con texto llama sendMessage', async () => {
    const { UNSAFE_getByType } = render(<ChatScreen {...DEFAULT_PROPS} />);

    const input = UNSAFE_getByType(TextInput);
    fireEvent.changeText(input, 'enviado con la tecla');
    fireEvent(input, 'submitEditing');

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('8c. la tecla "enviar" con input vacío NO llama sendMessage', async () => {
    const { UNSAFE_getByType } = render(<ChatScreen {...DEFAULT_PROPS} />);

    fireEvent(UNSAFE_getByType(TextInput), 'submitEditing');

    await act(async () => {});

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('9. si sendMessage rechaza el texto se restaura en el input', async () => {
    const errorMsg = 'network error';
    mockSendMessage.mockRejectedValueOnce(new Error(errorMsg));

    // Send failure surfaces the error via themedAlert (not RN Alert.alert).
    const alertSpy = (themedAlert as jest.Mock);
    alertSpy.mockClear();

    const { UNSAFE_getByType, getByTestId } = render(
      <ChatScreen {...DEFAULT_PROPS} />
    );

    const input = UNSAFE_getByType(TextInput);
    fireEvent.changeText(input, 'mensaje fallido');
    fireEvent.press(getByTestId('send-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });

    // Draft is restored after failure
    expect(input.props.value).toBe('mensaje fallido');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// describe: handleDelete — borrado local
// ═════════════════════════════════════════════════════════════════════════════
describe('handleDelete — borrado local', () => {
  // Helper: render with one outgoing message, trigger long-press, confirm delete
  async function renderAndDelete() {
    // Mutate stable store — same reference, just update the array contents
    const msg = makeMsg({ id: 'msg-1', direction: 'out' });
    mockStoreMessages['alice-id'] = [msg];

    // themedAlert confirm: immediately invoke the destructive button's onPress
    const alertSpy = (themedAlert as jest.Mock).mockImplementation(
      (
        _title: string,
        _alertMsg?: string,
        buttons?: Array<{ text?: string; onPress?: () => void }>
      ) => {
        const destructive = buttons?.find((b) => b.text === 'common.delete');
        destructive?.onPress?.();
      }
    );

    const { getByText, getByTestId } = render(
      <ChatScreen {...DEFAULT_PROPS} />
    );

    // Trigger long-press on the message to open MessageActionsSheet
    await waitFor(() => getByText('hello world'));
    fireEvent(getByText('hello world'), 'longPress');

    // Press the delete action exposed by our MessageActionsSheet mock
    await waitFor(() => getByTestId('action-delete'));
    fireEvent.press(getByTestId('action-delete'));

    await waitFor(() => {
      expect(mockSoftDelete).toHaveBeenCalled();
    });

    alertSpy.mockRestore();
  }

  it('10. al confirmar delete, softDelete es llamado con (chatId, messageId)', async () => {
    await renderAndDelete();
    expect(mockSoftDelete).toHaveBeenCalled();
  });

  it('11. softDelete recibe exactamente "alice-id" y "msg-1"', async () => {
    await renderAndDelete();
    expect(mockSoftDelete).toHaveBeenCalledWith('alice-id', 'msg-1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// describe: handleDeleteForAll
// ═════════════════════════════════════════════════════════════════════════════
describe('handleDeleteForAll', () => {
  async function renderAndDeleteForAll() {
    const msg = makeMsg({ id: 'msg-1', direction: 'out' });
    mockStoreMessages['alice-id'] = [msg];

    // themedAlert confirm: invoke the destructive button
    const alertSpy = (themedAlert as jest.Mock).mockImplementation(
      (
        _title: string,
        _alertMsg?: string,
        buttons?: Array<{ text?: string; onPress?: () => void }>
      ) => {
        const destructive = buttons?.find((b) => b.text === 'chat.deleteForAllBtn');
        destructive?.onPress?.();
      }
    );

    const { getByText, getByTestId } = render(
      <ChatScreen {...DEFAULT_PROPS} />
    );

    await waitFor(() => getByText('hello world'));
    fireEvent(getByText('hello world'), 'longPress');

    await waitFor(() => getByTestId('action-delete-all'));
    fireEvent.press(getByTestId('action-delete-all'));

    await waitFor(() => {
      expect(mockSoftDelete).toHaveBeenCalled();
    });

    alertSpy.mockRestore();
  }

  it('12. al confirmar delete-for-all, softDelete llamado con (chatId, messageId)', async () => {
    await renderAndDeleteForAll();
    expect(mockSoftDelete).toHaveBeenCalledWith('alice-id', 'msg-1');
  });

  it('13. sendDeleteForEveryone llamado con (contactAegisId, messageId)', async () => {
    await renderAndDeleteForAll();
    expect(mockSendDeleteForEveryone).toHaveBeenCalledWith('alice-id', 'msg-1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// describe: ephemeral indicator
// ═════════════════════════════════════════════════════════════════════════════
describe('ephemeral indicator', () => {
  beforeEach(() => {
    // Mutate stable ephemeral store
    mockStoreEphemeral['alice-id'] = 86400;
  });

  it('14. cuando ephemeralSecs=86400 el compositor muestra el botón timer', () => {
    const { getByLabelText } = render(
      <ChatScreen {...DEFAULT_PROPS} />
    );
    // The ephemeral Pressable has accessibilityLabel "Temporizador de autodestrucción activo"
    expect(
      getByLabelText('Temporizador de autodestrucción activo')
    ).toBeTruthy();
  });

  it('15. presionar el botón timer llama onEphemeral', () => {
    const onEphemeral = jest.fn();
    const { getByLabelText } = render(
      <ChatScreen {...DEFAULT_PROPS} onEphemeral={onEphemeral} />
    );

    fireEvent.press(
      getByLabelText('Temporizador de autodestrucción activo')
    );

    expect(onEphemeral).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// describe: onAttach
// ═════════════════════════════════════════════════════════════════════════════
describe('onAttach', () => {
  it('16. presionar el botón de adjuntar llama onAttach', () => {
    const onAttach = jest.fn();
    const { getByLabelText } = render(
      <ChatScreen {...DEFAULT_PROPS} onAttach={onAttach} />
    );

    fireEvent.press(getByLabelText('Adjuntar archivo'));

    expect(onAttach).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// describe: mensajes en lista
// ═════════════════════════════════════════════════════════════════════════════
describe('mensajes en lista', () => {
  it('17. cuando mockMessages tiene un mensaje su body se renderiza en pantalla', async () => {
    const msg = makeMsg({ id: 'msg-1', body: 'hello world', deleted: false });
    mockStoreMessages['alice-id'] = [msg];

    const { getByText } = render(<ChatScreen {...DEFAULT_PROPS} />);

    await waitFor(() => {
      expect(getByText('hello world')).toBeTruthy();
    });
  });

  it('18. un mensaje con deleted:true NO muestra el body original', async () => {
    const msg = makeMsg({
      id: 'msg-1',
      body: 'mensaje secreto borrado',
      deleted: true,
    });
    mockStoreMessages['alice-id'] = [msg];

    const { queryByText } = render(<ChatScreen {...DEFAULT_PROPS} />);

    await waitFor(() => {
      // The Bubble component renders i18nT('chat.deletedMessage') for deleted msgs.
      // Our i18n mock returns the key itself: 'chat.deletedMessage'
      expect(queryByText('mensaje secreto borrado')).toBeNull();
    });
  });
});
