/**
 * GroupPostsScreen — compositor + cola de posts programados de grupo.
 *
 * Port scoped de mobile/src/screens/GroupPosts.tsx — primer release cubre el
 * 80% del flujo: texto + imagen opcional (EXIF eliminado vía canvas re-encode)
 * + chips de scheduling + 4 toggles de flags + "Enviar ahora" + cola con
 * cancelación. Queda fuera del MVP: file attachment, poll, link URL,
 * repeat-weekly, edit-in-place. Cada uno será un follow-up.
 *
 * Permiso: solo admin/dueño y moderadores (`canScheduleGroupPost`).
 * Wire-format: `[image:data:…][post:flags]Texto` — idéntico a mobile, así un
 * miembro mobile ve la misma announcement card.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useIdentity } from '../store/identity';
import { useGroups } from '../store/groups';
import {
  loadGroupPosts,
  saveGroupPosts,
  canScheduleGroupPost,
  type ScheduledGroupPost,
} from '../store/scheduled';
import type { GroupPostMeta } from '../utils/groupPost';
import type { StoredGroup } from '../db/local';

interface Props {
  group: StoredGroup;
  onBack: () => void;
}

type WhenChip = '1h' | 'today' | 'tomorrow' | 'custom' | 'now';

const MAX_IMAGE_PX = 1280;
const JPEG_QUALITY = 0.85;

function pad(n: number): string { return String(n).padStart(2, '0'); }

function chipSendAt(chip: WhenChip, customTs: number | null): number {
  const now = new Date();
  if (chip === 'now') return Date.now();
  if (chip === '1h') return Date.now() + 60 * 60 * 1000;
  if (chip === 'today') { const d = new Date(now); d.setHours(18, 0, 0, 0); return d.getTime(); }
  if (chip === 'tomorrow') { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }
  return customTs ?? Date.now() + 60 * 60 * 1000;
}

function formatWhenBig(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date) =>
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, now)) return `Today · ${hm}`;
  if (sameDay(d, tomorrow)) return `Tomorrow · ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} · ${hm}`;
}

function formatQueueWhen(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Re-encode the picked image into JPEG to strip ALL EXIF/GPS, capped at 1280px. */
async function stripExifAndShrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > MAX_IMAGE_PX || height > MAX_IMAGE_PX) {
          const r = Math.min(MAX_IMAGE_PX / width, MAX_IMAGE_PX / height);
          width = Math.round(width * r); height = Math.round(height * r);
        }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas_unavailable')); return; }
        ctx.drawImage(img, 0, 0, width, height);
        // toDataURL is synchronous and returns a JPEG that has no EXIF
        // (canvas → toDataURL never copies source metadata).
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      };
      img.onerror = () => reject(new Error('image_decode_failed'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

export function GroupPostsScreen({ group: groupProp, onBack }: Props) {
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);
  const group = useGroups((s) => s.groups.find((g) => g.id === groupProp.id)) ?? groupProp;
  const canPost = canScheduleGroupPost(group, identity?.aegisId);

  const [tab, setTab] = useState<'compose' | 'queue'>('compose');
  const [text, setText] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [when, setWhen] = useState<WhenChip>('tomorrow');
  const [customTs, setCustomTs] = useState<number | null>(null);
  const [asGroup, setAsGroup] = useState(true);
  const [pinned, setPinned] = useState(false);
  const [silent, setSilent] = useState(false);
  const [repliesOff, setRepliesOff] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Local snapshot of the persisted queue so deletions reflect immediately.
  const [queue, setQueue] = useState<ScheduledGroupPost[]>([]);
  useEffect(() => {
    setQueue(loadGroupPosts().filter((p) => p.groupId === group.id));
  }, [group.id, tab]);

  const sendAt = useMemo(() => chipSendAt(when, customTs), [when, customTs]);

  async function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setProcessing(true);
    try {
      const dataUrl = await stripExifAndShrink(file);
      setImageDataUrl(dataUrl);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setProcessing(false);
    }
  }

  function handleSchedule() {
    if (!canPost) {
      setErrorMsg('Only the group owner and moderators can publish announcements.');
      return;
    }
    const body = text.trim();
    if (!body && !imageDataUrl) {
      setErrorMsg('Write something or attach an image.');
      return;
    }
    setErrorMsg(null);

    const options: GroupPostMeta = {
      asGroup,
      pinned,
      silent,
      repliesOff,
    };

    const item: ScheduledGroupPost = {
      id: crypto.randomUUID(),
      groupId: group.id,
      groupName: group.name ?? '',
      text: body,
      options,
      imageDataUrl: imageDataUrl ?? undefined,
      sendAt,
    };

    const next = [...loadGroupPosts(), item];
    saveGroupPosts(next);
    setQueue(next.filter((p) => p.groupId === group.id));

    // Reset compose state
    setText('');
    setImageDataUrl(null);
    setPinned(false);
    setSilent(false);
    setRepliesOff(false);
    setWhen('tomorrow');
    setCustomTs(null);
    setTab('queue');
  }

  function handleCancel(id: string) {
    const next = loadGroupPosts().filter((p) => p.id !== id);
    saveGroupPosts(next);
    setQueue(next.filter((p) => p.groupId === group.id));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title={`${group.name ?? 'Group'} · Announcements`}
        left={
          <button onClick={onBack} aria-label="Go back" style={iconBtn}>
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
      />

      {/* Tab switcher */}
      <div style={{ display: 'flex', flexDirection: 'row', padding: '12px 18px 0', gap: 8, flexShrink: 0 }}>
        {(['compose', 'queue'] as const).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-label={id === 'compose' ? 'Compose tab' : 'Queue tab'}
            style={{
              padding: '8px 16px',
              backgroundColor: tab === id ? t.surface2 : 'transparent',
              border: `1px solid ${tab === id ? t.accent : t.border}`,
              borderRadius: t.radiusS,
              cursor: 'pointer',
              fontFamily: t.fontMono,
              fontSize: 11,
              letterSpacing: 0.6,
              color: tab === id ? t.accent : t.textDim,
            }}
          >
            {id === 'compose' ? 'COMPOSE' : `QUEUE (${queue.length})`}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
        {!canPost && (
          <div
            style={{
              padding: 14,
              backgroundColor: `${t.warn}10`,
              border: `1px solid ${t.warn}33`,
              borderRadius: t.radius,
              marginBottom: 14,
            }}
          >
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.warn, lineHeight: '18px' }}>
              Only the group owner and moderators can publish announcements. You can view the queue but cannot schedule new posts.
            </span>
          </div>
        )}

        {tab === 'compose' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* "Publish as" toggle */}
            <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
              <button
                onClick={() => setAsGroup(true)}
                aria-label="Publish as group"
                style={publishAsBtn(t, asGroup)}
              >
                AS GROUP
              </button>
              <button
                onClick={() => setAsGroup(false)}
                aria-label="Publish as you"
                style={publishAsBtn(t, !asGroup)}
              >
                AS YOU
              </button>
            </div>

            {/* Text area */}
            <div style={cardStyle(t)}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Write your announcement…"
                disabled={!canPost}
                aria-label="Announcement text"
                style={{
                  fontFamily: t.font,
                  fontSize: 15,
                  color: t.text,
                  width: '100%',
                  minHeight: 120,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  resize: 'vertical',
                  padding: 0,
                }}
              />
            </div>

            {/* Image picker */}
            {imageDataUrl ? (
              <div
                style={{
                  position: 'relative',
                  width: 'fit-content',
                  borderRadius: t.radiusS,
                  overflow: 'hidden',
                  border: `1px solid ${t.border}`,
                }}
              >
                <img
                  src={imageDataUrl}
                  alt="staged"
                  style={{ display: 'block', maxWidth: 240, maxHeight: 180, objectFit: 'cover' }}
                />
                <button
                  onClick={() => setImageDataUrl(null)}
                  aria-label="Remove image"
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    backgroundColor: 'rgba(0,0,0,0.65)',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <I.X size={14} color="#fff" />
                </button>
                <span
                  style={{
                    position: 'absolute',
                    left: 8,
                    bottom: 8,
                    backgroundColor: `${t.accent}cc`,
                    padding: '3px 8px',
                    borderRadius: 4,
                    fontFamily: t.fontMono,
                    fontSize: 9,
                    color: t.accentInk,
                    letterSpacing: 0.5,
                  }}
                >
                  EXIF STRIPPED
                </span>
              </div>
            ) : (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 14,
                  border: `1px dashed ${t.border}`,
                  borderRadius: t.radius,
                  cursor: canPost ? 'pointer' : 'not-allowed',
                  opacity: canPost ? 1 : 0.5,
                }}
              >
                <I.Image size={18} color={t.textDim} />
                <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>
                  {processing ? 'Processing image…' : 'Attach image (optional)'}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  disabled={!canPost || processing}
                  onChange={(e) => void handleImageFile(e)}
                  style={{ display: 'none' }}
                />
              </label>
            )}

            {/* Schedule chips */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.6 }}>
                WHEN
              </span>
              <div style={{ display: 'flex', flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {(['now', '1h', 'today', 'tomorrow', 'custom'] as const).map((id) => (
                  <button
                    key={id}
                    onClick={() => setWhen(id)}
                    aria-label={`Send ${id}`}
                    style={chipStyle(t, when === id)}
                  >
                    {id === 'now' ? 'NOW' : id === '1h' ? 'IN 1H' : id === 'today' ? 'TODAY 18:00' : id === 'tomorrow' ? 'TOMORROW 09:00' : 'CUSTOM'}
                  </button>
                ))}
              </div>
              {when === 'custom' && (
                <input
                  type="datetime-local"
                  value={customTs ? toLocalInputValue(customTs) : ''}
                  onChange={(e) => {
                    const ms = new Date(e.target.value).getTime();
                    setCustomTs(Number.isFinite(ms) ? ms : null);
                  }}
                  aria-label="Custom date and time"
                  style={{
                    padding: '10px 12px',
                    backgroundColor: t.surface,
                    border: `1px solid ${t.border}`,
                    borderRadius: t.radiusS,
                    fontFamily: t.font,
                    fontSize: 13,
                    color: t.text,
                    outline: 'none',
                    width: 240,
                  }}
                />
              )}
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.5 }}>
                SCHEDULED FOR {formatWhenBig(sendAt).toUpperCase()}
              </span>
            </div>

            {/* Options toggles */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.6 }}>
                OPTIONS
              </span>
              <OptionRow t={t} label="Pin announcement" sub="Highlights the post at the top of the chat." on={pinned} onChange={setPinned} />
              <OptionRow t={t} label="Silent" sub="Receivers see the post but no notification banner." on={silent} onChange={setSilent} />
              <OptionRow t={t} label="Replies disabled" sub="Read-only announcement (display hint only)." on={repliesOff} onChange={setRepliesOff} />
            </div>

            {errorMsg && (
              <div style={{ padding: '8px 12px', backgroundColor: `${t.danger}22`, borderRadius: t.radiusS }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger }}>{errorMsg}</span>
              </div>
            )}

            <button
              onClick={handleSchedule}
              disabled={!canPost}
              aria-label="Schedule announcement"
              style={{
                padding: '14px 0',
                backgroundColor: canPost ? t.accent : t.surface2,
                border: 'none',
                borderRadius: t.radiusL,
                cursor: canPost ? 'pointer' : 'not-allowed',
                fontFamily: t.font,
                fontSize: 15,
                fontWeight: '600',
                color: canPost ? t.accentInk : t.textFaint,
              }}
            >
              {when === 'now' ? 'Publish now' : 'Schedule announcement'}
            </button>
          </div>
        ) : (
          // QUEUE TAB
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {queue.length === 0 ? (
              <div style={{ padding: 22, textAlign: 'center' }}>
                <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>
                  No scheduled posts for this group.
                </span>
              </div>
            ) : (
              queue.map((post) => (
                <div
                  key={post.id}
                  style={{
                    padding: 14,
                    backgroundColor: t.surface,
                    border: `1px solid ${t.border}`,
                    borderRadius: t.radius,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.6 }}>
                      {formatQueueWhen(post.sendAt).toUpperCase()}
                    </span>
                    {post.options.pinned && (
                      <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.warn, letterSpacing: 0.4 }}>
                        PINNED
                      </span>
                    )}
                    {post.options.silent && (
                      <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, letterSpacing: 0.4 }}>
                        SILENT
                      </span>
                    )}
                    {post.options.repliesOff && (
                      <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, letterSpacing: 0.4 }}>
                        READ-ONLY
                      </span>
                    )}
                    <button onClick={() => handleCancel(post.id)} aria-label="Cancel post" style={iconBtn}>
                      <I.Trash size={14} color={t.textFaint} />
                    </button>
                  </div>
                  {post.imageDataUrl && (
                    <img
                      src={post.imageDataUrl}
                      alt="post"
                      style={{ maxWidth: 220, maxHeight: 140, borderRadius: t.radiusS, objectFit: 'cover' }}
                    />
                  )}
                  {post.text && (
                    <span style={{ fontFamily: t.font, fontSize: 14, color: t.text, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {post.text}
                    </span>
                  )}
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.4 }}>
                    {post.options.asGroup ? 'AS GROUP' : 'AS YOU'}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OptionRow({
  t, label, sub, on, onChange,
}: {
  t: ReturnType<typeof useTheme>['t'];
  label: string; sub: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      aria-label={`${label}: ${on ? 'enabled' : 'disabled'}`}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        backgroundColor: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: t.radiusS,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <div
        style={{
          width: 36,
          height: 20,
          borderRadius: 10,
          backgroundColor: on ? t.accent : t.surface3,
          position: 'relative',
          transition: 'background-color 0.15s',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: '#fff',
            transition: 'left 0.15s',
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: t.font, fontSize: 13, color: t.text, display: 'block' }}>{label}</span>
        <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, display: 'block', marginTop: 2 }}>{sub}</span>
      </div>
    </button>
  );
}

function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const iconBtn: CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 4,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

function cardStyle(t: ReturnType<typeof useTheme>['t']): CSSProperties {
  return {
    backgroundColor: t.surface,
    border: `1px solid ${t.border}`,
    borderRadius: t.radius,
    padding: 14,
  };
}

function publishAsBtn(t: ReturnType<typeof useTheme>['t'], active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '10px 14px',
    backgroundColor: active ? t.surface2 : 'transparent',
    border: `1px solid ${active ? t.accent : t.border}`,
    borderRadius: t.radiusS,
    cursor: 'pointer',
    fontFamily: t.fontMono,
    fontSize: 11,
    letterSpacing: 0.6,
    color: active ? t.accent : t.textDim,
  };
}

function chipStyle(t: ReturnType<typeof useTheme>['t'], active: boolean): CSSProperties {
  return {
    padding: '8px 14px',
    backgroundColor: active ? `${t.accent}18` : t.surface,
    border: `1px solid ${active ? t.accent : t.border}`,
    borderRadius: 99,
    cursor: 'pointer',
    fontFamily: t.fontMono,
    fontSize: 10,
    letterSpacing: 0.5,
    color: active ? t.accent : t.textDim,
  };
}
