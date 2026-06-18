import { useEffect, useState } from 'react';
import { View, Text, Pressable, FlatList, Modal, TextInput, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { useDistribution, type DistributionList } from '../store/distribution';
import { useContacts } from '../store/contacts';
import { themedAlert } from '../components/AlertHost';

interface Props {
  onBack: () => void;
  onOpenList: (list: DistributionList) => void;
}

export function DistributionListsScreen({ onBack, onOpenList }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { lists, hydrate, create, remove } = useDistribution();
  const { contacts } = useContacts();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  function toggleMember(aegisId: string) {
    setSelectedMembers((prev) =>
      prev.includes(aegisId) ? prev.filter((id) => id !== aegisId) : [...prev, aegisId]
    );
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      themedAlert('Name required', 'Please enter a name for this list.');
      return;
    }
    if (selectedMembers.length === 0) {
      themedAlert('No members', 'Select at least one contact.');
      return;
    }
    await create(name, selectedMembers);
    setCreating(false);
    setNewName('');
    setSelectedMembers([]);
  }

  function handleDelete(list: DistributionList) {
    themedAlert(
      `Delete "${list.name}"?`,
      'This will permanently remove this distribution list.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void remove(list.id),
        },
      ]
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title="Distribution Lists"
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }} accessibilityLabel="Go back">
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
        right={
          <Pressable
            onPress={() => setCreating(true)}
            hitSlop={8}
            style={{ padding: 4 }}
            accessibilityLabel="Create new distribution list"
          >
            <I.Plus size={22} color={t.accent} />
          </Pressable>
        }
      />

      {lists.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 40 }}>
          <I.Users size={36} color={t.textFaint} />
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text, textAlign: 'center' }}>
            No distribution lists
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, textAlign: 'center', lineHeight: 19 }}>
            Tap + to create a list and broadcast messages to multiple contacts at once.
          </Text>
          <Pressable
            onPress={() => setCreating(true)}
            accessibilityLabel="Create first distribution list"
            style={{
              paddingHorizontal: 22,
              paddingVertical: 11,
              backgroundColor: t.accent,
              borderRadius: t.radiusL,
              marginTop: 6,
            }}
          >
            <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.accentInk }}>
              Create List
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={lists}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 18, gap: 10 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onOpenList(item)}
              onLongPress={() => handleDelete(item)}
              accessibilityLabel={`${item.name}, ${item.members.length} members`}
              style={({ pressed }) => ({
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: t.radius,
                padding: 16,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: `${t.accent}18`,
                  borderWidth: 1,
                  borderColor: `${t.accent}33`,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <I.Broadcast size={20} color={t.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.text }}>
                  {item.name}
                </Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, marginTop: 3 }}>
                  {item.members.length} {item.members.length === 1 ? 'MEMBER' : 'MEMBERS'}
                </Text>
              </View>
              <I.Chevron size={16} color={t.textFaint} />
            </Pressable>
          )}
          ListFooterComponent={
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, textAlign: 'center', marginTop: 8, letterSpacing: 0.5 }}>
              LONG PRESS TO DELETE
            </Text>
          }
        />
      )}

      {/* Create modal */}
      <Modal visible={creating} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setCreating(false)}>
        <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + 8 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 18,
              paddingBottom: 14,
              borderBottomWidth: 1,
              borderBottomColor: t.border,
              gap: 12,
            }}
          >
            <Pressable onPress={() => setCreating(false)} hitSlop={8} style={{ padding: 4 }} accessibilityLabel="Cancel">
              <I.X size={22} color={t.textDim} />
            </Pressable>
            <Text style={{ flex: 1, fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', color: t.text }}>
              New Distribution List
            </Text>
            <Pressable
              onPress={() => void handleCreate()}
              hitSlop={8}
              style={{ padding: 4 }}
              accessibilityLabel="Save distribution list"
            >
              <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: t.accent }}>Save</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 18, gap: 14 }}>
            {/* Name input */}
            <View
              style={{
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: t.radius,
                paddingHorizontal: 14,
                paddingVertical: 4,
              }}
            >
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="List name…"
                placeholderTextColor={t.textFaint}
                style={{
                  fontFamily: t.font,
                  fontSize: 15,
                  color: t.text,
                  paddingVertical: 12,
                }}
                autoFocus
                returnKeyType="done"
                accessibilityLabel="Distribution list name"
              />
            </View>

            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.6, marginTop: 6 }}>
              SELECT MEMBERS
            </Text>

            {contacts.length === 0 ? (
              <View style={{ paddingVertical: 22, alignItems: 'center' }}>
                <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>
                  No contacts available.
                </Text>
              </View>
            ) : (
              contacts.map((contact) => {
                const isSelected = selectedMembers.includes(contact.aegisId);
                return (
                  <Pressable
                    key={contact.aegisId}
                    onPress={() => toggleMember(contact.aegisId)}
                    accessibilityLabel={`${isSelected ? 'Deselect' : 'Select'} ${contact.name}`}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      padding: 14,
                      backgroundColor: isSelected ? `${t.accent}12` : t.surface,
                      borderWidth: 1,
                      borderColor: isSelected ? `${t.accent}44` : t.border,
                      borderRadius: t.radiusS,
                      opacity: pressed ? 0.8 : 1,
                    })}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        borderWidth: 2,
                        borderColor: isSelected ? t.accent : t.borderStrong,
                        backgroundColor: isSelected ? t.accent : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isSelected ? <I.Check size={12} color={t.accentInk} /> : null}
                    </View>
                    <Text style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: t.text }}>
                      {contact.name}
                    </Text>
                    <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.3 }}>
                      {contact.aegisId.slice(0, 8)}…
                    </Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
