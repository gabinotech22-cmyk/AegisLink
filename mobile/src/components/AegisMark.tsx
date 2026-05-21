import Svg, { Path, Rect } from 'react-native-svg';
import { Text } from 'react-native';
import type { Theme } from '../theme/vault';

interface Props {
  t: Theme;
  size?: number;
  mono?: boolean;
}

export function AegisMark({ t, size = 32, mono = false }: Props) {
  const stroke = mono ? t.text : t.accent;
  const fill = mono ? t.text : t.accent;
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Path
        d="M20 2 L35 10 L35 30 L20 38 L5 30 L5 10 Z"
        stroke={stroke}
        strokeWidth={2.4}
        strokeLinejoin="round"
        fill="none"
      />
      <Rect x={13} y={15} width={14} height={3.2} rx={0.4} fill={fill} />
      <Rect x={13} y={21.8} width={14} height={3.2} rx={0.4} fill={fill} opacity={0.55} />
    </Svg>
  );
}

interface WordProps {
  t: Theme;
  size?: number;
  compact?: boolean;
}

export function AegisWord({ t, size = 22, compact = false }: WordProps) {
  return (
    <Text
      style={{
        fontFamily: t.fontDisplay,
        fontWeight: '500',
        fontSize: size,
        letterSpacing: -0.2,
        color: t.text,
        lineHeight: size * 1.05,
      }}
    >
      {compact ? 'Aegis' : 'AegisLink'}
    </Text>
  );
}
