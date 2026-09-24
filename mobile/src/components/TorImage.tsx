/**
 * TorImage — `<Image>` for REMOTE images (GIF picker thumbnails, link-preview
 * images, legacy `[gif:url]` bubbles). React Native's image loader fetches a
 * `uri` itself, outside Tor, which leaks the device IP to whoever serves the
 * image. This downloads it over Tor first (net/torMedia.ts) and renders the
 * local file. Shows the style's background (placeholder) until then, or forever
 * if the image cannot be fetched over Tor. It never falls back to a direct load.
 */
import React, { useEffect, useState } from 'react';
import { Image, View, type ImageStyle, type StyleProp } from 'react-native';
import { torCachedImage } from '../net/torMedia';

interface Props {
  uri: string;
  style?: StyleProp<ImageStyle>;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'center';
}

export function TorImage({ uri, style, resizeMode }: Props) {
  const [local, setLocal] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLocal(null);
    void torCachedImage(uri).then((file) => { if (alive) setLocal(file); });
    return () => { alive = false; };
  }, [uri]);

  if (!local) return <View style={style} />;
  return <Image source={{ uri: local }} style={style} resizeMode={resizeMode} />;
}
