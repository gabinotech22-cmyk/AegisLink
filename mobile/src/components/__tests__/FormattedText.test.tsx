import React from 'react';
import { render } from '@testing-library/react-native';
import { FormattedText } from '../FormattedText';
import { VAULT_DARK } from '../../theme/vault';

const t = VAULT_DARK;

describe('FormattedText', () => {
  it('renders plain text without modification', () => {
    const { getByText } = render(<FormattedText body="Hello world" t={t} />);
    expect(getByText('Hello world')).toBeTruthy();
  });

  it('renders *bold* text with fontWeight 700', () => {
    const { UNSAFE_getAllByType } = render(
      <FormattedText body="this is *bold* text" t={t} />,
    );
    const { Text } = require('react-native');
    const boldTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) => node.props.style?.fontWeight === '700',
    );
    expect(boldTexts.length).toBeGreaterThan(0);
    expect(boldTexts[0].props.children).toBe('bold');
  });

  it('renders _italic_ text with fontStyle italic', () => {
    const { UNSAFE_getAllByType } = render(
      <FormattedText body="this is _italic_ text" t={t} />,
    );
    const { Text } = require('react-native');
    const italicTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) => node.props.style?.fontStyle === 'italic',
    );
    expect(italicTexts.length).toBeGreaterThan(0);
    expect(italicTexts[0].props.children).toBe('italic');
  });

  it('renders `code` with fontFamily monospace', () => {
    const { UNSAFE_getAllByType } = render(
      <FormattedText body="run `npm install` now" t={t} />,
    );
    const { Text } = require('react-native');
    const codeTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) => node.props.style?.fontFamily === t.fontMono,
    );
    expect(codeTexts.length).toBeGreaterThan(0);
  });

  it('renders ~strike~ with textDecorationLine line-through', () => {
    const { UNSAFE_getAllByType } = render(
      <FormattedText body="this is ~deleted~ text" t={t} />,
    );
    const { Text } = require('react-native');
    const strikeTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) => node.props.style?.textDecorationLine === 'line-through',
    );
    expect(strikeTexts.length).toBeGreaterThan(0);
    expect(strikeTexts[0].props.children).toBe('deleted');
  });

  it('renders multiple formats in the same string', () => {
    const { UNSAFE_getAllByType } = render(
      <FormattedText body="*bold* and _italic_ and ~strike~" t={t} />,
    );
    const { Text } = require('react-native');
    const allTexts = UNSAFE_getAllByType(Text);

    const hasBold = allTexts.some(
      (node: any) => node.props.style?.fontWeight === '700',
    );
    const hasItalic = allTexts.some(
      (node: any) => node.props.style?.fontStyle === 'italic',
    );
    const hasStrike = allTexts.some(
      (node: any) => node.props.style?.textDecorationLine === 'line-through',
    );

    expect(hasBold).toBe(true);
    expect(hasItalic).toBe(true);
    expect(hasStrike).toBe(true);
  });

  it('renders URL with accent color and underline', () => {
    const { UNSAFE_getAllByType } = render(
      <FormattedText body="visit https://aegislink.io today" t={t} />,
    );
    const { Text } = require('react-native');
    const urlTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) =>
        node.props.style?.color === t.accent &&
        node.props.style?.textDecorationLine === 'underline',
    );
    expect(urlTexts.length).toBeGreaterThan(0);
  });

  it('on the accent bubble, links drop the accent color so they stay visible', () => {
    // Regression: outgoing bubble background === t.accent, so an accent-colored
    // link was invisible on the sender's own bubble. With onAccent the link must
    // NOT be painted t.accent (it inherits the bubble text color) but stays
    // underlined so it still reads as a link.
    const { UNSAFE_getAllByType } = render(
      <FormattedText body="visit https://aegislink.io today" t={t} onAccent />,
    );
    const { Text } = require('react-native');
    const underlined = UNSAFE_getAllByType(Text).filter(
      (node: any) => node.props.style?.textDecorationLine === 'underline',
    );
    expect(underlined.length).toBeGreaterThan(0);
    expect(underlined.every((node: any) => node.props.style?.color !== t.accent)).toBe(true);
  });

  it('linkifies group invite deep links (tappable to join)', () => {
    const { UNSAFE_getAllByType } = render(
      <FormattedText
        body="Únete: aegislink://group/v1/g-123/MiGrupo/ADM-1111-2222"
        t={t}
      />,
    );
    const { Text } = require('react-native');
    const linkTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) =>
        node.props.style?.textDecorationLine === 'underline' &&
        typeof node.props.onPress === 'function',
    );
    expect(linkTexts.length).toBe(1);
    expect(linkTexts[0].props.children).toContain('aegislink://group/v1/');
  });

  it('linkifies channel invite deep links (audit 2026-08-08: they rendered as dead text)', () => {
    // Channel invites carry no `v1` segment, so the old allow-list skipped them
    // and they showed up as plain text right next to a tappable group invite.
    const { UNSAFE_getAllByType } = render(
      <FormattedText
        body="Únete: aegislink://channel/8ZP1QRSTVWXY0123456789ABCD/0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJK?k=ZYXWVUTSRQPNMKJHGFEDCBA9876543210ZYXWVUTSRQPN"
        t={t}
      />,
    );
    const { Text } = require('react-native');
    const linkTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) =>
        node.props.style?.textDecorationLine === 'underline' &&
        typeof node.props.onPress === 'function',
    );
    expect(linkTexts.length).toBe(1);
    expect(linkTexts[0].props.children).toContain('aegislink://channel/');
  });

  it('keeps the allow-list closed — an unknown aegislink:// path stays plain text', () => {
    // The pattern must never drift into "any aegislink:// URL": each new link
    // type has to be added deliberately here AND handled behind a confirmation
    // in handleDeepLink.
    const { UNSAFE_getAllByType } = render(
      <FormattedText body="mira aegislink://wipe/everything y aegislink://settings/reset" t={t} />,
    );
    const { Text } = require('react-native');
    const linkTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) => typeof node.props.onPress === 'function',
    );
    expect(linkTexts.length).toBe(0);
  });

  it('NEVER linkifies aegislink://panic (remote wipe must not be tappable from chat)', () => {
    const { UNSAFE_getAllByType } = render(
      <FormattedText
        body="mira aegislink://panic?token=abc&sig=def"
        t={t}
      />,
    );
    const { Text } = require('react-native');
    const linkTexts = UNSAFE_getAllByType(Text).filter(
      (node: any) => typeof node.props.onPress === 'function',
    );
    expect(linkTexts.length).toBe(0);
  });

  it('passes selectable prop to root Text', () => {
    const { UNSAFE_getByType } = render(
      <FormattedText body="selectable text" t={t} selectable />,
    );
    const { Text } = require('react-native');
    // The root Text is the first one
    const root = UNSAFE_getByType(Text);
    expect(root.props.selectable).toBe(true);
  });
});
