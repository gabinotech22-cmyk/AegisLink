/**
 * ConstellationVisual — decorative SVG used in empty states (Groups, Channels).
 * Extracted from Groups.tsx for reuse across panels.
 */

import Svg, { Circle, Line, G, Path } from 'react-native-svg';
import type { Theme } from '../theme/vault';

interface Props {
  t: Theme;
}

export function ConstellationVisual({ t }: Props) {
  return (
    <Svg viewBox="0 0 180 140" width={180} height={140}>
      <Line x1={50} y1={40} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <Line x1={130} y1={40} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <Line x1={40} y1={100} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <Line x1={140} y1={100} x2={90} y2={70} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="2 4" />
      <Circle cx={50} cy={40} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <Circle cx={130} cy={40} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <Circle cx={40} cy={100} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <Circle cx={140} cy={100} r={14} fill={t.surface} stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 3" />
      <Circle cx={90} cy={70} r={22} fill={`${t.accent}22`} stroke={t.accent} strokeWidth={1.5} />
      <G x={78} y={58}>
        <Path
          d="M12 0 L21 6 L21 18 L12 24 L3 18 L3 6 Z"
          fill="none"
          stroke={t.accent}
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </G>
    </Svg>
  );
}
