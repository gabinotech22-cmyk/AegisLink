/**
 * LinkPreview — Open Graph card shown beneath a message that contains a URL.
 *
 * PRIVACY: All fetches are proxied through the AegisLink relay via
 * /proxy/linkpreview — the user's IP is never disclosed to external sites.
 *
 * Usage: <LinkPreview url="https://example.com" t={t} />
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, Image, Pressable, Linking } from 'react-native';
import type { Theme } from '../theme/vault';
import { SERVER_URL } from '../config';

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
  const [data, setData] = useState<OGData | null>(null);
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
        const proxyUrl = `${SERVER_URL}/proxy/linkpreview?url=${encodeURIComponent(url)}`;
        const res = await fetch(proxyUrl, { signal: controller.signal });
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
          image: og.image ?? undefined,
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

      {/* Thumbnail */}
      {data.image ? (
        <Image
          source={{ uri: data.image }}
          style={{ width: 80, height: 80, backgroundColor: t.surface3 }}
          resizeMode="cover"
          accessibilityLabel={data.title ?? 'Preview image'}
        />
      ) : null}
    </Pressable>
  );
}
