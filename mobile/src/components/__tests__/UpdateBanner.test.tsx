import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';

jest.mock('../../runtime', () => ({ APP_VERSION: '1.0.6' }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, string>) => (o?.version ? `${k}:${o.version}` : k) }),
}));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', surface: '#111', text: '#fff', textDim: '#aaa', accent: '#05b875',
      borderStrong: '#333', radiusS: 8, font: 'System',
    },
  }),
}));
jest.mock('../icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../utils/secureStore', () => ({
  ss: { get: jest.fn(async () => null), set: jest.fn(async () => {}), delete: jest.fn(async () => {}) },
}));

import { UpdateBanner } from '../UpdateBanner';
import { useAppVersion } from '../../store/appVersion';

beforeEach(() => {
  useAppVersion.setState({ latestVersion: null, minVersion: null, dismissedFor: null, notifiedFor: null, hydrated: true });
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe('UpdateBanner', () => {
  it('renders nothing when up to date', () => {
    useAppVersion.setState({ latestVersion: '1.0.6' });
    const { queryByTestId } = render(<UpdateBanner />);
    expect(queryByTestId('update-banner')).toBeNull();
  });

  it('renders nothing when the relay advertised nothing', () => {
    const { queryByTestId } = render(<UpdateBanner />);
    expect(queryByTestId('update-banner')).toBeNull();
  });

  it('shows the newer version and opens the store on tap', () => {
    useAppVersion.setState({ latestVersion: '1.0.7' });
    const { getByTestId, getByText, getByLabelText } = render(<UpdateBanner />);
    expect(getByTestId('update-banner')).toBeTruthy();
    expect(getByText('appVersion.bannerTitle:1.0.7')).toBeTruthy();
    fireEvent.press(getByLabelText('appVersion.bannerCta'));
    expect(Linking.openURL).toHaveBeenCalledWith('https://apps.apple.com/app/id6788507322');
  });

  it('dismiss hides it for this version only', () => {
    useAppVersion.setState({ latestVersion: '1.0.7' });
    const { getByLabelText, queryByTestId, rerender } = render(<UpdateBanner />);
    fireEvent.press(getByLabelText('appVersion.dismiss'));
    expect(queryByTestId('update-banner')).toBeNull();
    expect(useAppVersion.getState().dismissedFor).toBe('1.0.7');

    // A newer release brings it back.
    useAppVersion.setState({ latestVersion: '1.0.8' });
    rerender(<UpdateBanner />);
    expect(queryByTestId('update-banner')).toBeTruthy();
  });
});
