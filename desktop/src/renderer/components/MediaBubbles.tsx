/**
 * The media inside a chat bubble: image, video, a downloadable file and an
 * album. Each takes the stored media reference (a `blob:` wire URI, decrypted
 * on demand by `hooks/useMediaUrl`) and shows a placeholder while it loads, or
 * "attachment expired" once the relay's 24 h copy is gone.
 */
import i18n from '../i18n';
import type { Theme } from '../theme/vault';
import { I } from './icons';
import { useMediaUrl, resolveMediaUrl, type MediaState } from '../hooks/useMediaUrl';
import { parseMultiPayload, type AlbumItem } from '../utils/incomingMedia';

const IMAGE_W = 220;
const IMAGE_H = 180;

function Placeholder({ t, state, w, h }: { t: Theme; state: MediaState; w: number; h: number }) {
  const label =
    state === 'expired' ? i18n.t('chat.attachmentExpired')
      : state === 'error' ? i18n.t('chat.attachmentUnavailable')
        : i18n.t('chat.attachmentLoading');
  return (
    <div
      role="img"
      aria-label={label}
      style={{ width: w, height: h, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8, boxSizing: 'border-box' }}
    >
      <span style={{ fontFamily: t.fontMono, fontSize: 11, color: state === 'loading' ? t.textDim : t.danger, textAlign: 'center' }}>{label}</span>
    </div>
  );
}

export function MediaImage({ t, uri, w = IMAGE_W, h = IMAGE_H }: { t: Theme; uri: string | null | undefined; w?: number; h?: number }) {
  const { url, state } = useMediaUrl(uri);
  if (!url) return <Placeholder t={t} state={state} w={w} h={h} />;
  return <img src={url} alt={i18n.t('chat.imageMessage')} style={{ width: w, height: h, objectFit: 'cover', display: 'block', backgroundColor: t.surface2 }} />;
}

export function MediaVideo({ t, uri }: { t: Theme; uri: string | null | undefined }) {
  const { url, state } = useMediaUrl(uri, 'video/mp4');
  if (!url) return <Placeholder t={t} state={state} w={IMAGE_W} h={IMAGE_H} />;
  return <video src={url} controls preload="metadata" aria-label={i18n.t('chat.videoMessage')} style={{ width: IMAGE_W, maxHeight: 320, display: 'block', backgroundColor: '#000' }} />;
}

/**
 * A received or sent file: click to decrypt it and save it through the
 * browser's download (Electron shows the save dialog). The name comes from the
 * sender, so only its last path segment is used.
 */
export function FileRow({ t, uri, name, color }: { t: Theme; uri: string | null | undefined; name: string; color: string }) {
  const safeName = name.split(/[\\/]/).pop()?.trim() || 'file';
  async function save() {
    if (!uri) return;
    try {
      const url = await resolveMediaUrl(uri);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName;
      a.rel = 'noopener';
      a.click();
    } catch (e) {
      window.alert(e instanceof Error && e.message === 'attachment_expired'
        ? i18n.t('chat.attachmentExpired')
        : i18n.t('chat.attachmentUnavailable'));
    }
  }
  return (
    <button
      onClick={() => void save()}
      disabled={!uri}
      aria-label={i18n.t('chat.downloadFile', { name: safeName })}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, background: 'none', border: 'none', padding: 0, cursor: uri ? 'pointer' : 'default', color }}
    >
      <I.Attach size={20} color={color} />
      <span style={{ color, fontFamily: t.font, fontSize: 14, textAlign: 'left', wordBreak: 'break-word' }}>{safeName}</span>
      {uri && <I.Download size={16} color={color} />}
    </button>
  );
}

/** An album (`[multi:N]…`): images and videos in a grid, other items listed below. */
export function MediaAlbum({ t, mediaUri, color }: { t: Theme; mediaUri: string | null | undefined; color: string }) {
  const parsed = mediaUri ? parseMultiPayload(mediaUri) : null;
  if (!parsed) return <Placeholder t={t} state="error" w={IMAGE_W} h={80} />;
  const visual = parsed.attachments.filter((a) => a.type === 'image' || a.type === 'video');
  const other = parsed.attachments.filter((a) => a.type === 'audio' || a.type === 'file');
  const cell = visual.length === 1 ? IMAGE_W : (IMAGE_W - 4) / 2;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: IMAGE_W }}>
      {visual.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {visual.map((a, i) => <AlbumCell key={i} t={t} item={a} size={cell} />)}
        </div>
      )}
      {other.map((a, i) => (
        <div key={i} style={{ padding: '6px 8px' }}>
          <FileRow t={t} uri={a.uri} name={a.type === 'file' ? a.fileName ?? 'file' : `audio-${i + 1}.m4a`} color={color} />
        </div>
      ))}
    </div>
  );
}

function AlbumCell({ t, item, size }: { t: Theme; item: AlbumItem; size: number }) {
  return item.type === 'video'
    ? <MediaVideo t={t} uri={item.uri} />
    : <MediaImage t={t} uri={item.uri} w={size} h={size} />;
}
