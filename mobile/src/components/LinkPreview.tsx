/**
 * LinkPreview — Open Graph card shown beneath a message that contains a URL.
 *
 * PRIVACY NOTE: The fetch is performed directly from the user's device, which
 * reveals their IP address to the destination server. This is equivalent to
 * what Signal does on iOS. A future improvement would proxy the request through
 * the AegisLink relay so the user's IP is never disclosed to external sites.
 *
 * Usage: <LinkPreview url="https://example.com" t={t} />
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, Image, Pressable, Linking } from 'react-native';
import type { Theme } from '../theme/vault';

interface Props {
  url: string;
  t: Theme;
}

interface OGData {
  title?: string;
  description?: string;
  image?: string;
}

// Matches <meta property="og:X" content="Y"> in either attribute order
const OG_TITLE_RE =
  /(?:<meta[^>]+property="og:title"[^>]+content="([^"]+)"|<meta[^>]+content="([^"]+)"[^>]+property="og:title")/i;
const OG_DESC_RE =
  /(?:<meta[^>]+property="og:description"[^>]+content="([^"]+)"|<meta[^>]+content="([^"]+)"[^>]+property="og:description")/i;
const OG_IMAGE_RE =
  /(?:<meta[^>]+property="og:image"[^>]+content="([^"]+)"|<meta[^>]+content="([^"]+)"[^>]+property="og:image")/i;

function extractOG(html: string): OGData {
  const titleM = OG_TITLE_RE.exec(html);
  const descM = OG_DESC_RE.exec(html);
  const imageM = OG_IMAGE_RE.exec(html);
  return {
    title: titleM?.[1] ?? titleM?.[2],
    description: descM?.[1] ?? descM?.[2],
    image: imageM?.[1] ?? imageM?.[2],
  };
}

export function LinkPreview({ url, t }: Props) {
  const [data, setData] = useState<OGData | null>(null);
  // Cache result to avoid re-fetching on every render
  const cacheRef = useRef<Record<string, OGData | 'error'>>({});

  useEffect(() => {
    let cancelled = false;

    const cached = cacheRef.current[url];
    if (cached) {
      if (cached !== 'error') setData(cached);
      return;
    }

    void (async () => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(5000),
          // Only need the first ~8 KB to find OG meta tags in <head>
          headers: { Range: 'bytes=0-8191' },
        });
        const html = await res.text();
        const og = extractOG(html);
        if (!og.title && !og.description) {
          cacheRef.current[url] = 'error';
          return;
        }
        cacheRef.current[url] = og;
        if (!cancelled) setData(og);
      } catch {
        cacheRef.current[url] = 'error';
      }
    })();

    return () => {
      cancelled = true;
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
