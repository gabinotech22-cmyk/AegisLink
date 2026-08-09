import { View, Text, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { FloatingMenu, type FloatingMenuItem } from './FloatingMenu';
import { I } from './icons';
import { copySensitiveText } from '../utils/secureClipboard';

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
  /** Present only for an own message the outbox gave up on — offers a re-send. */
  onRetrySend?: () => void;
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
  onRetrySend,
}: MessageActionsSheetProps) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();

  async function handleCopy() {
    try {
      await copySensitiveText(body);
    } catch {/* ignore */}
    onCopy?.();
  }

  function handleReact(emoji: string) {
    onClose();
    onReact(emoji);
  }

  const items: FloatingMenuItem[] = [];

  // First entry when it applies: the message never left the device, so re-sending
  // it is the only action the user actually wants here.
  if (onRetrySend) {
    items.push({
      key: 'retrySend',
      icon: <I.RotateCW size={20} color={t.accent} />,
      label: i18nT('chat.retrySend'),
      onPress: onRetrySend,
    });
  }

  items.push(
    { key: 'reply', icon: <I.Reply size={20} color={t.textDim} />, label: i18nT('messageActions.reply'), onPress: onReply },
    { key: 'forward', icon: <I.Forward size={20} color={t.textDim} />, label: i18nT('messageActions.forward'), onPress: onForward },
  );

  if (body) {
    items.push({ key: 'copy', icon: <I.Copy size={20} color={t.textDim} />, label: i18nT('messageActions.copy'), onPress: () => void handleCopy() });
  }

  items.push({
    key: 'star',
    icon: <I.Star size={20} color={starred ? t.accent : t.textDim} />,
    label: starred ? i18nT('messageActions.unstar') : i18nT('messageActions.star'),
    onPress: onStar,
  });

  if (onPin) {
    items.push({
      key: 'pin',
      icon: <I.Pin size={20} color={pinned ? t.accent : t.textDim} />,
      label: pinned ? i18nT('messageActions.unpin') : i18nT('messageActions.pin'),
      onPress: onPin,
    });
  }

  if (canDelete) {
    items.push({
      key: 'delete',
      icon: <I.Trash size={20} color={t.danger} />,
      label: i18nT('messageActions.delete'),
      onPress: onDelete,
      danger: true,
    });
  }

  if (canDelete && onDeleteForAll) {
    items.push({
      key: 'deleteForAll',
      icon: <I.Trash size={20} color={t.danger} />,
      label: i18nT('messageActions.deleteForAll'),
      onPress: onDeleteForAll,
      danger: true,
    });
  }

  return (
    <FloatingMenu
      t={t}
      visible={visible}
      onClose={onClose}
      items={items}
      topContent={
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-around',
            paddingHorizontal: 10,
            paddingVertical: 8,
            margin: 12,
            backgroundColor: t.surface2,
            borderRadius: 99,
          }}
        >
          {QUICK_EMOJIS.map((emoji) => (
            <Pressable
              key={emoji}
              onPress={() => handleReact(emoji)}
              accessibilityRole="button"
              accessibilityLabel={`${i18nT('messageActions.react')}: ${emoji}`}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                borderRadius: 20,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? t.surface3 : 'transparent',
              })}
            >
              <Text style={{ fontSize: 24 }}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
      }
    />
  );
}
