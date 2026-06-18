import React from 'react';
import { render } from '@testing-library/react-native';
import Svg, { Rect } from 'react-native-svg';
import { Identicon } from '../Identicon';

function getRects(tree: ReturnType<typeof render>) {
  return tree.UNSAFE_getAllByType(Rect);
}

describe('Identicon', () => {
  it('renders the same grid (same rect count + positions) for the same seed', () => {
    const a = render(<Identicon seed="aegis-key-abc123" />);
    const b = render(<Identicon seed="aegis-key-abc123" />);

    const rectsA = getRects(a).map((r) => ({ x: r.props.x, y: r.props.y }));
    const rectsB = getRects(b).map((r) => ({ x: r.props.x, y: r.props.y }));

    expect(rectsA).toEqual(rectsB);
    expect(rectsA.length).toBeGreaterThan(0);
  });

  it('renders a different grid for a different seed', () => {
    const a = render(<Identicon seed="seed-one" />);
    const b = render(<Identicon seed="completely-different-seed" />);

    const rectsA = getRects(a).map((r) => ({ x: r.props.x, y: r.props.y }));
    const rectsB = getRects(b).map((r) => ({ x: r.props.x, y: r.props.y }));

    expect(rectsA).not.toEqual(rectsB);
  });

  it('uses the provided color as the fill for every cell', () => {
    const { UNSAFE_getAllByType } = render(<Identicon seed="seed-x" color="#ff00ff" />);
    const rects = UNSAFE_getAllByType(Rect);
    expect(rects.length).toBeGreaterThan(0);
    for (const r of rects) {
      expect(r.props.fill).toBe('#ff00ff');
    }
  });

  it('derives a deterministic hsl fill when no color is provided', () => {
    const a = render(<Identicon seed="no-color-seed" />);
    const b = render(<Identicon seed="no-color-seed" />);
    const fillA = getRects(a)[0]?.props.fill;
    const fillB = getRects(b)[0]?.props.fill;
    expect(fillA).toBe(fillB);
    expect(typeof fillA).toBe('string');
    expect(fillA).toMatch(/^hsl\(/);
  });

  it('wraps the svg in a circular clipping View when rounded is true', () => {
    const { UNSAFE_getAllByType } = render(<Identicon seed="seed-rounded" rounded size={40} />);
    const { View } = require('react-native');
    const views = UNSAFE_getAllByType(View);
    const clipView = views.find((v: any) => v.props.style?.borderRadius === 20);
    expect(clipView).toBeTruthy();
    expect(UNSAFE_getAllByType(Svg).length).toBe(1);
  });
});
