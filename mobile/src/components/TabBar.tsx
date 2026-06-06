import { View, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../theme/vault';
import { I } from './icons';
import { useIdentity } from '../store/identity';
import { useMessages } from '../store/messages';

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

  // Aggregate unread counts so each tab shows a badge for activity the user
  // can't see from another tab. Group conversations use a `group_` id prefix;
  // everything else is a 1:1 chat.
  const unreadCounts = useMessages((s) => s.unreadCounts);
  let homeUnread = 0;
  let groupsUnread = 0;
  for (const [chatId, count] of Object.entries(unreadCounts)) {
    if (!count) continue;
    if (chatId.startsWith('group_')) groupsUnread += count;
    else homeUnread += count;
  }
  const badgeFor = (id: Tab) => (id === 'home' ? homeUnread : id === 'groups' ? groupsUnread : 0);

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
            <View>
              <Icon size={20} stroke={active ? 2.2 : 1.8} color={active ? activeColor : t.textFaint} />
              {badgeFor(it.id) > 0 && (
                <View
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: -10,
                    minWidth: 16,
                    height: 16,
                    borderRadius: 8,
                    paddingHorizontal: 4,
                    backgroundColor: t.accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 1.5,
                    borderColor: t.surface,
                  }}
                >
                  <Text style={{ fontFamily: t.fontMono, fontSize: 9, fontWeight: '700', color: t.accentInk }}>
                    {badgeFor(it.id) > 99 ? '99+' : badgeFor(it.id)}
                  </Text>
                </View>
              )}
            </View>
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
