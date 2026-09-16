/**
 * LinkPreview — audit 2026-09-16 AL-05.
 *
 * The og:image URL is chosen by whoever sent the link. Rendering it
 * automatically would fetch it from that party's server the moment the
 * message is read (IP, timestamp, user agent — a tracking pixel). The card must
 * therefore never mount an <Image> for it until the user explicitly taps.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}));
jest.mock('../../config', () => ({
  SERVER_URL: 'https://relay.test',
  isSecureUrl: (u: string | null | undefined) => typeof u === 'string' && u.startsWith('https://'),
}));

import { LinkPreview } from '../LinkPreview';

const theme = {
  font: 'System', fontMono: 'Courier', text: '#fff', textDim: '#aaa', accent: '#0f0',
  surface2: '#111', surface3: '#222', border: '#333',
} as unknown as import('../../theme/vault').Theme;

const OG = { title: 'A page', description: 'Some description', image: 'https://tracker.example/pixel.png' };

beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => OG })) as unknown as typeof fetch;
});
afterEach(() => jest.restoreAllMocks());

describe('LinkPreview (AL-05: og:image only on explicit tap)', () => {
  it('fetches metadata through the relay proxy only, never the og:image', async () => {
    const { findByText, queryByLabelText, getByTestId, UNSAFE_queryAllByType } = render(
      <LinkPreview url="https://example.com/post" t={theme} />,
    );
    await findByText('A page');

    const calls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^https:\/\/relay\.test\/proxy\/linkpreview\?url=/);
    expect(calls.some((u) => u.includes('tracker.example'))).toBe(false);

    // No <Image> mounted: the remote URL has not been touched.
    const { Image } = jest.requireActual('react-native');
    expect(UNSAFE_queryAllByType(Image)).toHaveLength(0);
    expect(queryByLabelText('A page')).not.toBeNull(); // the card itself
    expect(getByTestId('link-preview-show-image')).toBeTruthy();
  });

  it('mounts the image with the og:image URL only after the user taps "Show image"', async () => {
    const { findByText, getByTestId, UNSAFE_queryAllByType } = render(
      <LinkPreview url="https://example.com/another" t={theme} />,
    );
    await findByText('A page');
    fireEvent.press(getByTestId('link-preview-show-image'));

    const { Image } = jest.requireActual('react-native');
    await waitFor(() => expect(UNSAFE_queryAllByType(Image)).toHaveLength(1));
    const img = UNSAFE_queryAllByType(Image)[0]!;
    expect(img.props.source).toEqual({ uri: OG.image });
  });
});
