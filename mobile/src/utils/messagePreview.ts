/**
 * Maps a raw message body (which may contain inline wire-format tags like
 * `[poll:…]`, `[image:…]`, `[file:name:…]`) to a friendly, human-readable
 * preview label for conversation lists. Plain text bodies pass through
 * unchanged.
 *
 * `t` is the i18next translation function (key, defaultValue). Defaults are
 * provided so the label is sensible even if a key is missing.
 */
import type { TFunction } from 'i18next';

export function previewLabel(
  body: string | undefined | null,
  t: TFunction,
): string {
  if (!body) return body ?? '';

  if (body.startsWith('[poll:') && body.endsWith(']')) {
    const inner = body.slice(6, -1);
    const question = inner.split('|')[0]?.trim();
    return `📊 ${question || t('attachSheet.poll', 'Poll')}`;
  }
  if (body.startsWith('[call:')) {
    // Wire format: [call:<status>:<media>:<duration>s]
    const parts = body.slice(1, -1).split(':');
    const status = parts[1] ?? 'missed';
    const media = parts[2] ?? 'audio';
    const icon = media === 'video' ? '📹' : '📞';
    if (status === 'missed') return `${icon} ${t('chat.missedCall', 'Llamada perdida')}`;
    if (status === 'declined') return `${icon} ${t('chat.declinedCall', 'Llamada rechazada')}`;
    return `${icon} ${media === 'video' ? t('chat.videoCall', 'Videollamada') : t('chat.voiceCall', 'Llamada de voz')}`;
  }
  if (body.startsWith('[join_request:')) {
    // Wire format: [join_request:<groupId>:<groupName>]
    const name = body.slice(14, -1).split(':')[1]?.trim();
    return `👥 ${t('chat.joinRequestPreview', 'Group join request')}${name ? ` · ${name}` : ''}`;
  }
  if (body.startsWith('[gif:')) return '🎞 GIF';
  if (body.startsWith('[sticker:')) return `🖼 ${t('attachSheet.sticker', 'Sticker')}`;
  if (body.startsWith('[image:')) return `📷 ${t('attachSheet.image', 'Image')}`;
  if (body.startsWith('[audio:')) return `🎙 ${t('attachSheet.audio', 'Audio')}`;
  if (body.startsWith('[viewonce:')) return `👁 ${t('attachSheet.viewOnce', 'View once')}`;
  if (body.startsWith('[location:')) return `📍 ${t('attachSheet.location', 'Location')}`;
  if (body.startsWith('[file:')) {
    // Wire format: [file:<name>:<blobUri>]
    const name = body.slice(6).split(':')[0]?.trim();
    return `📎 ${name || t('attachSheet.file', 'File')}`;
  }
  // Scheduled group post marker — appears at the start of the text portion,
  // possibly after the group sender prefix ("Sender: [post:gp]Hola").
  const postIdx = body.indexOf('[post:');
  if (postIdx !== -1 && (postIdx === 0 || body.slice(0, postIdx).endsWith(': '))) {
    const close = body.indexOf(']', postIdx);
    if (close !== -1 && /^[a-z]{0,8}$/.test(body.slice(postIdx + 6, close))) {
      return `📣 ${body.slice(0, postIdx)}${body.slice(close + 1)}`;
    }
  }
  return body;
}
