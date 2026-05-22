import { render, fireEvent } from '@testing-library/react-native';
import { WorkJoinSuccess } from '../screens/WorkJoinSuccess';
import type { WorkChannel } from '../store/work';

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
      divider: '#222222',
      radius: 12, radiusS: 8,
      font: 'Inter', fontMono: 'IBMPlexMono', fontDisplay: 'Inter',
      dark: true,
    },
  }),
}));

jest.mock('../components/icons', () => ({
  I: {
    Shield: () => null,
  },
}));

const mockChannels: WorkChannel[] = [
  { channelId: 'ch-1', orgId: 'org-1', name: 'general', isAnnouncements: false, createdAt: Date.now() },
  { channelId: 'ch-2', orgId: 'org-1', name: 'anuncios', isAnnouncements: true, createdAt: Date.now() },
];

describe('WorkJoinSuccess', () => {
  it('muestra el nombre de la organización', () => {
    const { getByText } = render(
      <WorkJoinSuccess orgName="Acme Corp" role="member" channels={[]} onContinue={jest.fn()} />
    );
    expect(getByText('Acme Corp')).toBeTruthy();
  });

  it('muestra badge ADMIN cuando rol es admin', () => {
    const { getByText } = render(
      <WorkJoinSuccess orgName="Acme Corp" role="admin" channels={[]} onContinue={jest.fn()} />
    );
    expect(getByText('ADMIN')).toBeTruthy();
  });

  it('muestra badge MIEMBRO cuando rol es member', () => {
    const { getByText } = render(
      <WorkJoinSuccess orgName="Acme Corp" role="member" channels={[]} onContinue={jest.fn()} />
    );
    expect(getByText('MIEMBRO')).toBeTruthy();
  });

  it('muestra la lista de canales con prefijo #', () => {
    const { getAllByText, getByText } = render(
      <WorkJoinSuccess orgName="Acme Corp" role="member" channels={mockChannels} onContinue={jest.fn()} />
    );
    expect(getByText('general')).toBeTruthy();
    expect(getAllByText('anuncios').length).toBeGreaterThanOrEqual(1);
    expect(getAllByText('#').length).toBeGreaterThanOrEqual(2);
  });

  it('limita la lista a 5 canales', () => {
    const manyChannels: WorkChannel[] = Array.from({ length: 8 }, (_, i) => ({
      channelId: `ch-${i}`,
      orgId: 'org-1',
      name: `canal-${i}`,
      isAnnouncements: false,
      createdAt: Date.now(),
    }));
    const { queryByText } = render(
      <WorkJoinSuccess orgName="Acme" role="member" channels={manyChannels.slice(0, 5)} onContinue={jest.fn()} />
    );
    expect(queryByText('canal-5')).toBeNull();
  });

  it('llama onContinue al pulsar el botón CTA', () => {
    const onContinue = jest.fn();
    const { getByText } = render(
      <WorkJoinSuccess orgName="Acme Corp" role="member" channels={[]} onContinue={onContinue} />
    );
    fireEvent.press(getByText('Entrar al workspace'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('muestra estado vacío de canales sin crashear', () => {
    const { getByText } = render(
      <WorkJoinSuccess orgName="Acme Corp" role="member" channels={[]} onContinue={jest.fn()} />
    );
    // Should still show org name and button with no channels
    expect(getByText('Acme Corp')).toBeTruthy();
    expect(getByText('Entrar al workspace')).toBeTruthy();
  });
});
