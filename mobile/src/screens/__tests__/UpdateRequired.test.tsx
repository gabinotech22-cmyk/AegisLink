import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';

jest.mock('../../runtime', () => ({ APP_VERSION: '1.0.5' }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, string>) => (o ? `${k}:${o.installed}->${o.min}` : k),
  }),
}));
jest.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    t: {
      bg: '#000', text: '#fff', textDim: '#aaa', textFaint: '#666', accent: '#05b875',
      accentDeep: '#03875a', accentInk: '#000', radius: 12,
      font: 'System', fontMono: 'monospace', fontDisplay: 'System',
    },
  }),
}));
jest.mock('../../components/icons', () => ({ I: new Proxy({}, { get: () => () => null }) }));
jest.mock('../../utils/secureStore', () => ({
  ss: { get: jest.fn(async () => null), set: jest.fn(async () => {}), delete: jest.fn(async () => {}) },
}));

import { UpdateRequiredScreen } from '../UpdateRequired';

describe('UpdateRequiredScreen', () => {
  it('names both versions and offers exactly one way out: the store', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const { getByTestId, getByText, getByLabelText } = render(<UpdateRequiredScreen minVersion="1.0.6" />);
    expect(getByTestId('update-required')).toBeTruthy();
    expect(getByText('appVersion.requiredBody:1.0.5->1.0.6')).toBeTruthy();
    fireEvent.press(getByLabelText('appVersion.requiredCta'));
    expect(open).toHaveBeenCalledWith('https://apps.apple.com/app/id6788507322');
    open.mockRestore();
  });
});
