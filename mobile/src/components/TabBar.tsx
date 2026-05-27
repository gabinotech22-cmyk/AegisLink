import { View, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../theme/vault';
import { I } from './icons';
import { useIdentity } from '../store/identity';

export type Tab = 'home' | 'groups' | 'settings';

interface Props {
  t: Theme;
  current: Tab;
  onChange: (tab: Tab) => void;
}

const PERSONAL_ITEMS: { id: Tab; icon: keyof typeof I }[] = [
  { id: 'home',     icon: 'Chat'    },
  { id: 'groups',   icon: 'Users'   },
  { id: 'settings', icon: 'Shield'  },
];

export function TabBar({ t, current, onChange }: Props) {
  const insets = useSafeAreaInsets();
  const { t: i18nT } = useTranslation();
  const activeColor = t.accent;
  const items = PERSONAL_ITEMS;

  const getTranslationKey = (id: Tab) => {
    if (id === 'home') return 'chats';
    if (id === 'groups') return 'groups';
    if (id === 'settings') return 'privacy';
    return 'chats';
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingHorizontal: 8,
        paddingTop: 10,
        paddingBottom: 10 + insets.bottom,
        borderTopWidth: 1,
        borderTopColor: t.divider,
        backgroundColor: t.surface,
      }}
    >
      {items.map((it) => {
        const Icon = I[it.icon];
        const active = current === it.id;
        const translationKey = getTranslationKey(it.id);
        const label = i18nT(`tabBar.${translationKey}`);
        
        return (
          <Pressable
            key={it.id}
            onPress={() => onChange(it.id)}
            hitSlop={6}
            style={{ alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8 }}
          >
            <Icon size={20} stroke={active ? 2.2 : 1.8} color={active ? activeColor : t.textFaint} />
            <Text
              style={{
                fontFamily: t.fontMono,
                fontSize: 9,
                letterSpacing: 0.8,
                fontWeight: active ? '600' : '400',
                color: active ? activeColor : t.textFaint,
              }}
            >
              {label.toUpperCase()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
