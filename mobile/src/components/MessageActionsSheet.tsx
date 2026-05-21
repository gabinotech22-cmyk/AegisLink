import { Modal, View, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from './icons';
import * as Clipboard from 'expo-clipboard';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export interface MessageActionsSheetProps {
  visible: boolean;
  /** The text body (already decrypted). Used for copy. */
  body: string;
  starred: boolean;
  pinned?: boolean;
  /** Whether the user can delete (own message). */
  canDelete: boolean;
  onClose: () => void;
  onReply: () => void;
  onForward: () => void;
  onCopy?: () => void;
  onStar: () => void;
  onPin?: () => void;
  onDelete: () => void;
  onDeleteForAll?: () => void;
  onReact: (emoji: string) => void;
}

export function MessageActionsSheet({
  visible,
  body,
  starred,
  pinned,
  canDelete,
  onClose,
  onReply,
  onForward,
  onStar,
  onPin,
  onDelete,
  onDeleteForAll,
  onReact,
  onCopy,
}: MessageActionsSheetProps) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();

  async function handleCopy() {
    try {
      await Clipboard.setStringAsync(body);
    } catch {/* ignore */}
    onCopy?.();
    onClose();
  }

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable
          onPress={onClose}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation?.()}
          style={{
            backgroundColor: t.surface,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderTopWidth: 1,
            borderColor: t.borderStrong,
            paddingTop: 10,
            paddingBottom: 8 + insets.bottom,
          }}
        >
          <View style={{ alignItems: 'center', paddingBottom: 10 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.surface3 }} />
          </View>

          {/* Quick reactions row */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-around',
              paddingHorizontal: 14,
              paddingVertical: 10,
              marginHorizontal: 14,
              marginBottom: 6,
              backgroundColor: t.surface2,
              borderRadius: 99,
            }}
          >
            {QUICK_EMOJIS.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => { onReact(emoji); onClose(); }}
                hitSlop={8}
                style={({ pressed }) => ({
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? t.surface3 : 'transparent',
                })}
              >
                <Text style={{ fontSize: 26 }}>{emoji}</Text>
              </Pressable>
            ))}
          </View>

          <ActionRow t={t} icon={<I.Reply size={20} color={t.text} />} label={i18nT('messageActions.reply')} onPress={() => { onReply(); onClose(); }} />
          <ActionRow t={t} icon={<I.Forward size={20} color={t.text} />} label={i18nT('messageActions.forward')} onPress={() => { onForward(); onClose(); }} />
          {body ? (
            <ActionRow t={t} icon={<I.Copy size={20} color={t.text} />} label={i18nT('messageActions.copy')} onPress={handleCopy} />
          ) : null}
          <ActionRow
            t={t}
            icon={<I.Star size={20} color={starred ? t.accent : t.text} />}
            label={starred ? i18nT('messageActions.unstar') : i18nT('messageActions.star')}
            onPress={() => { onStar(); onClose(); }}
          />
          {onPin ? (
            <ActionRow
              t={t}
              icon={<I.Pin size={20} color={pinned ? t.accent : t.text} />}
              label={pinned ? i18nT('messageActions.unpin') : i18nT('messageActions.pin')}
              onPress={() => { onPin(); onClose(); }}
            />
          ) : null}
          {canDelete ? (
            <ActionRow
              t={t}
              icon={<I.Trash size={20} color={t.danger} />}
              label={i18nT('messageActions.delete')}
              danger
              onPress={() => { onDelete(); onClose(); }}
            />
          ) : null}
          {canDelete && onDeleteForAll ? (
            <ActionRow
              t={t}
              icon={<I.Trash size={20} color={t.danger} />}
              label={i18nT('messageActions.deleteForAll')}
              danger
              onPress={() => { onDeleteForAll(); onClose(); }}
              noBorder
            />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionRow({
  t,
  icon,
  label,
  onPress,
  danger,
  noBorder,
}: {
  t: Theme;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  danger?: boolean;
  noBorder?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: t.surface2 }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: 22,
        paddingVertical: 14,
        backgroundColor: pressed ? t.surface2 : 'transparent',
        borderTopWidth: noBorder ? 0 : undefined,
        borderTopColor: t.divider,
      })}
    >
      {icon}
      <Text style={{ fontFamily: t.font, fontSize: 15, color: danger ? t.danger : t.text, fontWeight: '500' }}>
        {label}
      </Text>
    </Pressable>
  );
}
