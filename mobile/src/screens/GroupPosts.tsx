/**
 * GroupPosts — Publicaciones programadas de grupo (solo admin/dueño).
 *
 * Port fiel de screens-grouppost.jsx (design system Vault): compositor de
 * anuncios (publicar como grupo/tú, imagen con EXIF eliminado, programación
 * con chips + fecha personalizada, opciones de publicación) y cola de posts
 * pendientes con cuenta atrás, autor, rol y acciones.
 *
 * Diferencia deliberada con el mockup: la sección "CANAL DESTINO" se omite —
 * los grupos del consumer app no tienen canales (eso pertenece a AegisLink
 * Work). El resto de la visual se respeta 1:1.
 *
 * Seguridad: texto y opciones se guardan at-rest cifrados (encryptBody) y el
 * cifrado de transporte (Double Ratchet por miembro) ocurre en el momento
 * exacto del envío — ver store/scheduledMessages.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Image, StyleSheet, Modal } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { withPickingGuard } from '../utils/pickingGuard';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Avatar } from '../components/Avatar';
import { PrimaryButton, GhostButton } from '../components/Button';
import { SchedulePicker } from '../components/SchedulePicker';
import { useIdentity } from '../store/identity';
import { useGroups } from '../store/groups';
import {
  useScheduledMessages,
  canScheduleGroupPost,
  DEFAULT_POST_OPTIONS,
  type GroupPostOptions,
  type ScheduledMessage,
} from '../store/scheduledMessages';
import type { StoredGroup } from '../db/local';
import { themedAlert } from '../components/AlertHost';

interface Props {
  group: StoredGroup;
  onBack: () => void;
  /** Optional draft text handed over from the GroupChat composer long-press. */
  initialText?: string;
}

type WhenChip = '1h' | 'today' | 'tomorrow' | 'custom';

/** Best-effort unlink of a staged file. Cleanup only — never throws. */
async function deleteStagedFile(path: string): Promise<void> {
  try {
    const FS = await import('expo-file-system/legacy');
    await FS.deleteAsync(path, { idempotent: true });
  } catch { /* best-effort */ }
}

/** Copy a picked asset into the staging dir so it survives cache eviction. */
async function stageFile(fromUri: string, ext: string): Promise<string> {
  const FS = await import('expo-file-system/legacy');
  const dir = `${FS.documentDirectory}scheduledposts/`;
  await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const dest = `${dir}post_${Crypto.randomUUID()}.${ext}`;
  await FS.copyAsync({ from: fromUri, to: dest });
  return dest;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024; // mirror crypto/media MAX_BYTES

function shortName(name: string, max = 22): string {
  return name.length > max ? name.slice(0, max - 3) + '…' : name;
}

/** Strip characters that would corrupt the [poll:q|opt|…] wire format. */
function sanitizePollText(s: string): string {
  return s.replace(/[|[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Tiempo ───────────────────────────────────────────────────────────────────

function pad(n: number): string { return String(n).padStart(2, '0'); }

function chipSendAt(chip: WhenChip, customTs: number | null): number {
  const now = new Date();
  if (chip === '1h') return Date.now() + 60 * 60 * 1000;
  if (chip === 'today') {
    const d = new Date(now); d.setHours(18, 0, 0, 0);
    return d.getTime();
  }
  if (chip === 'tomorrow') {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  return customTs ?? Date.now() + 60 * 60 * 1000;
}

function formatCountdown(ms: number, i18nT: TFunction): string {
  if (ms <= 0) return i18nT('groupPosts.dueNow', 'AHORA');
  const min = Math.round(ms / 60000);
  if (min < 60) return i18nT('groupPosts.inMin', 'EN {{n}} MIN', { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) {
    const remM = min % 60;
    return remM > 0
      ? i18nT('groupPosts.inHM', 'EN {{h}} H {{m}} M', { h, m: remM })
      : i18nT('groupPosts.inH', 'EN {{h}} H', { h });
  }
  return i18nT('groupPosts.inD', 'EN {{d}} D', { d: Math.round(h / 24) });
}

function formatWhenBig(ts: number, i18nT: TFunction): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date) =>
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, now)) return `${i18nT('groupPosts.today', 'Hoy')} · ${hm}`;
  if (sameDay(d, tomorrow)) return `${i18nT('groupPosts.tomorrow', 'Mañana')} · ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} · ${hm}`;
}

function formatWhenSub(ts: number): string {
  const d = new Date(ts);
  const days = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
  const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

function formatQueueWhen(ts: number): string {
  const d = new Date(ts);
  return `${formatWhenSub(ts)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Pantalla ─────────────────────────────────────────────────────────────────

export function GroupPostsScreen({ group: groupProp, onBack, initialText }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const myAvatarImage = useIdentity((s) => s.avatarImage);
  const group = useGroups((s) => s.groups.find((g) => g.id === groupProp.id)) ?? groupProp;
  const scheduled = useScheduledMessages((s) => s.scheduled);
  const { scheduleGroupPost, cancelScheduled, loadPending } = useScheduledMessages();

  const isOwner = group.adminId === identity?.aegisId;
  const canPost = canScheduleGroupPost(group, identity?.aegisId);

  const [tab, setTab] = useState<'compose' | 'queue'>('compose');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [asGroup, setAsGroup] = useState(true);
  const [text, setText] = useState(initialText ?? '');
  const [image, setImage] = useState<{ path: string; name: string } | null>(null);
  const [file, setFile] = useState<{ path: string; name: string } | null>(null);
  const [poll, setPoll] = useState<{ question: string; options: string[] } | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [showPollModal, setShowPollModal] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [when, setWhen] = useState<WhenChip>('tomorrow');
  const [customTs, setCustomTs] = useState<number | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pin, setPin] = useState(false);
  const [notify, setNotify] = useState(true);
  const [replies, setReplies] = useState(true);
  const [repeat, setRepeat] = useState(false);

  // Decrypted queue rows (id → text + options), hydrated from the store list.
  const [decrypted, setDecrypted] = useState<Record<string, { text: string; options: GroupPostOptions }>>({});

  // Staged image files picked THIS session and not yet saved into a post.
  // Anything still here on replace/remove/unmount is unreferenced plaintext on
  // disk and must be unlinked; once a post is scheduled the path is persisted
  // (the store owns its cleanup from then on) and leaves this set.
  const freshStagedPaths = useRef<Set<string>>(new Set());

  useEffect(() => { void loadPending(); }, [loadPending]);

  useEffect(() => {
    const fresh = freshStagedPaths.current;
    return () => { for (const p of fresh) void deleteStagedFile(p); };
  }, []);

  const queue = scheduled.filter(
    (m) => m.groupId === group.id && (m.status === 'pending' || m.status === 'draft'),
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { decryptBody } = await import('../db/local');
      const out: Record<string, { text: string; options: GroupPostOptions }> = {};
      for (const m of queue) {
        const txt = await decryptBody(m.encryptedPayload);
        let options = DEFAULT_POST_OPTIONS;
        if (m.postMeta) {
          const metaJson = await decryptBody(m.postMeta);
          if (metaJson && metaJson !== '[DECRYPTION_ERROR]') {
            try { options = { ...DEFAULT_POST_OPTIONS, ...JSON.parse(metaJson) }; } catch { /* defaults */ }
          }
        }
        out[m.id] = { text: txt === '[DECRYPTION_ERROR]' ? '' : txt, options };
      }
      if (alive) setDecrypted(out);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduled, group.id]);

  // ── Imagen: picker → crop-free resize (re-encode JPEG = EXIF eliminado) ──
  const handlePickImage = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      themedAlert(i18nT('groups.permissionDeniedTitle', 'Permiso denegado'), i18nT('groups.permissionDeniedGallery', 'Se necesita acceso a la galería.'));
      return;
    }
    const result = await withPickingGuard(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as ImagePicker.MediaType[],
        quality: 0.85,
      }),
    );
    if (!result || result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    try {
      // Re-encode strips ALL metadata (EXIF/GPS) — the badge promise is real.
      const compressed = await manipulateAsync(
        asset.uri,
        [{ resize: { width: 1280 } }],
        { compress: 0.75, format: SaveFormat.JPEG },
      );
      // Persist into documentDirectory so the staged file survives cache eviction
      // until the scheduled fire time.
      const dest = await stageFile(compressed.uri, 'jpg');
      const rawName = asset.fileName ?? asset.uri.split('/').pop() ?? 'imagen.jpg';
      freshStagedPaths.current.add(dest);
      setImage((prev) => {
        // Replacing an image picked this session: unlink the orphaned file.
        // A persisted image (edit mode) stays — its row still references it
        // until the update is saved, at which point the store unlinks it.
        if (prev && freshStagedPaths.current.delete(prev.path)) void deleteStagedFile(prev.path);
        return { path: dest, name: shortName(rawName) };
      });
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }, [i18nT]);

  const handleRemoveImage = useCallback(() => {
    setImage((prev) => {
      if (prev && freshStagedPaths.current.delete(prev.path)) void deleteStagedFile(prev.path);
      return null;
    });
  }, []);

  // ── Documento: picker → staging (mismo ciclo de vida que la imagen) ──
  const handlePickFile = useCallback(async () => {
    const result = await withPickingGuard(() =>
      DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false }),
    );
    if (!result || result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (asset.size != null && asset.size > MAX_FILE_BYTES) {
      themedAlert(
        i18nT('groupPosts.fileTooBigTitle', 'Archivo demasiado grande'),
        i18nT('groupPosts.fileTooBigDesc', 'El máximo es 50 MB.'),
      );
      return;
    }
    try {
      const rawName = asset.name ?? asset.uri.split('/').pop() ?? 'archivo';
      const rawExt = rawName.includes('.') ? rawName.split('.').pop() ?? '' : '';
      const ext = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : 'bin';
      const dest = await stageFile(asset.uri, ext);
      freshStagedPaths.current.add(dest);
      setFile((prev) => {
        if (prev && freshStagedPaths.current.delete(prev.path)) void deleteStagedFile(prev.path);
        return { path: dest, name: rawName };
      });
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }, [i18nT]);

  const handleRemoveFile = useCallback(() => {
    setFile((prev) => {
      if (prev && freshStagedPaths.current.delete(prev.path)) void deleteStagedFile(prev.path);
      return null;
    });
  }, []);

  // ── Programar / borrador ──
  const sendAt = chipSendAt(when, customTs);

  const hasContent = !!(text.trim() || image || file || poll || linkUrl);

  const handleSchedule = useCallback(async (status: 'pending' | 'draft') => {
    const trimmed = text.trim();
    if (!trimmed && !image && !file && !poll && !linkUrl) return;
    if (!canPost) return;
    try {
      await scheduleGroupPost({
        groupId: group.id,
        plaintext: trimmed,
        sendAt,
        status,
        id: editingId ?? undefined,
        options: {
          asGroup, pinned: pin, notify, replies, repeatWeekly: repeat,
          imagePath: image?.path, imageName: image?.name,
          filePath: file?.path, fileName: file?.name,
          poll: poll ?? undefined,
          linkUrl: linkUrl ?? undefined,
        },
      });
      // Saved into the row — the store owns the staged files' cleanup now.
      if (image) freshStagedPaths.current.delete(image.path);
      if (file) freshStagedPaths.current.delete(file.path);
      setText(''); setImage(null); setFile(null); setPoll(null); setLinkUrl(null);
      setPin(false); setNotify(true); setReplies(true); setRepeat(false); setEditingId(null);
      // Reset the schedule too: without this, the NEXT compose silently
      // inherits the previous post's (possibly edited/past) timestamp.
      setWhen('tomorrow'); setCustomTs(null);
      setTab('queue');
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }, [text, image, file, poll, linkUrl, canPost, scheduleGroupPost, group.id, sendAt, editingId, asGroup, pin, notify, replies, repeat, i18nT]);

  const handleEdit = useCallback((m: ScheduledMessage) => {
    const d = decrypted[m.id];
    if (!d) return;
    setEditingId(m.id);
    setText(d.text);
    setAsGroup(d.options.asGroup);
    setPin(d.options.pinned);
    setNotify(d.options.notify);
    setReplies(d.options.replies);
    setRepeat(d.options.repeatWeekly);
    setImage(d.options.imagePath ? { path: d.options.imagePath, name: d.options.imageName ?? 'imagen.jpg' } : null);
    setFile(d.options.filePath ? { path: d.options.filePath, name: d.options.fileName ?? 'archivo' } : null);
    setPoll(d.options.poll ?? null);
    setLinkUrl(d.options.linkUrl ?? null);
    setCustomTs(m.sendAt);
    setWhen('custom');
    setTab('compose');
  }, [decrypted]);

  const handleDelete = useCallback((m: ScheduledMessage) => {
    themedAlert(
      i18nT('groupPosts.deleteTitle', 'Eliminar publicación'),
      i18nT('groupPosts.deleteDesc', '¿Eliminar esta publicación programada? No se podrá deshacer.'),
      [
        { text: i18nT('common.cancel', 'Cancelar'), style: 'cancel' },
        { text: i18nT('common.delete', 'Eliminar'), style: 'destructive', onPress: () => void cancelScheduled(m.id) },
      ],
    );
  }, [cancelScheduled, i18nT]);

  const todayChipValid = (() => { const d = new Date(); return d.getHours() < 18 || (d.getHours() === 17 && d.getMinutes() < 45); })();
  const whenBig = when === 'custom' && customTs === null
    ? i18nT('groupPosts.custom', 'Personalizado')
    : formatWhenBig(sendAt, i18nT);
  const whenSub = when === 'custom' && customTs === null
    ? i18nT('groupPosts.pickDateTime', 'ELIGE FECHA Y HORA')
    : `${formatWhenSub(sendAt)} · ${formatCountdown(sendAt - Date.now(), i18nT)}`;

  const roleLabel = isOwner
    ? i18nT('groupPosts.youAreOwner', 'TÚ ERES DUEÑO')
    : i18nT('groupPosts.youAreMod', 'MODERADOR');

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('groupPosts.title', 'Publicaciones')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }} accessibilityLabel={i18nT('common.back', 'Volver')}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
        right={
          <View style={[styles.adminBadge, { borderColor: `${t.accent}55` }]}>
            <I.Shield size={10} color={t.accent} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 1 }}>
              {i18nT('groupPosts.adminOnly', 'SOLO ADMIN')}
            </Text>
          </View>
        }
      />

      {/* group context */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 18, paddingBottom: 12, paddingTop: 2 }}>
        <View style={{
          width: 34, height: 34, borderRadius: t.radiusL,
          backgroundColor: `${group.avatarColor ?? t.accent}22`,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <I.Users size={17} color={group.avatarColor ?? t.accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: t.fontDisplay, fontSize: 15, color: t.text, fontWeight: '600', letterSpacing: -0.15 }}>
            {group.name}
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>
            {i18nT('groupPosts.contextSub', '{{n}} MIEMBROS', { n: group.members.length })} · {roleLabel}
          </Text>
        </View>
      </View>

      {/* tab switch */}
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 18, paddingBottom: 12 }}>
        {([
          ['compose', i18nT('groupPosts.tabCompose', 'Redactar')],
          ['queue', `${i18nT('groupPosts.tabQueue', 'En cola')} · ${queue.length}`],
        ] as Array<['compose' | 'queue', string]>).map(([id, lbl]) => {
          const on = tab === id;
          return (
            <Pressable
              key={id}
              onPress={() => setTab(id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={{
                flex: 1, paddingVertical: 9, paddingHorizontal: 10, alignItems: 'center',
                backgroundColor: on ? t.accent : t.surface,
                borderWidth: 1, borderColor: on ? t.accent : t.border,
                borderRadius: t.radius,
              }}
            >
              <Text style={{
                fontFamily: t.fontMono, fontSize: 11, letterSpacing: 0.4,
                fontWeight: on ? '600' : '500', color: on ? t.accentInk : t.textDim,
              }}>
                {lbl.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* ── COMPOSE ─────────────────────────────────────────────────────── */}
      {tab === 'compose' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 22 + insets.bottom }}>
          {/* author segmented */}
          <View style={{ paddingHorizontal: 18, paddingBottom: 16 }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 10, padding: 5,
              backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius,
            }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.6, paddingLeft: 8 }}>
                {i18nT('groupPosts.publishAs', 'PUBLICAR COMO')}
              </Text>
              <View style={{ flex: 1 }} />
              {([[true, i18nT('groupPosts.asGroup', 'El grupo')], [false, i18nT('groupPosts.asYou', 'Tú')]] as Array<[boolean, string]>).map(([val, lbl]) => {
                const on = asGroup === val;
                return (
                  <Pressable
                    key={lbl}
                    onPress={() => setAsGroup(val)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    style={{
                      paddingVertical: 6, paddingHorizontal: 12,
                      backgroundColor: on ? t.accent : 'transparent', borderRadius: t.radiusS,
                    }}
                  >
                    <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: on ? '600' : '500', color: on ? t.accentInk : t.textDim }}>
                      {lbl}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* composer card */}
          <View style={{ paddingHorizontal: 18, paddingBottom: 16 }}>
            <View style={{ backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, overflow: 'hidden' }}>
              {/* author row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 }}>
                {asGroup ? (
                  <View style={{
                    width: 30, height: 30, borderRadius: t.radiusL,
                    backgroundColor: `${group.avatarColor ?? t.accent}22`,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <I.Users size={15} color={group.avatarColor ?? t.accent} />
                  </View>
                ) : (
                  <Avatar t={t} name={i18nT('groupAdmin.youLabel', 'Tú')} color={t.accent} size={30} photoUri={myAvatarImage} />
                )}
                <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>
                  {asGroup ? group.name : i18nT('groupAdmin.youLabel', 'Tú')}
                </Text>
                <View style={[styles.announceChip, { borderColor: `${t.accent}55` }]}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.5 }}>
                    {i18nT('groupPosts.announceChip', 'ANUNCIO')}
                  </Text>
                </View>
              </View>

              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                placeholder={i18nT('groupPosts.placeholder', 'Escribe el anuncio…')}
                placeholderTextColor={t.textDim}
                accessibilityLabel={i18nT('groupPosts.placeholder', 'Escribe el anuncio…')}
                style={{
                  minHeight: 84, textAlignVertical: 'top',
                  color: t.text, fontFamily: t.font, fontSize: 14, lineHeight: 21,
                  paddingHorizontal: 14, paddingBottom: 12, paddingTop: 0,
                }}
              />

              {/* attached image */}
              {image && (
                <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
                  <View style={{ borderRadius: t.radius, overflow: 'hidden', borderWidth: 1, borderColor: `${t.accent}44` }}>
                    <Image source={{ uri: image.path }} style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: t.surface2 }} resizeMode="cover" />
                    <Pressable
                      onPress={handleRemoveImage}
                      accessibilityLabel={i18nT('groupPosts.removeImage', 'Quitar imagen')}
                      style={{
                        position: 'absolute', top: 8, right: 8, width: 26, height: 26, borderRadius: 13,
                        backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <I.X size={15} color="#fff" />
                    </Pressable>
                    <View style={{
                      position: 'absolute', left: 8, bottom: 8, flexDirection: 'row', alignItems: 'center', gap: 5,
                      paddingHorizontal: 8, paddingVertical: 3, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 99,
                    }}>
                      <I.Check size={10} color={t.accent} />
                      <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.5 }}>
                        {i18nT('groupPosts.exifStripped', 'EXIF ELIMINADO')} · {image.name}
                      </Text>
                    </View>
                  </View>
                </View>
              )}

              {/* attachment chips: documento / encuesta / enlace */}
              {(file || poll || linkUrl) && (
                <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 6 }}>
                  {file && (
                    <View style={[styles.attachCard, { borderColor: `${t.accent}44`, backgroundColor: t.surface2, borderRadius: t.radius }]}>
                      <I.Attach size={15} color={t.accent} />
                      <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.fontMono, fontSize: 11, color: t.text, letterSpacing: 0.3 }}>
                        {shortName(file.name, 30)}
                      </Text>
                      <Pressable onPress={handleRemoveFile} hitSlop={8} accessibilityLabel={i18nT('groupPosts.removeFile', 'Quitar archivo')}>
                        <I.X size={14} color={t.textDim} />
                      </Pressable>
                    </View>
                  )}
                  {poll && (
                    <Pressable
                      onPress={() => setShowPollModal(true)}
                      accessibilityLabel={i18nT('groupPosts.editPoll', 'Editar encuesta')}
                      style={[styles.attachCard, { borderColor: `${t.accent}44`, backgroundColor: t.surface2, borderRadius: t.radius }]}
                    >
                      <I.Check size={15} color={t.accent} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 12.5, color: t.text }}>{poll.question}</Text>
                        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 0.5, marginTop: 1 }}>
                          {i18nT('groupPosts.pollOptionsCount', '{{n}} OPCIONES · VOTO ANÓNIMO', { n: poll.options.length })}
                        </Text>
                      </View>
                      <Pressable onPress={() => setPoll(null)} hitSlop={8} accessibilityLabel={i18nT('groupPosts.removePoll', 'Quitar encuesta')}>
                        <I.X size={14} color={t.textDim} />
                      </Pressable>
                    </Pressable>
                  )}
                  {linkUrl && (
                    <Pressable
                      onPress={() => setShowLinkModal(true)}
                      accessibilityLabel={i18nT('groupPosts.editLink', 'Editar enlace')}
                      style={[styles.attachCard, { borderColor: `${t.accent}44`, backgroundColor: t.surface2, borderRadius: t.radius }]}
                    >
                      <I.Globe size={15} color={t.accent} />
                      <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.fontMono, fontSize: 11, color: t.text, letterSpacing: 0.3 }}>
                        {linkUrl.replace(/^https?:\/\//, '')}
                      </Text>
                      <Pressable onPress={() => setLinkUrl(null)} hitSlop={8} accessibilityLabel={i18nT('groupPosts.removeLink', 'Quitar enlace')}>
                        <I.X size={14} color={t.textDim} />
                      </Pressable>
                    </Pressable>
                  )}
                </View>
              )}

              {/* add-media row */}
              <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: t.divider }}>
                {([
                  { ic: <I.Eye size={17} color={t.textDim} />, l: i18nT('groupPosts.mediaImage', 'Imagen'), on: () => { void handlePickImage(); } },
                  { ic: <I.Attach size={17} color={t.textDim} />, l: i18nT('groupPosts.mediaFile', 'Archivo'), on: () => { void handlePickFile(); } },
                  { ic: <I.Timer size={17} color={t.textDim} />, l: i18nT('groupPosts.mediaPoll', 'Encuesta'), on: () => setShowPollModal(true) },
                  { ic: <I.Globe size={17} color={t.textDim} />, l: i18nT('groupPosts.mediaLink', 'Enlace'), on: () => setShowLinkModal(true) },
                ]).map((m) => (
                  <Pressable
                    key={m.l}
                    onPress={m.on}
                    accessibilityLabel={m.l}
                    style={({ pressed }) => ({ flex: 1, alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 4, borderRadius: t.radiusS, opacity: pressed ? 0.6 : 1 })}
                  >
                    {m.ic}
                    <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 0.4 }}>
                      {m.l.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>

          {/* schedule */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 18, paddingBottom: 7 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1 }}>
              {i18nT('groupPosts.scheduleFor', 'PROGRAMAR PARA')}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.6 }}>
              {i18nT('groupPosts.tz', 'ZONA')}: {Intl.DateTimeFormat().resolvedOptions().timeZone.toUpperCase()}
            </Text>
          </View>
          <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
            <Pressable
              onPress={() => setShowPicker(true)}
              accessibilityLabel={i18nT('groupPosts.pickDateTime', 'ELIGE FECHA Y HORA')}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 12,
                paddingHorizontal: 16, paddingVertical: 14, marginBottom: 10,
                backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius,
              }}
            >
              <View style={{ width: 42, height: 42, borderRadius: t.radius, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
                <I.Timer size={22} color={t.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.fontDisplay, fontSize: 19, color: t.text, fontWeight: '600', letterSpacing: -0.2 }}>
                  {whenBig}
                </Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8, marginTop: 2 }}>
                  {whenSub}
                </Text>
              </View>
              <I.Chevron size={16} color={t.textFaint} />
            </Pressable>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {([
                ['1h', i18nT('groupPosts.chip1h', 'En 1 hora'), true],
                ['today', i18nT('groupPosts.chipToday', 'Hoy 18:00'), todayChipValid],
                ['tomorrow', i18nT('groupPosts.chipTomorrow', 'Mañana 9:00'), true],
                ['custom', i18nT('groupPosts.custom', 'Personalizado'), true],
              ] as Array<[WhenChip, string, boolean]>).filter(([, , show]) => show).map(([id, lbl]) => {
                const on = when === id;
                return (
                  <Pressable
                    key={id}
                    onPress={() => { setWhen(id); if (id === 'custom') setShowPicker(true); }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    style={{
                      paddingVertical: 7, paddingHorizontal: 12, borderRadius: 99,
                      backgroundColor: on ? t.accent : t.surface,
                      borderWidth: 1, borderColor: on ? t.accent : t.border,
                    }}
                  >
                    <Text style={{ fontFamily: t.fontMono, fontSize: 10.5, fontWeight: on ? '600' : '500', letterSpacing: 0.4, color: on ? t.accentInk : t.textDim }}>
                      {lbl}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* options */}
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1, paddingHorizontal: 18, paddingBottom: 7 }}>
            {i18nT('groupPosts.onPublish', 'AL PUBLICAR')}
          </Text>
          <View style={{ marginHorizontal: 18, marginBottom: 18, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, overflow: 'hidden' }}>
            <PostToggle t={t} icon={<I.Shield size={16} color={pin ? t.accent : t.textDim} />} label={i18nT('groupPosts.pinLabel', 'Fijar en el grupo')} sub={i18nT('groupPosts.pinSub', 'Lo ancla arriba al publicarse')} value={pin} onChange={setPin} />
            <PostToggle t={t} icon={<I.Bell size={16} color={notify ? t.accent : t.textDim} />} label={i18nT('groupPosts.notifyLabel', 'Notificar a los {{n}} miembros', { n: group.members.length })} sub={i18nT('groupPosts.notifySub', 'Push cifrado · sin previsualización')} value={notify} onChange={setNotify} />
            <PostToggle t={t} icon={<I.Send size={16} color={replies ? t.accent : t.textDim} />} label={i18nT('groupPosts.repliesLabel', 'Permitir respuestas')} sub={i18nT('groupPosts.repliesSub', 'Si se apaga, queda solo-lectura')} value={replies} onChange={setReplies} />
            <PostToggle t={t} icon={<I.Timer size={16} color={repeat ? t.accent : t.textDim} />} label={i18nT('groupPosts.repeatLabel', 'Repetir cada semana')} sub={i18nT('groupPosts.repeatSub', 'Mismo día y hora · hasta cancelar')} value={repeat} onChange={setRepeat} noBorder />
          </View>

          {/* footer actions */}
          <View style={{ paddingHorizontal: 18, gap: 10 }}>
            <PrimaryButton
              t={t}
              label={
                editingId
                  ? i18nT('groupPosts.updatePost', 'Actualizar publicación')
                  : repeat
                    ? i18nT('groupPosts.scheduleRecurring', 'Programar publicación recurrente')
                    : i18nT('groupPosts.schedulePost', 'Programar publicación')
              }
              disabled={!hasContent || (when === 'custom' && customTs === null)}
              onPress={() => { void handleSchedule('pending'); }}
            />
            <GhostButton
              t={t}
              label={i18nT('groupPosts.saveDraft', 'Guardar como borrador')}
              disabled={!hasContent}
              onPress={() => { void handleSchedule('draft'); }}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 2 }}>
              <I.Lock size={10} color={t.textFaint} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, color: t.textFaint, letterSpacing: 0.5 }}>
                {i18nT('groupPosts.encryptedNote', 'CIFRADO EN EL DISPOSITIVO HASTA EL ENVÍO')}
              </Text>
            </View>
          </View>
        </ScrollView>
      )}

      {/* ── QUEUE ───────────────────────────────────────────────────────── */}
      {tab === 'queue' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 22 + insets.bottom }}>
          <View style={{
            marginHorizontal: 18, marginBottom: 14, paddingHorizontal: 14, paddingVertical: 11,
            backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius,
          }}>
            <Text style={{ fontFamily: t.font, fontSize: 12.5, color: t.textDim, lineHeight: 19 }}>
              {i18nT('groupPosts.queueInfo', 'Solo admins y dueños ven y gestionan la cola. Cada post se cifra y se publica a la hora exacta.')}
            </Text>
          </View>

          {queue.length === 0 && (
            <View style={{ alignItems: 'center', paddingTop: 48, paddingHorizontal: 24 }}>
              <I.Timer size={36} color={t.textFaint} />
              <Text style={{ fontFamily: t.font, fontSize: 13.5, color: t.textFaint, textAlign: 'center', marginTop: 12, lineHeight: 20 }}>
                {i18nT('groupPosts.queueEmpty', 'No hay publicaciones programadas para este grupo.')}
              </Text>
            </View>
          )}

          {queue.map((q) => {
            const d = decrypted[q.id];
            const isDraft = q.status === 'draft';
            const opts = d?.options ?? DEFAULT_POST_OPTIONS;
            return (
              <View
                key={q.id}
                style={{
                  marginHorizontal: 18, marginBottom: 10, backgroundColor: t.surface,
                  borderWidth: 1, borderColor: opts.pinned ? `${t.accent}55` : t.border,
                  borderRadius: t.radius, overflow: 'hidden',
                }}
              >
                {/* top row: badges + countdown */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.text, fontWeight: '600' }}>
                    {opts.asGroup ? group.name : i18nT('groupAdmin.youLabel', 'Tú')}
                  </Text>
                  {opts.pinned && (
                    <View style={[styles.smallChip, { borderColor: `${t.accent}55` }]}>
                      <I.Shield size={9} color={t.accent} />
                      <Text style={{ fontFamily: t.fontMono, fontSize: 8.5, color: t.accent, letterSpacing: 0.5 }}>
                        {i18nT('groupPosts.pinnedChip', 'FIJADO')}
                      </Text>
                    </View>
                  )}
                  {opts.repeatWeekly && (
                    <View style={[styles.smallChip, { borderColor: `${t.warn}55` }]}>
                      <Text style={{ fontFamily: t.fontMono, fontSize: 8.5, color: t.warn, letterSpacing: 0.5 }}>
                        {i18nT('groupPosts.weeklyChip', 'SEMANAL')}
                      </Text>
                    </View>
                  )}
                  {opts.filePath && <I.Attach size={11} color={t.textDim} />}
                  {opts.poll && (
                    <View style={[styles.smallChip, { borderColor: t.border }]}>
                      <Text style={{ fontFamily: t.fontMono, fontSize: 8.5, color: t.textDim, letterSpacing: 0.5 }}>
                        {i18nT('groupPosts.pollChip', 'ENCUESTA')}
                      </Text>
                    </View>
                  )}
                  {opts.linkUrl && <I.Globe size={11} color={t.textDim} />}
                  <View style={{ flex: 1 }} />
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: isDraft ? t.textFaint : t.accent, letterSpacing: 0.6 }}>
                    {isDraft ? i18nT('groupPosts.draftChip', 'BORRADOR') : formatCountdown(q.sendAt - Date.now(), i18nT)}
                  </Text>
                </View>

                {/* body: thumb + text */}
                <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingBottom: 10 }}>
                  {opts.imagePath ? (
                    <Image
                      source={{ uri: opts.imagePath }}
                      style={{ width: 58, height: 58, borderRadius: t.radiusS, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border }}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={{
                      width: 58, height: 58, borderRadius: t.radiusS,
                      backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      {opts.filePath
                        ? <I.Attach size={20} color={t.textDim} />
                        : opts.poll
                          ? <I.Check size={20} color={t.textDim} />
                          : <I.Bell size={20} color={t.textDim} />}
                    </View>
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={3} style={{ fontFamily: t.font, fontSize: 12.5, color: t.text, lineHeight: 17.5 }}>
                      {d?.text || opts.poll?.question || opts.fileName || opts.linkUrl || '…'}
                    </Text>
                  </View>
                </View>

                {/* footer: schedule + author + actions */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: t.divider }}>
                  <I.Timer size={13} color={t.textDim} />
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>
                    {formatQueueWhen(q.sendAt)}
                  </Text>
                  <View style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: t.textFaint }} />
                  <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.4 }}>
                    {i18nT('groupAdmin.youLabel', 'Tú')} · {isOwner ? i18nT('groupPosts.ownerRole', 'DUEÑO') : 'MOD'}
                  </Text>
                  <View style={{ flex: 1 }} />
                  <Pressable onPress={() => handleEdit(q)} hitSlop={6} style={{ padding: 5 }} accessibilityLabel={i18nT('groupPosts.editPost', 'Editar publicación')}>
                    <I.Send size={15} color={t.textDim} />
                  </Pressable>
                  <Pressable onPress={() => handleDelete(q)} hitSlop={6} style={{ padding: 5 }} accessibilityLabel={i18nT('groupPosts.deleteTitle', 'Eliminar publicación')}>
                    <I.Trash size={15} color={t.danger} />
                  </Pressable>
                </View>
              </View>
            );
          })}

          <View style={{ paddingHorizontal: 18, paddingTop: 6 }}>
            <GhostButton t={t} label={`+ ${i18nT('groupPosts.newPost', 'Nueva publicación')}`} onPress={() => setTab('compose')} />
          </View>
        </ScrollView>
      )}

      <SchedulePicker
        visible={showPicker}
        onClose={() => setShowPicker(false)}
        onConfirm={(ts) => { setCustomTs(ts); setWhen('custom'); }}
      />
      <PollComposerModal
        t={t}
        visible={showPollModal}
        initial={poll}
        onClose={() => setShowPollModal(false)}
        onSave={(p) => { setPoll(p); setShowPollModal(false); }}
      />
      <LinkComposerModal
        t={t}
        visible={showLinkModal}
        initial={linkUrl}
        onClose={() => setShowLinkModal(false)}
        onSave={(url) => { setLinkUrl(url); setShowLinkModal(false); }}
      />
    </View>
  );
}

// ─── Poll composer (mini editor de encuesta adjunta) ─────────────────────────

function PollComposerModal({ t, visible, initial, onClose, onSave }: {
  t: Theme;
  visible: boolean;
  initial: { question: string; options: string[] } | null;
  onClose: () => void;
  onSave: (poll: { question: string; options: string[] }) => void;
}) {
  const { t: i18nT } = useTranslation();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);

  // Re-seed from the attached poll each time the modal opens.
  useEffect(() => {
    if (visible) {
      setQuestion(initial?.question ?? '');
      setOptions(initial?.options?.length ? [...initial.options] : ['', '']);
    }
  }, [visible, initial]);

  const handleSave = () => {
    const q = sanitizePollText(question);
    const opts = options.map(sanitizePollText).filter((o) => o.length > 0);
    if (!q) {
      themedAlert(i18nT('poll.missingQuestion', 'Falta la pregunta'), i18nT('poll.missingQuestionDesc', 'Escribe la pregunta de la encuesta.'));
      return;
    }
    if (opts.length < 2) {
      themedAlert(i18nT('poll.fewOptions', 'Faltan opciones'), i18nT('poll.fewOptionsDesc', 'Añade al menos 2 opciones.'));
      return;
    }
    onSave({ question: q, options: opts });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius }]} onPress={() => {}}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1, marginBottom: 10 }}>
            {i18nT('groupPosts.pollModalTitle', 'ENCUESTA ADJUNTA · VOTO ANÓNIMO')}
          </Text>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder={i18nT('poll.question', 'Pregunta')}
            placeholderTextColor={t.textDim}
            accessibilityLabel={i18nT('poll.question', 'Pregunta')}
            style={[styles.modalInput, { color: t.text, fontFamily: t.font, backgroundColor: t.surface2, borderColor: t.border, borderRadius: t.radiusS }]}
          />
          {options.map((opt, idx) => (
            <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TextInput
                value={opt}
                onChangeText={(v) => setOptions((prev) => prev.map((o, i) => (i === idx ? v : o)))}
                placeholder={i18nT('poll.optionPlaceholder', 'Opción {{letter}}', { letter: String.fromCharCode(65 + idx) })}
                placeholderTextColor={t.textDim}
                accessibilityLabel={i18nT('poll.optionPlaceholder', 'Opción {{letter}}', { letter: String.fromCharCode(65 + idx) })}
                style={[styles.modalInput, { flex: 1, color: t.text, fontFamily: t.font, backgroundColor: t.surface2, borderColor: t.border, borderRadius: t.radiusS }]}
              />
              {options.length > 2 && (
                <Pressable
                  onPress={() => setOptions((prev) => prev.filter((_, i) => i !== idx))}
                  hitSlop={8}
                  accessibilityLabel={i18nT('groupPosts.removeOption', 'Quitar opción')}
                >
                  <I.X size={15} color={t.textDim} />
                </Pressable>
              )}
            </View>
          ))}
          {options.length < 6 && (
            <Pressable
              onPress={() => setOptions((prev) => [...prev, ''])}
              accessibilityLabel={i18nT('poll.addOption', 'Añadir opción')}
              style={{ paddingVertical: 8, alignItems: 'center' }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5 }}>
                + {i18nT('poll.addOption', 'Añadir opción').toUpperCase()}
              </Text>
            </Pressable>
          )}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <GhostButton t={t} label={i18nT('common.cancel', 'Cancelar')} onPress={onClose} full={false} style={{ flex: 1 }} />
            <PrimaryButton t={t} label={i18nT('common.ok', 'OK')} onPress={handleSave} full={false} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Link composer ────────────────────────────────────────────────────────────

function LinkComposerModal({ t, visible, initial, onClose, onSave }: {
  t: Theme;
  visible: boolean;
  initial: string | null;
  onClose: () => void;
  onSave: (url: string) => void;
}) {
  const { t: i18nT } = useTranslation();
  const [url, setUrl] = useState('');

  useEffect(() => { if (visible) setUrl(initial ?? ''); }, [visible, initial]);

  const handleSave = () => {
    let u = url.trim();
    if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
    // Minimal sanity: scheme + host with a dot, no spaces.
    if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u)) {
      themedAlert(
        i18nT('groupPosts.badLinkTitle', 'Enlace no válido'),
        i18nT('groupPosts.badLinkDesc', 'Escribe una URL válida (https://…).'),
      );
      return;
    }
    onSave(u);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius }]} onPress={() => {}}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1, marginBottom: 10 }}>
            {i18nT('groupPosts.linkModalTitle', 'ENLACE ADJUNTO')}
          </Text>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://…"
            placeholderTextColor={t.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel={i18nT('groupPosts.linkModalTitle', 'ENLACE ADJUNTO')}
            style={[styles.modalInput, { color: t.text, fontFamily: t.fontMono, backgroundColor: t.surface2, borderColor: t.border, borderRadius: t.radiusS }]}
          />
          <Text style={{ fontFamily: t.font, fontSize: 11.5, color: t.textDim, marginTop: 2, lineHeight: 16 }}>
            {i18nT('groupPosts.linkModalSub', 'Se añade al final del anuncio y los miembros pueden tocarlo.')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <GhostButton t={t} label={i18nT('common.cancel', 'Cancelar')} onPress={onClose} full={false} style={{ flex: 1 }} />
            <PrimaryButton t={t} label={i18nT('common.ok', 'OK')} onPress={handleSave} full={false} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Toggle (port de GPToggle) ────────────────────────────────────────────────

function PostToggle({ t, icon, label, sub, value, onChange, noBorder }: {
  t: Theme;
  icon: React.ReactNode;
  label: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  noBorder?: boolean;
}) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingHorizontal: 14, paddingVertical: 11,
      borderBottomWidth: noBorder ? 0 : 1, borderBottomColor: t.divider,
    }}>
      <View style={{ flexShrink: 0 }}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontFamily: t.font, fontSize: 13.5, color: t.text }}>{label}</Text>
        {sub ? <Text style={{ fontFamily: t.font, fontSize: 11.5, color: t.textDim, marginTop: 1 }}>{sub}</Text> : null}
      </View>
      <Pressable
        onPress={() => onChange(!value)}
        accessibilityRole="switch"
        accessibilityState={{ checked: value }}
        accessibilityLabel={label}
        style={{ width: 42, height: 24, borderRadius: 99, backgroundColor: value ? t.accent : t.surface3, justifyContent: 'center' }}
      >
        <View style={{
          position: 'absolute', top: 3, left: value ? 21 : 3, width: 18, height: 18, borderRadius: 9,
          backgroundColor: value ? t.accentInk : '#fff',
          shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
        }} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  adminBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderRadius: 99,
  },
  announceChip: {
    borderWidth: 1, borderRadius: 99, paddingHorizontal: 6, paddingVertical: 1, marginLeft: 2,
  },
  smallChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: 99, paddingHorizontal: 6, paddingVertical: 1,
  },
  attachCard: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    borderWidth: 1, paddingHorizontal: 11, paddingVertical: 9,
  },
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 24,
  },
  sheet: {
    borderWidth: 1, padding: 16, gap: 8,
  },
  modalInput: {
    borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13.5,
  },
});
