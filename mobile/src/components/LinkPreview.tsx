/**
 * LinkPreview — Open Graph card shown beneath a message that contains a URL.
 *
 * PRIVACY: The page's HTML (title/description) is fetched through the relay via
 * /proxy/linkpreview — the user's IP never reaches the site for that. The
 * `og:image` is NOT loaded automatically: its URL is chosen by whoever sent the
 * link, so auto-loading it would hand that party the reader's IP, the exact
 * moment the message was read and the device's user agent — a tracking pixel
 * (audit 2026-09-16 AL-05). The card shows a tap-to-load tile instead; the
 * image is fetched only on an explicit gesture, after telling the user what
 * that reveals.
 *
 * Usage: <LinkPreview url="https://example.com" t={t} />
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../theme/vault';
import { isSecureUrl } from '../config';
import { homeRelayBaseUrl } from '../net/homeRelay';
import { relayFetch } from '../net/relayHttp';
import { TorImage } from './TorImage';

interface Props {
  url: string;
  t: Theme;
}

interface OGData {
  title?: string;
  description?: string;
  image?: string;
}

// In-memory cache shared across all LinkPreview instances in the component tree
const cache = new Map<string, OGData | 'error'>();

export function LinkPreview({ url, t }: Props) {
  const { t: i18nT } = useTranslation();
  const [data, setData] = useState<OGData | null>(null);
  // Explicit opt-in per card; never persisted, never inferred.
  const [showImage, setShowImage] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const cached = cache.get(url);
    if (cached) {
      if (cached !== 'error') setData(cached);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    void (async () => {
      try {
        const proxyUrl = `${homeRelayBaseUrl()}/proxy/linkpreview?url=${encodeURIComponent(url)}`;
        const res = await relayFetch(proxyUrl, { signal: controller.signal });
        if (!res.ok) {
          cache.set(url, 'error');
          return;
        }
        const og = await res.json() as { title: string | null; description: string | null; image: string | null };
        if (!og.title && !og.description) {
          cache.set(url, 'error');
          return;
        }
        const ogData: OGData = {
          title: og.title ?? undefined,
          description: og.description ?? undefined,
          // Drop a cleartext preview image in production (MITM/privacy) — show
          // the text preview without it rather than loading http:// content.
          image: isSecureUrl(og.image) ? (og.image ?? undefined) : undefined,
        };
        cache.set(url, ogData);
        if (!cancelledRef.current) setData(ogData);
      } catch {
        cache.set(url, 'error');
      } finally {
        clearTimeout(timer);
      }
    })();

    return () => {
      cancelledRef.current = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [url]);

  if (!data) return null;

  return (
    <Pressable
      onPress={() => Linking.openURL(url).catch(() => {})}
      accessibilityRole="link"
      accessibilityLabel={data.title ?? url}
      style={({ pressed }) => ({
        flexDirection: 'row',
        marginTop: 8,
        borderRadius: 8,
        overflow: 'hidden',
        backgroundColor: t.surface2,
        borderWidth: 1,
        borderColor: t.border,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {/* Accent stripe */}
      <View style={{ width: 3, backgroundColor: t.accent }} />

      {/* Content */}
      <View style={{ flex: 1, padding: 8, gap: 2 }}>
        {data.title ? (
          <Text
            numberOfLines={2}
            style={{ fontFamily: t.font, fontSize: 13, fontWeight: '700', color: t.text }}
          >
            {data.title}
          </Text>
        ) : null}
        {data.description ? (
          <Text
            numberOfLines={2}
            style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, lineHeight: 15 }}
          >
            {data.description}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, marginTop: 2 }}
        >
          {url}
        </Text>
      </View>

      {/* Thumbnail — remote bytes only after an explicit tap (AL-05). */}
      {data.image ? (
        showImage ? (
          <View accessibilityLabel={data.title ?? 'Preview image'}>
            <TorImage
              uri={data.image}
              style={{ width: 80, height: 80, backgroundColor: t.surface3 }}
              resizeMode="cover"
            />
          </View>
        ) : (
          <Pressable
            onPress={() => setShowImage(true)}
            accessibilityRole="button"
            accessibilityLabel={i18nT('chat.previewShowImage', 'Show image')}
            accessibilityHint={i18nT('chat.previewImageHint', 'Loads from the sender’s site and reveals your IP to it')}
            testID="link-preview-show-image"
            style={{
              width: 80,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: t.surface3,
              paddingHorizontal: 6,
            }}
          >
            <Text
              numberOfLines={2}
              style={{ fontFamily: t.font, fontSize: 10, color: t.textDim, textAlign: 'center' }}
            >
              {i18nT('chat.previewShowImage', 'Show image')}
            </Text>
          </Pressable>
        )
      ) : null}
    </Pressable>
  );
}
