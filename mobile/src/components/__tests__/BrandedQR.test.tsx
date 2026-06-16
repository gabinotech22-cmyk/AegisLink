import { render } from '@testing-library/react-native';
import { BrandedQR } from '../BrandedQR';

describe('BrandedQR', () => {
  it('renders without throwing for a typical Aegis link value', () => {
    const tree = render(
      <BrandedQR value="aegislink://contact/ABC-1234-5678#somepublickeybase64" size={220} />,
    );
    expect(tree.toJSON()).toBeTruthy();
  });

  it('accepts custom colour, background, accent and logoRatio', () => {
    const tree = render(
      <BrandedQR
        value="ABC-1234-5678"
        size={180}
        color="#0a0a0a"
        background="#ffffff"
        accent="#0d8f5f"
        logoRatio={0.18}
      />,
    );
    expect(tree.toJSON()).toBeTruthy();
  });
});
