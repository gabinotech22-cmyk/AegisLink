/**
 * ShareLinkSheet — Vault-styled floating window for sharing an invite/identity
 * link. Replaces the foreign-looking native OS share sheet as the PRIMARY
 * surface: a dark FloatingMenu card showing the link with an inline copy
 * control. The native share picker is only invoked when the user explicitly
 * taps "Share via app…", so the in-app experience matches the prototype
 * (same chrome as the long-press reactions menu).
 */

import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../theme/ThemeContext';
import { FloatingMenu, type FloatingMenuItem } from './FloatingMenu';
import { I } from './icons';

export interface ShareLinkSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The full link to share/copy. */
  link: string;
  /** Header title, e.g. "Share invite link". */
  title?: string;
  /** Optional message prepended when sharing via the native picker. */
  shareMessage?: string;
}

export function ShareLinkSheet({ visible, onClose, link, title, shareMessage }: ShareLinkSheetProps) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await Clipboard.setStringAsync(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {/* ignore */}
  }

  async function shareNative() {
    try {
      await Share.share({ message: shareMessage ? `${shareMessage}\n${link}` : link, url: link });
    } catch {/* user cancelled */}
  }

  const items: FloatingMenuItem[] = [
    {
      key: 'copy',
      icon: <I.Copy size={20} color={t.textDim} />,
      label: i18nT('shareLink.copy', 'Copy link'),
      onPress: () => void copy(),
    },
    {
      key: 'share',
      icon: <I.Send size={20} color={t.textDim} />,
      label: i18nT('shareLink.shareVia', 'Share via app…'),
      onPress: () => void shareNative(),
    },
  ];

  return (
    <FloatingMenu
      t={t}
      visible={visible}
      onClose={onClose}
      title={title ?? i18nT('shareLink.title', 'Sharing link')}
      items={items}
      topContent={
        <Pressable
          onPress={() => void copy()}
          accessibilityRole="button"
          accessibilityLabel={i18nT('shareLink.copy', 'Copy link')}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            margin: 14,
            padding: 12,
            borderRadius: t.radius,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: pressed ? t.surface2 : t.bg,
          })}
        >
          <Text
            numberOfLines={2}
            style={{ flex: 1, fontFamily: t.fontMono, fontSize: 12, color: t.text, lineHeight: 17 }}
          >
            {link}
          </Text>
          {copied ? (
            <I.Check size={18} color={t.accent} />
          ) : (
            <I.Copy size={18} color={t.textDim} />
          )}
        </Pressable>
      }
    />
  );
}
