/**
 * FloatingMenu — unit tests
 *
 * Verifies:
 *  1. Renders title, subtitle and item labels
 *  2. Pressing an item closes the menu (onClose) and fires its onPress
 *  3. Pressing the backdrop closes the menu (onClose) without firing any item
 *  4. Danger items render their label in t.danger color
 *  5. Renders nothing interactive when not visible (Modal not visible)
 *  6. Renders optional topContent
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import { FloatingMenu, type FloatingMenuItem } from '../FloatingMenu';
import { VAULT_DARK } from '../../theme/vault';

const t = VAULT_DARK;

function makeItems(overrides?: Partial<FloatingMenuItem>[]): FloatingMenuItem[] {
  const base: FloatingMenuItem[] = [
    { key: 'reply', icon: <Text>icon-reply</Text>, label: 'Reply', onPress: jest.fn() },
    { key: 'delete', icon: <Text>icon-delete</Text>, label: 'Delete', onPress: jest.fn(), danger: true },
  ];
  if (!overrides) return base;
  return base.map((item, i) => ({ ...item, ...overrides[i] }));
}

describe('FloatingMenu', () => {
  // ── 1. Renders title, subtitle and item labels ────────────────────────────

  it('renders title, subtitle and item labels', () => {
    const items = makeItems();
    const { getByText } = render(
      <FloatingMenu
        t={t}
        visible
        onClose={jest.fn()}
        title="Alice"
        subtitle="AEG-1234-5678"
        items={items}
      />
    );
    expect(getByText('Alice')).toBeTruthy();
    expect(getByText('AEG-1234-5678')).toBeTruthy();
    expect(getByText('Reply')).toBeTruthy();
    expect(getByText('Delete')).toBeTruthy();
  });

  // ── 2. Pressing an item closes the menu and fires its onPress ─────────────

  it('pressing an item calls onClose and the item onPress', () => {
    const onClose = jest.fn();
    const onPressReply = jest.fn();
    const items = makeItems([{ onPress: onPressReply }, {}]);

    const { getByText } = render(
      <FloatingMenu t={t} visible onClose={onClose} items={items} />
    );

    fireEvent.press(getByText('Reply'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPressReply).toHaveBeenCalledTimes(1);
    // onClose must run before the item's own action (FloatingMenu contract)
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onPressReply.mock.invocationCallOrder[0]);
  });

  // ── 3. Pressing the backdrop closes the menu without firing items ─────────

  it('pressing the backdrop calls onClose without firing any item action', () => {
    const onClose = jest.fn();
    const onPressReply = jest.fn();
    const onPressDelete = jest.fn();
    const items = makeItems([{ onPress: onPressReply }, { onPress: onPressDelete }]);

    const { getByLabelText } = render(
      <FloatingMenu t={t} visible onClose={onClose} items={items} />
    );

    fireEvent.press(getByLabelText('Close menu'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPressReply).not.toHaveBeenCalled();
    expect(onPressDelete).not.toHaveBeenCalled();
  });

  // ── 4. Danger items render their label in t.danger color ──────────────────

  it('renders the label of a danger item using t.danger', () => {
    const items = makeItems();
    const { getByText } = render(
      <FloatingMenu t={t} visible onClose={jest.fn()} items={items} />
    );

    const deleteLabel = getByText('Delete');
    const flatStyle = Array.isArray(deleteLabel.props.style)
      ? Object.assign({}, ...deleteLabel.props.style)
      : deleteLabel.props.style;
    expect(flatStyle.color).toBe(t.danger);

    const replyLabel = getByText('Reply');
    const replyFlatStyle = Array.isArray(replyLabel.props.style)
      ? Object.assign({}, ...replyLabel.props.style)
      : replyLabel.props.style;
    expect(replyFlatStyle.color).toBe(t.text);
  });

  // ── 5. Not visible → item labels are not rendered ──────────────────────────

  it('does not render item labels when visible=false', () => {
    const items = makeItems();
    const { queryByText } = render(
      <FloatingMenu t={t} visible={false} onClose={jest.fn()} items={items} />
    );
    expect(queryByText('Reply')).toBeNull();
    expect(queryByText('Delete')).toBeNull();
  });

  // ── 6. Renders optional topContent ─────────────────────────────────────────

  it('renders optional topContent above the items', () => {
    const items = makeItems();
    const { getByText } = render(
      <FloatingMenu
        t={t}
        visible
        onClose={jest.fn()}
        items={items}
        topContent={<Text>quick-reactions</Text>}
      />
    );
    expect(getByText('quick-reactions')).toBeTruthy();
  });
});
