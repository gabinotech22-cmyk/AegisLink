import { render, fireEvent } from '@testing-library/react-native';
import { WorkDirectory } from '../screens/WorkDirectory';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockTheme = {
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
  divider: '#222222',
  radius: 12,
  radiusS: 8,
  font: 'Inter',
  fontMono: 'IBMPlexMono',
  fontDisplay: 'Inter',
  dark: true,
};

jest.mock('../theme/ThemeContext', () => ({
  useTheme: () => ({ t: mockTheme }),
}));

jest.mock('../components/icons', () => ({
  I: {
    X: () => null,
    Search: () => null,
    Users: () => null,
    Chat: () => null,
  },
}));

const mockMembers = [
  { org_id: 'org-1', aegis_id: 'AAA-BBBB-CCCC', team: 'eng', role: 'admin' as const, joined_at: Date.now() },
  { org_id: 'org-1', aegis_id: 'DDD-EEEE-FFFF', team: 'design', role: 'member' as const, joined_at: Date.now() },
];

jest.mock('../store/work', () => ({
  useWork: (selector: (s: { members: typeof mockMembers }) => unknown) =>
    selector({ members: mockMembers }),
}));

jest.mock('../store/workPresence', () => ({
  useWorkPresence: (selector: (s: { onlineIds: Set<string> }) => unknown) =>
    selector({ onlineIds: new Set(['AAA-BBBB-CCCC']) }),
}));

jest.mock('../store/identity', () => ({
  useIdentity: (selector: (s: { identity: { aegisId: string } | null }) => unknown) =>
    selector({ identity: { aegisId: 'OWN-1111-2222' } }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkDirectory', () => {
  const baseProps = {
    onBack: jest.fn(),
    onStartDM: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the directory title', () => {
    const { getByText } = render(<WorkDirectory {...baseProps} />);
    expect(getByText('Directorio')).toBeTruthy();
  });

  it('renders both members (excludes self)', () => {
    const { getByText } = render(<WorkDirectory {...baseProps} />);
    // aegis_id.slice(0,12) + '…'
    expect(getByText('AAA-BBBB-CCC…')).toBeTruthy();
    expect(getByText('DDD-EEEE-FFF…')).toBeTruthy();
  });

  it('shows ADMIN badge for admin member', () => {
    const { getByText } = render(<WorkDirectory {...baseProps} />);
    expect(getByText('ADMIN')).toBeTruthy();
  });

  it('shows MEMBER badge for member role', () => {
    const { getByText } = render(<WorkDirectory {...baseProps} />);
    expect(getByText('MEMBER')).toBeTruthy();
  });

  it('calls onBack when back button is pressed', () => {
    const onBack = jest.fn();
    const { getByRole } = render(<WorkDirectory {...baseProps} onBack={onBack} />);
    fireEvent.press(getByRole('button', { name: 'Volver' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onStartDM when DM button is pressed', () => {
    const onStartDM = jest.fn();
    const { getByRole } = render(
      <WorkDirectory {...baseProps} onStartDM={onStartDM} />
    );
    // accessibilityLabel uses aegis_id.slice(0,12)
    const dmBtn = getByRole('button', { name: 'Enviar DM a AAA-BBBB-CCC' });
    fireEvent.press(dmBtn);
    expect(onStartDM).toHaveBeenCalledWith('AAA-BBBB-CCCC');
  });

  it('filters members by search query', () => {
    const { getByPlaceholderText, queryByText } = render(<WorkDirectory {...baseProps} />);
    const input = getByPlaceholderText('Buscar por AegisID…');
    fireEvent.changeText(input, 'DDD');
    // AAA member should not be visible
    expect(queryByText('AAA-BBBB-CCC…')).toBeNull();
    // DDD member should still appear
    expect(queryByText('DDD-EEEE-FFF…')).toBeTruthy();
  });

  it('shows empty state when query has no results', () => {
    const { getByPlaceholderText, getByTestId } = render(<WorkDirectory {...baseProps} />);
    const input = getByPlaceholderText('Buscar por AegisID…');
    fireEvent.changeText(input, 'ZZZZZ-NORESULT');
    expect(getByTestId('empty-directory')).toBeTruthy();
  });

  it('shows empty state text when no search matches', () => {
    const { getByPlaceholderText, getByText } = render(<WorkDirectory {...baseProps} />);
    fireEvent.changeText(getByPlaceholderText('Buscar por AegisID…'), 'NOPE');
    expect(getByText('Sin resultados')).toBeTruthy();
  });
});
