import { View, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../theme/vault';
import { I } from './icons';
import { useIdentity } from '../store/identity';

export type Tab = 'home' | 'groups' | 'verify' | 'settings' | 'dashboard';

interface Props {
  t: Theme;
  current: Tab;
  onChange: (tab: Tab) => void;
}

const WORK_ACCENT = '#6366f1';

const PERSONAL_ITEMS: { id: Tab; icon: keyof typeof I }[] = [
  { id: 'home',     icon: 'Chat'    },
  { id: 'groups',   icon: 'Users'   },
  { id: 'verify',   icon: 'QR'      },
  { id: 'settings', icon: 'Shield'  },
];

const WORK_ITEMS: { id: Tab; icon: keyof typeof I }[] = [
  { id: 'dashboard', icon: 'Building' },
  { id: 'groups',    icon: 'Users'    },
  { id: 'verify',    icon: 'QR'       },
  { id: 'settings',  icon: 'Shield'   },
];

export function TabBar({ t, current, onChange }: Props) {
  const insets = useSafeAreaInsets();
  const { t: i18nT } = useTranslation();
  const activeProfile = useIdentity((s) => s.activeProfile);
  const isWork = activeProfile === 'work';
  const activeColor = isWork ? WORK_ACCENT : t.accent;
  const items = isWork ? WORK_ITEMS : PERSONAL_ITEMS;

  const getTranslationKey = (id: Tab, isWorkProfile: boolean) => {
    if (id === 'home') return 'chats';
    if (id === 'groups') return isWorkProfile ? 'channels' : 'groups';
    if (id === 'verify') return 'verify';
    if (id === 'settings') return 'privacy';
    if (id === 'dashboard') return 'dashboard';
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
        borderTopWidth: isWork ? 2 : 1,
        borderTopColor: isWork ? `${WORK_ACCENT}55` : t.divider,
        backgroundColor: t.surface,
      }}
    >
      {items.map((it) => {
        const Icon = I[it.icon];
        const active = current === it.id;
        const translationKey = getTranslationKey(it.id, isWork);
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
