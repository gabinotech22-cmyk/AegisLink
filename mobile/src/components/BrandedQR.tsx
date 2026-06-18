import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import QRCode from 'react-native-qrcode-svg';

/**
 * QR code with the AegisLink shield mark centred in a hexagonal "quiet zone".
 *
 * The mark is drawn as a vector overlay (the same hexagon + bars as AegisMark),
 * not a raster logo, so it stays crisp and themeable. A filled-plus-stroked
 * hexagon in the QR's own background colour clears the modules behind the mark:
 * the scanner reads that whole region as one damaged block, which Reed–Solomon
 * error correction reconstructs. For that to be safe we render the QR at the
 * highest error-correction level (`ecl="H"`, ~30% recoverable) and keep the
 * shield small (~18% of the QR width) — well inside the recovery budget.
 */

// Hexagonal shield silhouette — identical path to AegisMark (viewBox 0 0 40 40).
const SHIELD = 'M20 2 L35 10 L35 30 L20 38 L5 30 L5 10 Z';

interface Props {
  value: string;
  size?: number;
  /** Module + finder colour. Near-black by default for maximum scan contrast. */
  color?: string;
  /** QR background; also used for the hexagonal quiet zone so it blends in. */
  background?: string;
  /** Shield colour. Defaults to the Vault light-mode accent (good on white). */
  accent?: string;
  /** Shield width as a fraction of the QR size. Keep ≤0.22 for reliable scans. */
  logoRatio?: number;
}

export function BrandedQR({
  value,
  size = 220,
  color = '#0a0a0a',
  background = '#ffffff',
  accent = '#0d8f5f',
  logoRatio = 0.18,
}: Props) {
  // The shield spans 30 of the 40 viewBox units, so the overlay box is scaled
  // up by 40/30 to make the *visible* shield equal `size * logoRatio`.
  const box = size * logoRatio * (40 / 30);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <QRCode value={value} size={size} color={color} backgroundColor={background} ecl="H" />
      <View
        pointerEvents="none"
        style={{ position: 'absolute', width: box, height: box, alignItems: 'center', justifyContent: 'center' }}
      >
        {/* viewBox padded so the white halo stroke is never clipped. */}
        <Svg width={box} height={box} viewBox="-3 -3 46 46">
          {/* Quiet zone: filled + thickly-stroked hexagon in the QR background. */}
          <Path
            d={SHIELD}
            fill={background}
            stroke={background}
            strokeWidth={5}
            strokeLinejoin="round"
          />
          {/* Accent outline shield (mirrors AegisMark). */}
          <Path d={SHIELD} fill="none" stroke={accent} strokeWidth={2.4} strokeLinejoin="round" />
          <Rect x={13} y={15} width={14} height={3.2} rx={0.4} fill={accent} />
          <Rect x={13} y={21.8} width={14} height={3.2} rx={0.4} fill={accent} opacity={0.55} />
        </Svg>
      </View>
    </View>
  );
}
