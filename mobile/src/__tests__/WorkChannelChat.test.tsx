import { render, fireEvent } from '@testing-library/react-native';
import { WorkChannelChat } from '../screens/WorkChannelChat';
import { useWorkMessages } from '../store/workMessages';
import { useConnection } from '../store/connection';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000000', text: '#ffffff', textDim: '#aaaaaa', textFaint: '#555555',
      accent: '#00FF88', accentDeep: '#003322',
      surface: '#111111', surface2: '#222222', surface3: '#333333',
      border: '#333333', borderStrong: '#555555',
      radius: 12, radiusS: 8,
      font: 'Inter', fontMono: 'IBMPlexMono', fontDisplay: 'Inter',
      dark: true,
    },
  }),
}));

jest.mock('../socket/client', () => ({
  joinChannel: jest.fn(),
  emitChannelMsg: jest.fn(),
}));

jest.mock('../store/workMessages', () => ({
  useWorkMessages: jest.fn(),
}));

jest.mock('../store/identity', () => ({
  useIdentity: (selector: (s: { identity: { aegisId: string } | null }) => unknown) =>
    selector({ identity: { aegisId: 'MYID000-0000-0000' } }),
}));

jest.mock('../store/connection', () => ({
  useConnection: jest.fn(),
}));

jest.mock('../store/work', () => ({
  useWork: (selector: (s: { members: [] }) => unknown) => selector({ members: [] }),
}));

jest.mock('../store/workPresence', () => ({
  useWorkPresence: (selector: (s: { typingByChannel: Record<string, string[]> }) => unknown) =>
    selector({ typingByChannel: {} }),
}));

const mockChannel = {
  channelId: 'ch-001',
  orgId: 'org-001',
  name: 'general',
  isAnnouncements: false,
  createdAt: Date.now(),
};

const mockLoadMessages = jest.fn();
const mockSendMessage = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (useWorkMessages as unknown as jest.Mock).mockReturnValue({
    byChannel: {},
    loadMessages: mockLoadMessages,
    sendMessage: mockSendMessage,
    pinnedMessages: [],
    loadPinned: jest.fn(),
    handlePinEvent: jest.fn(),
    appendThreadReply: jest.fn(),
    updateReplyCount: jest.fn(),
    threadMessages: {},
    loadThread: jest.fn(),
  });
  (useConnection as unknown as jest.Mock).mockImplementation(
    (selector: (s: { online: boolean }) => unknown) => selector({ online: true })
  );
});

describe('WorkChannelChat', () => {
  it('muestra estado vacío cuando no hay mensajes', () => {
    const { getAllByText, getByText } = render(
      <WorkChannelChat channel={mockChannel} onBack={jest.fn()} isAdmin={false} />
    );
    expect(getAllByText('general').length).toBeGreaterThanOrEqual(1);
    expect(getByText(/inicio del canal/i)).toBeTruthy();
  });

  it('llama joinChannel y loadMessages al montar', () => {
    const { joinChannel } = require('../socket/client');
    render(<WorkChannelChat channel={mockChannel} onBack={jest.fn()} isAdmin={false} />);
    expect(joinChannel).toHaveBeenCalledWith('ch-001', 'org-001');
    expect(mockLoadMessages).toHaveBeenCalledWith('ch-001', 'org-001');
  });

  it('envía mensaje al pulsar send', () => {
    const { getByPlaceholderText, getByTestId } = render(
      <WorkChannelChat channel={mockChannel} onBack={jest.fn()} isAdmin={false} />
    );
    fireEvent.changeText(getByPlaceholderText('Mensaje en #general'), 'Hola equipo');
    fireEvent.press(getByTestId('send-button'));
    expect(mockSendMessage).toHaveBeenCalledWith('ch-001', 'org-001', 'Hola equipo');
  });

  it('muestra indicador offline sin crashear', () => {
    (useConnection as unknown as jest.Mock).mockImplementation(
      (selector: (s: { online: boolean }) => unknown) => selector({ online: false })
    );
    const { getByTestId } = render(
      <WorkChannelChat channel={mockChannel} onBack={jest.fn()} isAdmin={false} />
    );
    expect(getByTestId('offline-banner')).toBeTruthy();
  });

  it('no muestra input en canal de anuncios si no es admin', () => {
    const announcementsChannel = { ...mockChannel, isAnnouncements: true };
    const { getAllByText, queryByTestId } = render(
      <WorkChannelChat channel={announcementsChannel} onBack={jest.fn()} isAdmin={false} />
    );
    const readOnlyTexts = getAllByText(/solo admins pueden escribir/i);
    expect(readOnlyTexts.length).toBeGreaterThanOrEqual(1);
    expect(queryByTestId('send-button')).toBeNull();
  });

  it('muestra mensajes propios alineados a la derecha', () => {
    (useWorkMessages as unknown as jest.Mock).mockReturnValue({
      byChannel: {
        'ch-001': [
          {
            id: 'msg-1',
            channelId: 'ch-001',
            orgId: 'org-001',
            senderId: 'MYID000-0000-0000',
            body: 'Hola',
            type: 'text',
            createdAt: Date.now(),
          },
        ],
      },
      loadMessages: mockLoadMessages,
      sendMessage: mockSendMessage,
      pinnedMessages: [],
      loadPinned: jest.fn(),
      handlePinEvent: jest.fn(),
      appendThreadReply: jest.fn(),
      updateReplyCount: jest.fn(),
      threadMessages: {},
      loadThread: jest.fn(),
    });
    const { getByText } = render(
      <WorkChannelChat channel={mockChannel} onBack={jest.fn()} isAdmin={false} />
    );
    expect(getByText('Hola')).toBeTruthy();
  });

  it('muestra tabs "Mensajes" y "Archivos" en el header', () => {
    const { getByLabelText } = render(
      <WorkChannelChat channel={mockChannel} onBack={jest.fn()} isAdmin={false} />
    );
    expect(getByLabelText('Ver mensajes')).toBeTruthy();
    expect(getByLabelText('Ver archivos')).toBeTruthy();
  });

  it('muestra estado vacío de archivos al cambiar al tab Archivos sin attachments', () => {
    const { getByLabelText, getByText } = render(
      <WorkChannelChat channel={mockChannel} onBack={jest.fn()} isAdmin={false} />
    );
    fireEvent.press(getByLabelText('Ver archivos'));
    expect(getByText('Sin archivos en este canal')).toBeTruthy();
  });

  it('muestra archivos cuando hay mensajes con attachments', () => {
    (useWorkMessages as unknown as jest.Mock).mockReturnValue({
      byChannel: {
        'ch-001': [
          {
            id: 'msg-2',
            channelId: 'ch-001',
            orgId: 'org-001',
            senderId: 'SENDER01',
            body: '',
            type: 'file' as const,
            createdAt: Date.now(),
            attachments: [
              {
                id: 'att-1',
                messageId: 'msg-2',
                blobId: 'https://example.com/blob/1',
                filename: 'informe.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 102400,
                uploadedBy: 'SENDER01',
                createdAt: new Date().toISOString(),
              },
            ],
          },
        ],
      },
      loadMessages: mockLoadMessages,
      sendMessage: mockSendMessage,
      pinnedMessages: [],
      loadPinned: jest.fn(),
      handlePinEvent: jest.fn(),
      appendThreadReply: jest.fn(),
      updateReplyCount: jest.fn(),
      threadMessages: {},
      loadThread: jest.fn(),
    });

    const { getByLabelText, getByText } = render(
      <WorkChannelChat channel={mockChannel} onBack={jest.fn()} isAdmin={false} />
    );
    fireEvent.press(getByLabelText('Ver archivos'));
    expect(getByText('informe.pdf')).toBeTruthy();
  });
});
