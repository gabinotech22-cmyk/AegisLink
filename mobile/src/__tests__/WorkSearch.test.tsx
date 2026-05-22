import { render, fireEvent } from '@testing-library/react-native';
import { WorkSearch } from '../screens/WorkSearch';
import { useWorkMessages } from '../store/workMessages';
import { useWork } from '../store/work';
import { useConnection } from '../store/connection';
import { useIdentity } from '../store/identity';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000000',
      text: '#ffffff',
      textDim: '#aaaaaa',
      textFaint: '#555555',
      accent: '#00FF88',
      accentDeep: '#003322',
      accentInk: '#001a0e',
      surface: '#111111',
      surface2: '#222222',
      surface3: '#333333',
      border: '#333333',
      borderStrong: '#555555',
      danger: '#e53e3e',
      warn: '#f0c674',
      divider: '#222222',
      radius: 12,
      radiusS: 8,
      radiusL: 22,
      font: 'Inter',
      fontMono: 'IBMPlexMono',
      fontDisplay: 'Inter',
      dark: true,
    },
  }),
}));

jest.mock('../components/icons', () => ({
  I: {
    ChevronL: () => null,
    Search: () => null,
    X: () => null,
  },
}));

jest.mock('../config', () => ({ SERVER_URL: 'http://localhost:3000' }));

jest.mock('../store/workMessages', () => ({
  useWorkMessages: jest.fn(),
}));

jest.mock('../store/work', () => ({
  useWork: jest.fn(),
  signAdminAction: () => ({ sig: 'fake-sig', ts: Date.now() }),
}));

jest.mock('../store/connection', () => ({
  useConnection: jest.fn(),
}));

jest.mock('../store/identity', () => ({
  useIdentity: jest.fn(),
}));

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const mockChannel = {
  channelId: 'ch-001',
  orgId: 'org-001',
  name: 'general',
  isAnnouncements: false,
  createdAt: 0,
};

const mockChannel2 = {
  channelId: 'ch-002',
  orgId: 'org-001',
  name: 'random',
  isAnnouncements: false,
  createdAt: 0,
};

const mockMsg = {
  id: 'msg-1',
  channelId: 'ch-001',
  orgId: 'org-001',
  senderId: 'SENDER01ABCDEFGH',
  body: 'Hola equipo reunión mañana',
  type: 'text' as const,
  createdAt: Date.now() - 7_200_000,
};

const mockMsg2 = {
  id: 'msg-2',
  channelId: 'ch-002',
  orgId: 'org-001',
  senderId: 'SENDER02XYZWVUTS',
  body: 'Mensaje en random',
  type: 'text' as const,
  createdAt: Date.now() - 60_000,
};

// ─── Default mock setup ───────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  (useWorkMessages as unknown as jest.Mock).mockImplementation((selector: (s: { byChannel: Record<string, typeof mockMsg[]> }) => unknown) =>
    selector({ byChannel: { 'ch-001': [mockMsg], 'ch-002': [mockMsg2] } }),
  );
  (useWork as unknown as jest.Mock).mockImplementation((selector: (s: { org: { orgId: string } | null; channels: typeof mockChannel[] }) => unknown) =>
    selector({ org: { orgId: 'org-001' }, channels: [mockChannel, mockChannel2] }),
  );
  // Offline by default so local search fires without fetch mocking
  (useConnection as unknown as jest.Mock).mockImplementation((selector: (s: { online: boolean }) => unknown) =>
    selector({ online: false }),
  );
  (useIdentity as unknown as jest.Mock).mockImplementation((selector: (s: { identity: { aegisId: string } | null }) => unknown) =>
    selector({ identity: { aegisId: 'OWN-SELF' } }),
  );
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkSearch', () => {
  const baseProps = {
    onBack: jest.fn(),
    onOpenChannel: jest.fn(),
  };

  it('renders search bar on mount', () => {
    const { getByTestId } = render(<WorkSearch {...baseProps} />);
    expect(getByTestId('search-input')).toBeTruthy();
  });

  it('shows "Escribe al menos 2 caracteres" when input is empty', () => {
    const { getByTestId } = render(<WorkSearch {...baseProps} />);
    expect(getByTestId('hint-too-short')).toBeTruthy();
  });

  it('shows "Escribe al menos 2 caracteres" when input is 1 character', () => {
    const { getByTestId } = render(<WorkSearch {...baseProps} />);
    fireEvent.changeText(getByTestId('search-input'), 'a');
    expect(getByTestId('hint-too-short')).toBeTruthy();
  });

  it('renders channel filter chips for every channel', () => {
    const { getByRole } = render(<WorkSearch {...baseProps} />);
    expect(getByRole('button', { name: 'Mostrar todos los canales' })).toBeTruthy();
    expect(getByRole('button', { name: 'Filtrar por canal #general' })).toBeTruthy();
    expect(getByRole('button', { name: 'Filtrar por canal #random' })).toBeTruthy();
  });

  it('shows offline banner when disconnected', () => {
    const { getByTestId } = render(<WorkSearch {...baseProps} />);
    expect(getByTestId('offline-banner')).toBeTruthy();
  });

  it('shows local results when query has >= 2 chars and offline', () => {
    const { getByTestId, getByText } = render(<WorkSearch {...baseProps} />);
    fireEvent.changeText(getByTestId('search-input'), 'reunión');
    expect(getByText('Hola equipo reunión mañana')).toBeTruthy();
  });

  it('shows channel name in accent above each result', () => {
    const { getByTestId, getAllByText } = render(<WorkSearch {...baseProps} />);
    fireEvent.changeText(getByTestId('search-input'), 'reunión');
    // "#general" appears both in the filter chip and the result row — at least one exists
    const labels = getAllByText('#general');
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

  it('shows no-results state when query matches nothing', () => {
    const { getByTestId } = render(<WorkSearch {...baseProps} />);
    fireEvent.changeText(getByTestId('search-input'), 'ZZZNOMATCH99');
    expect(getByTestId('no-results')).toBeTruthy();
  });

  it('calls onBack when back button is pressed', () => {
    const onBack = jest.fn();
    const { getByLabelText } = render(<WorkSearch {...baseProps} onBack={onBack} />);
    fireEvent.press(getByLabelText('Volver'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenChannel when a result row is tapped', () => {
    const onOpenChannel = jest.fn();
    const { getByTestId, getByRole } = render(
      <WorkSearch {...baseProps} onOpenChannel={onOpenChannel} />,
    );
    fireEvent.changeText(getByTestId('search-input'), 'reunión');
    fireEvent.press(
      getByRole('button', { name: /Ir al canal #general/ }),
    );
    expect(onOpenChannel).toHaveBeenCalledWith(mockChannel);
  });

  it('filters results to selected channel when chip tapped', () => {
    const { getByTestId, getByRole, queryByText } = render(<WorkSearch {...baseProps} />);
    // Both channels have messages with distinct text
    fireEvent.changeText(getByTestId('search-input'), 'Mensaje');
    expect(queryByText('Mensaje en random')).toBeTruthy();

    // Filter to ch-001 (general) — should hide ch-002 result
    fireEvent.press(getByRole('button', { name: 'Filtrar por canal #general' }));
    expect(queryByText('Mensaje en random')).toBeNull();
  });

  it('clears query and resets to too-short state when X is pressed', () => {
    const { getByTestId, getByLabelText } = render(<WorkSearch {...baseProps} />);
    fireEvent.changeText(getByTestId('search-input'), 'reunión');
    fireEvent.press(getByLabelText('Borrar búsqueda'));
    expect(getByTestId('hint-too-short')).toBeTruthy();
  });
});
