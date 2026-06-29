/**
 * ChannelsEmptyVisual — illustration for the "no channels yet" empty state.
 *
 * Channels are represented by the Globe throughout the app (channel rows, the
 * feed header, the create screen), so the empty state centers on that same
 * Globe — orbited by subscriber dots to read as a public broadcast space.
 * Same illustrative family as the Groups constellation and the Chats key-rings,
 * but its own motif so the three empty states stay distinct (never mixed).
 */
import { View } from 'react-native';
import Svg, { Ellipse, Circle } from 'react-native-svg';
import type { Theme } from '../theme/vault';
import { I } from './icons';

interface Props {
  t: Theme;
}

export function ChannelsEmptyVisual({ t }: Props) {
  return (
    <View style={{ width: 180, height: 140, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={180} height={140} viewBox="0 0 180 140" style={{ position: 'absolute' }}>
        {/* subscriber orbit */}
        <Ellipse cx={90} cy={70} rx={70} ry={42} fill="none" stroke={t.borderStrong} strokeWidth={1} strokeDasharray="3 5" />
        {/* subscribers on the orbit */}
        <Circle cx={20} cy={70} r={3.5} fill={t.accent} />
        <Circle cx={160} cy={70} r={3.5} fill={t.accent} />
        <Circle cx={90} cy={28} r={3} fill={t.accent} opacity={0.55} />
        <Circle cx={90} cy={112} r={3} fill={t.accent} opacity={0.55} />
      </Svg>
      {/* the channel itself — the Globe, same treatment as the feed/create header */}
      <View
        style={{
          width: 60,
          height: 60,
          borderRadius: 30,
          backgroundColor: `${t.accent}22`,
          borderWidth: 1.5,
          borderColor: t.accent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <I.Globe size={28} color={t.accent} />
      </View>
    </View>
  );
}
