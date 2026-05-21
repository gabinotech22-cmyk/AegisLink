import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, FlatList, Pressable, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { useContacts } from '../store/contacts';
import type { StoredContact } from '../db/local';

interface Props {
  onBack: () => void;
  onAddContact: () => void;
  onOpenContact: (contact: StoredContact) => void;
  onChat: (contact: StoredContact) => void;
}

/**
 * Full contacts list. Distinct from Home (chats) — shows every contact you've
 * added, even if you've never messaged them. Threema-style:
 *  - search box at top
 *  - alphabetical by display name
 *  - avatar + name + aegisId + verified badge
 *  - tap row → ContactDetail
 *  - tap chat icon → open chat
 */
export function ContactsScreen({ onBack, onAddContact, onOpenContact, onChat }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const contacts = useContacts((s) => s.contacts);
  const hydrate = useContacts((s) => s.hydrate);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void hydrate();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...contacts].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    if (!q) return sorted;
    return sorted.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.aegisId.toLowerCase().includes(q)
    );
  }, [contacts, query]);

  // Group by first letter for section-style display
  const sections = useMemo(() => {
    const map = new Map<string, StoredContact[]>();
    for (const c of filtered) {
      const initial = (c.name.trim()[0] ?? '#').toUpperCase();
      const key = /^[A-Z]$/.test(initial) ? initial : '#';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('contacts.title')}
        big
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
        right={
          <Pressable onPress={onAddContact} hitSlop={8} style={{ padding: 4 }}>
            <I.Plus size={22} color={t.accent} />
          </Pressable>
        }
      />

      {/* Search */}
      <View
        style={{
          marginHorizontal: 18,
          marginTop: 4,
          marginBottom: 10,
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: t.surface2,
          borderRadius: 99,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <I.Search size={16} color={t.textDim} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={i18nT('contacts.searchPlaceholder')}
          placeholderTextColor={t.textFaint}
          style={{
            flex: 1,
            fontFamily: t.font,
            fontSize: 14,
            color: t.text,
            padding: 0,
          }}
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery('')} hitSlop={6}>
            <I.X size={14} color={t.textDim} />
          </Pressable>
        ) : null}
      </View>

      {/* Count */}
      <Text
        style={{
          fontFamily: t.fontMono,
          fontSize: 10,
          color: t.textDim,
          letterSpacing: 1.1,
          paddingHorizontal: 22,
          marginBottom: 8,
        }}
      >
        {i18nT(filtered.length === 1 ? 'contacts.contactCount_one' : 'contacts.contactCount_other', { count: filtered.length })}
      </Text>

      {filtered.length === 0 ? (
        <EmptyState t={t} hasContacts={contacts.length > 0} onAdd={onAddContact} />
      ) : (
        <FlatList
          data={sections}
          keyExtractor={([letter]) => letter}
          renderItem={({ item: [letter, rows] }) => (
            <View>
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 11,
                  color: t.accent,
                  letterSpacing: 1.4,
                  paddingHorizontal: 22,
                  paddingTop: 14,
                  paddingBottom: 6,
                }}
              >
                {letter}
              </Text>
              {rows.map((c, i) => (
                <ContactRow
                  key={c.aegisId}
                  t={t}
                  contact={c}
                  onPress={() => onOpenContact(c)}
                  onChat={() => onChat(c)}
                  noBorder={i === rows.length - 1}
                />
              ))}
            </View>
          )}
        />
      )}
    </View>
  );
}

function ContactRow({
  t,
  contact,
  onPress,
  onChat,
  noBorder,
}: {
  t: Theme;
  contact: StoredContact;
  onPress: () => void;
  onChat: () => void;
  noBorder: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: t.surface2 }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingVertical: 11,
        gap: 12,
        backgroundColor: pressed ? t.surface : 'transparent',
        borderBottomWidth: noBorder ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: t.divider,
      })}
    >
      <Avatar t={t} name={contact.avatarImage || contact.name} color={contact.color ?? t.surface2} size={42} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name) ? t.fontMono : t.font,
              fontSize: 15,
              fontWeight: '600',
              color: t.text,
              flexShrink: 1,
            }}
          >
            {contact.name}
          </Text>
          {contact.verified ? (
            <View
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: t.accent,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.Check size={9} color={t.accentInk} stroke={3} />
            </View>
          ) : null}
        </View>
        <Text
          numberOfLines={1}
          style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2, letterSpacing: 0.4 }}
        >
          {contact.aegisId}
        </Text>
      </View>
      <Pressable
        onPress={(e) => {
          e.stopPropagation?.();
          onChat();
        }}
        hitSlop={8}
        style={{ padding: 8 }}
      >
        <I.Chat size={18} color={t.accent} />
      </Pressable>
    </Pressable>
  );
}

function EmptyState({
  t,
  hasContacts,
  onAdd,
}: {
  t: Theme;
  hasContacts: boolean;
  onAdd: () => void;
}) {
  const { t: i18nT } = useTranslation();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundColor: t.surface,
          borderWidth: 1,
          borderColor: t.borderStrong,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
        }}
      >
        <I.Users size={32} color={t.textDim} />
      </View>
      <Text
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 20,
          fontWeight: '600',
          letterSpacing: -0.3,
          color: t.text,
          marginBottom: 8,
          textAlign: 'center',
        }}
      >
        {hasContacts ? i18nT('contacts.noResultsTitle') : i18nT('contacts.emptyTitle')}
      </Text>
      <Text
        style={{
          fontFamily: t.font,
          fontSize: 13,
          color: t.textDim,
          textAlign: 'center',
          lineHeight: 19,
          maxWidth: 280,
          marginBottom: 18,
        }}
      >
        {hasContacts ? i18nT('contacts.noResultsDesc') : i18nT('contacts.emptyDesc')}
      </Text>
      {!hasContacts ? (
        <Pressable
          onPress={onAdd}
          style={({ pressed }) => ({
            backgroundColor: t.accent,
            paddingHorizontal: 22,
            paddingVertical: 12,
            borderRadius: t.radius,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <I.Plus size={18} color={t.accentInk} />
          <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600', fontSize: 14 }}>
            {i18nT('contacts.addContact')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
