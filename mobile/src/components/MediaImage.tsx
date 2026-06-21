import { useEffect, useState } from 'react';
import { Image, View, Text, ActivityIndicator, type ImageStyle, type StyleProp, type ImageResizeMode } from 'react-native';
import { resolveMediaDetailed } from '../crypto/media';

interface Props {
  /** A `blob:<id>:<key>:<nonce>` URI or a plain local file URI. */
  uri: string;
  /** File extension hint for the decrypted cache file (e.g. 'jpg', 'png', 'gif'). */
  ext?: string;
  style?: StyleProp<ImageStyle>;
  /** Spinner tint while decrypting. */
  accent?: string;
  resizeMode?: ImageResizeMode;
}

/**
 * Renders chat media from an encrypted-at-rest blob reference.
 *
 * For `blob:` URIs it decrypts on demand into the purgeable cache (via
 * resolveMedia) and shows a spinner meanwhile; if the media is unrecoverable
 * (no local ciphertext AND the server blob expired) it renders an empty
 * placeholder instead of a broken/gray <Image>. Plain local URIs render
 * directly. This is what lets images survive cache purges and app restarts
 * without ever persisting plaintext at rest.
 */
export function MediaImage({ uri, ext = 'jpg', style, accent, resizeMode = 'cover' }: Props) {
  const isBlob = uri.startsWith('blob:');
  const [local, setLocal] = useState<string | null>(isBlob ? null : uri);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!uri.startsWith('blob:')) {
      setLocal(uri);
      setExpired(false);
      return;
    }
    setLocal(null);
    setExpired(false);
    void resolveMediaDetailed(uri, ext).then((res) => {
      if (!alive) return;
      setLocal(res.path);
      setExpired(res.state === 'expired');
    });
    return () => {
      alive = false;
    };
  }, [uri, ext]);

  if (local) {
    return <Image source={{ uri: local }} style={style} resizeMode={resizeMode} />;
  }
  // B-7: the server's 24h blob TTL elapsed and no local ciphertext survives —
  // tell the user instead of spinning forever.
  if (expired) {
    return (
      <View
        accessibilityLabel="Attachment expired"
        style={[style as object, { alignItems: 'center', justifyContent: 'center', padding: 8 }]}
      >
        <Text style={{ color: accent ?? '#888', fontSize: 11, textAlign: 'center' }}>
          Adjunto expirado
        </Text>
      </View>
    );
  }
  return (
    <View style={[style as object, { alignItems: 'center', justifyContent: 'center' }]}>
      <ActivityIndicator color={accent} />
    </View>
  );
}
