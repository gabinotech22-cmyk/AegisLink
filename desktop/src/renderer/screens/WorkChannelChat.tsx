import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useWorkMessages } from '../store/workMessages';
import { useIdentity } from '../store/identity';
import { useConnection } from '../store/connection';
import { useWork } from '../store/work';
import { getPermissions } from '../utils/workPermissions';
import type { WorkRole } from '../utils/workPermissions';
import { joinChannel, getSocket, emitDeleteChannelMsg } from '../socket/client';
import { useWorkPresence } from '../store/workPresence';
import { SERVER_URL } from '../config';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import type { WorkChannel, WorkMember, ChannelPermission } from '../store/work';
import type { WorkMessage, WorkAttachment } from '../store/workMessages';
import { uploadWorkBlob } from '../utils/workUpload';

// ─── Search result type ───────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  channelId: string;
  channelName: string;
  senderId: string;
  body: string;
  createdAt: number;
}

// ─── Highlight helper ─────────────────────────────────────────────────────────

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const lowerQ = query.toLowerCase();
  const parts: { t: string; match: boolean }[] = [];
  let cursor = 0;
  let idx = lower.indexOf(lowerQ, cursor);
  while (idx !== -1) {
    if (idx > cursor) parts.push({ t: text.slice(cursor, idx), match: false });
    parts.push({ t: text.slice(idx, idx + query.length), match: true });
    cursor = idx + query.length;
    idx = lower.indexOf(lowerQ, cursor);
  }
  if (cursor < text.length) parts.push({ t: text.slice(cursor), match: false });
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark
            key={i}
            style={{ backgroundColor: `${WORK_ACCENT}33`, color: WORK_ACCENT, fontWeight: 700, background: `${WORK_ACCENT}33` }}
          >
            {p.t}
          </mark>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </>
  );
}

// ─── Relative time helper ─────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `hace ${days}d`;
}

const WORK_ACCENT = '#6366f1';

interface Props {
  channel: WorkChannel;
  onBack: () => void;
  isAdmin: boolean;
  myRole?: WorkRole;
  onOpenChannel?: (channelId: string) => void;
}

// ─── Mention parsing helpers ──────────────────────────────────────────────────

function getMentionQuery(value: string, cursor: number): string | null {
  const slice = value.slice(0, cursor);
  const match = slice.match(/@([^\s@]*)$/);
  return match ? match[1] : null;
}

function insertMention(
  value: string,
  cursor: number,
  aegisId: string,
): [string, number] {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const newBefore = before.replace(/@([^\s@]*)$/, `@${aegisId} `);
  const newCursor = newBefore.length;
  return [newBefore + after, newCursor];
}

// ─── Mention highlighting ─────────────────────────────────────────────────────

interface TextSegment {
  text: string;
  isMention: boolean;
}

function parseSegments(body: string): TextSegment[] {
  const parts = body.split(/(@[A-Z0-9-]+)/g);
  return parts.map((part) => ({
    text: part,
    isMention: /^@[A-Z0-9-]+$/.test(part),
  }));
}

function BodyWithMentions({
  body,
  myAegisId,
  color,
  fontFamily,
}: {
  body: string;
  myAegisId: string;
  color: string;
  fontFamily: string;
}) {
  const segments = parseSegments(body);
  return (
    <>
      {segments.map((seg, i) => {
        if (!seg.isMention) {
          return <span key={i}>{seg.text}</span>;
        }
        return (
          <span
            key={i}
            style={{
              color: WORK_ACCENT,
              fontWeight: 600,
              fontFamily,
              backgroundColor:
                seg.text === `@${myAegisId}` ? `${WORK_ACCENT}18` : undefined,
              borderRadius: 3,
              padding: '0 2px',
            }}
          >
            {seg.text}
          </span>
        );
      })}
    </>
  );
}

// ─── Auth helper (mirrors store pattern) ─────────────────────────────────────

function buildAuthQuery(orgId: string, action: string): string {
  const { useIdentity: useId } = require('../store/identity') as {
    useIdentity: { getState: () => { identity: { aegisId: string; signingSecretKeyB64: string } | null } };
  };
  const state = useId.getState().identity;
  if (!state) return '';
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const message = new TextEncoder().encode(`${orgId}:${action}:${timeBucket}`);
  const sigBytes = nacl.sign.detached(message, decodeBase64(state.signingSecretKeyB64));
  const sig = encodeBase64(sigBytes);
  return `aegisId=${encodeURIComponent(state.aegisId)}&sig=${encodeURIComponent(sig)}&ts=${ts}`;
}

// ─── File size formatter ─────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Pending file entry ───────────────────────────────────────────────────────

interface PendingFile {
  key: string;       // client-only stable id
  file: File;
  previewUrl: string | null;  // object URL for images
  uploading: boolean;
  error: string | null;
}

// ─── Channel files panel entry ────────────────────────────────────────────────

interface ChannelFile {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}

// ─── Context menu type ────────────────────────────────────────────────────────

interface ContextMenu {
  x: number;
  y: number;
  messageId: string;
  isPinned: boolean;
  senderId: string;
}

// ─── Message bubble (shared between main list and thread panel) ───────────────

function MessageBubble({
  msg,
  myAegisId,
  fontFamily,
  fontMono,
  text,
  surface,
  textFaint,
}: {
  msg: WorkMessage;
  myAegisId: string;
  fontFamily: string;
  fontMono: string;
  text: string;
  surface: string;
  textFaint: string;
}) {
  const isOwn = msg.senderId === myAegisId;
  const senderShort = msg.senderId.slice(0, 8);

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isOwn ? 'flex-end' : 'flex-start',
        maxWidth: '90%',
        alignSelf: isOwn ? 'flex-end' : 'flex-start',
      }}
    >
      {!isOwn && (
        <span
          style={{
            fontFamily: fontMono,
            fontSize: 10,
            color: WORK_ACCENT,
            marginBottom: 3,
            letterSpacing: 0.3,
          }}
        >
          {senderShort}
        </span>
      )}
      <div
        style={{
          backgroundColor: isOwn ? WORK_ACCENT : surface,
          borderRadius: 12,
          borderBottomRightRadius: isOwn ? 4 : 12,
          borderBottomLeftRadius: isOwn ? 12 : 4,
          padding: '8px 12px',
        }}
      >
        <span
          style={{
            fontFamily,
            fontSize: 14,
            color: isOwn ? '#fff' : text,
            lineHeight: '20px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <BodyWithMentions
            body={msg.body}
            myAegisId={myAegisId}
            color={isOwn ? '#fff' : text}
            fontFamily={fontFamily}
          />
        </span>
      </div>
      <span
        style={{
          fontFamily: fontMono,
          fontSize: 10,
          color: textFaint,
          marginTop: 3,
        }}
      >
        {formatTime(msg.createdAt)}
      </span>
    </div>
  );
}

// ─── Channel permissions panel ────────────────────────────────────────────────

const PERM_ROLES: Array<{ role: 'owner' | 'admin' | 'member'; label: string }> = [
  { role: 'owner', label: 'Owner' },
  { role: 'admin', label: 'Admin' },
  { role: 'member', label: 'Miembro' },
];

const DEFAULT_PERM: ChannelPermission = { role: 'member', canSend: true, canReact: true, canUpload: true };

function mergeDefaults(perms: ChannelPermission[]): Record<'owner' | 'admin' | 'member', ChannelPermission> {
  const base: Record<'owner' | 'admin' | 'member', ChannelPermission> = {
    owner: { role: 'owner', canSend: true, canReact: true, canUpload: true },
    admin: { role: 'admin', canSend: true, canReact: true, canUpload: true },
    member: { ...DEFAULT_PERM },
  };
  for (const p of perms) {
    base[p.role] = p;
  }
  return base;
}

interface PermsToggleProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  accent: string;
  font: string;
  text: string;
  textDim: string;
  surface2: string;
}

function PermsToggle({ label, checked, disabled, onChange, accent, font, text, textDim, surface2 }: PermsToggleProps) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{ fontFamily: font, fontSize: 12, color: disabled ? textDim : text }}>{label}</span>
      <span
        onClick={() => { if (!disabled) onChange(!checked); }}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        style={{
          display: 'inline-flex',
          width: 36,
          height: 20,
          borderRadius: 10,
          backgroundColor: checked ? accent : surface2,
          position: 'relative',
          flexShrink: 0,
          transition: 'background-color 0.15s',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            backgroundColor: '#fff',
            transition: 'left 0.15s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
        />
      </span>
    </label>
  );
}

interface ChannelPermissionsPanelProps {
  orgId: string;
  channelId: string;
  perms: ChannelPermission[];
  onClose: () => void;
  onUpdateOptimistic: (channelId: string, perms: ChannelPermission[]) => void;
  t: import('../theme/vault').Theme;
}

function ChannelPermissionsPanel({ orgId, channelId, perms, onClose, onUpdateOptimistic, t }: ChannelPermissionsPanelProps) {
  const localMap = mergeDefaults(perms);
  const [local, setLocal] = useState<Record<'owner' | 'admin' | 'member', ChannelPermission>>(localMap);

  async function applyToggle(
    role: 'owner' | 'admin' | 'member',
    field: 'canSend' | 'canReact' | 'canUpload',
    value: boolean,
  ) {
    const updated = {
      ...local,
      [role]: { ...local[role], [field]: value },
    };
    setLocal(updated);
    const permsArray = Object.values(updated);
    onUpdateOptimistic(channelId, permsArray);
    try {
      const authQuery = buildAuthQuery(orgId, 'set_channel_permissions');
      await fetch(
        `${SERVER_URL}/work/org/${orgId}/channels/${channelId}/permissions?${authQuery}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissions: permsArray }),
        },
      );
    } catch {
      // offline — optimistic update already applied
    }
  }

  return (
    <div
      style={{
        width: 340,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `1px solid ${t.border}`,
        backgroundColor: t.surface,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: `1px solid ${t.border}`,
          flexShrink: 0,
        }}
      >
        <I.Settings size={14} color={WORK_ACCENT} />
        <span style={{ fontFamily: t.fontDisplay, fontSize: 14, fontWeight: 700, color: t.text, flex: 1 }}>
          Permisos del canal
        </span>
        <button
          onClick={onClose}
          aria-label="Cerrar panel de permisos"
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4, borderRadius: 4 }}
        >
          <I.X size={14} color={t.textDim} />
        </button>
      </div>

      {/* Role sections */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {PERM_ROLES.map(({ role, label }) => {
          const p = local[role];
          const isOwner = role === 'owner';
          return (
            <div key={role}>
              <span
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 10,
                  color: t.textDim,
                  letterSpacing: 0.8,
                  display: 'block',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                }}
              >
                {label}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 4 }}>
                <PermsToggle
                  label="Puede escribir"
                  checked={p.canSend}
                  disabled={isOwner}
                  onChange={(v) => void applyToggle(role, 'canSend', v)}
                  accent={WORK_ACCENT}
                  font={t.font}
                  text={t.text}
                  textDim={t.textDim}
                  surface2={t.surface2}
                />
                <PermsToggle
                  label="Puede reaccionar"
                  checked={p.canReact}
                  disabled={isOwner}
                  onChange={(v) => void applyToggle(role, 'canReact', v)}
                  accent={WORK_ACCENT}
                  font={t.font}
                  text={t.text}
                  textDim={t.textDim}
                  surface2={t.surface2}
                />
                <PermsToggle
                  label="Puede subir archivos"
                  checked={p.canUpload}
                  disabled={isOwner}
                  onChange={(v) => void applyToggle(role, 'canUpload', v)}
                  accent={WORK_ACCENT}
                  font={t.font}
                  text={t.text}
                  textDim={t.textDim}
                  surface2={t.surface2}
                />
              </div>
              {role !== 'member' && (
                <div style={{ height: 1, backgroundColor: t.border, marginTop: 12 }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WorkChannelChat({ channel, onBack, isAdmin, myRole, onOpenChannel }: Props) {
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);
  const myAegisId = identity?.aegisId ?? '';
  const online = useConnection((s) => s.online);
  const {
    byChannel,
    loadMessages,
    sendMessage,
    pinnedMessages,
    loadPinned,
    handlePinEvent,
    markDeleted,
    threadMessages,
    loadThread,
  } = useWorkMessages();
  const channels = useWork((s) => s.channels);
  const members = useWork((s) => s.members);
  const channelPermissions = useWork((s) => s.channelPermissions);
  const fetchChannelPermissions = useWork((s) => s.fetchChannelPermissions);
  const setChannelPermissionsOptimistic = useWork((s) => s.setChannelPermissionsOptimistic);
  const messages: WorkMessage[] = byChannel[channel.channelId] ?? [];

  // Tab switcher state
  const [activeTab, setActiveTab] = useState<'messages' | 'files'>('messages');
  // File filter for files tab
  const [fileTabFilter, setFileTabFilter] = useState<'all' | 'images' | 'documents'>('all');

  const [text, setText] = useState('');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  // Derive channel attachments from in-memory messages
  const channelAttachments = useMemo(() => {
    const msgs = byChannel[channel.channelId] ?? [];
    return msgs
      .flatMap((m) =>
        (m.attachments ?? []).map((a) => ({
          ...a,
          senderId: m.senderId,
          msgCreatedAt: m.createdAt,
        })),
      )
      .sort((a, b) => b.msgCreatedAt - a.msgCreatedAt);
  }, [byChannel, channel.channelId]);

  const filteredChannelAttachments = useMemo(() => {
    if (fileTabFilter === 'images') return channelAttachments.filter((a) => a.mimeType.startsWith('image/'));
    if (fileTabFilter === 'documents') return channelAttachments.filter((a) => !a.mimeType.startsWith('image/'));
    return channelAttachments;
  }, [channelAttachments, fileTabFilter]);

  // Attachment state
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Files panel state
  const [filesPanelOpen, setFilesPanelOpen] = useState(false);
  const [channelFiles, setChannelFiles] = useState<ChannelFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Search panel state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'channel' | 'workspace'>('channel');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Permissions panel state
  const [permsPanelOpen, setPermsPanelOpen] = useState(false);

  // Thread panel state
  const [activeThreadParentId, setActiveThreadParentId] = useState<string | null>(null);
  const [threadText, setThreadText] = useState('');
  const threadBottomRef = useRef<HTMLDivElement>(null);
  const threadTextareaRef = useRef<HTMLTextAreaElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingByChannel = useWorkPresence((s) => s.typingByChannel);
  const typingPeers = useMemo(
    () => (typingByChannel[channel.channelId] ?? []).filter((id) => id !== myAegisId),
    [typingByChannel, channel.channelId, myAegisId],
  );

  // Inject @keyframes bounce once
  useEffect(() => {
    const STYLE_ID = 'aegis-typing-bounce';
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes aegis-bounce {
        0%, 80%, 100% { transform: translateY(0); }
        40% { transform: translateY(-4px); }
      }
    `;
    document.head.appendChild(style);
  }, []);

  // Channel-level permissions for my role
  const myRoleForPerms: WorkRole = myRole ?? (isAdmin ? 'admin' : 'member');
  const myRolePerms = getPermissions(myRoleForPerms);
  const permsForChannel: ChannelPermission[] = channelPermissions[channel.channelId] ?? [];
  const myChannelPerm: ChannelPermission | undefined = permsForChannel.find((p) => p.role === myRoleForPerms);

  // Read-only: channel is announcements AND user can't send, OR explicit channel perm says can't send
  const isReadOnly = myChannelPerm !== undefined
    ? !myChannelPerm.canSend
    : (channel.isAnnouncements && !isAdmin);
  const canUpload = myChannelPerm !== undefined ? myChannelPerm.canUpload : !isReadOnly;
  const canPinInMenu = myRolePerms.canPinMessages;
  const isOwnerRole = myRoleForPerms === 'owner';

  const suggestions: WorkMember[] = mentionQuery !== null
    ? members
        .filter((m) => {
          if (m.aegis_id === myAegisId) return false;
          const q = mentionQuery.toLowerCase();
          return (
            m.aegis_id.toLowerCase().includes(q) ||
            (m.team ?? '').toLowerCase().includes(q)
          );
        })
        .slice(0, 5)
    : [];

  const activeThreadReplies: WorkMessage[] =
    activeThreadParentId !== null ? (threadMessages[activeThreadParentId] ?? []) : [];

  const activeThreadParent: WorkMessage | null =
    activeThreadParentId !== null
      ? (messages.find((m) => m.id === activeThreadParentId) ?? null)
      : null;

  // ── Socket event for pin ──────────────────────────────────────────────────
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const handler = (ev: { channelId: string; messageId: string; pin: boolean; pinnedBy: string; pinnedAt: string }) => {
      if (ev.channelId === channel.channelId) {
        handlePinEvent(ev);
      }
    };
    sock.on('channel:pin', handler);
    return () => { sock.off('channel:pin', handler); };
  }, [channel.channelId, handlePinEvent]);

  // ── Socket event for message delete ──────────────────────────────────────
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const handler = (ev: { channelId: string; messageId: string }) => {
      if (ev.channelId === channel.channelId) {
        markDeleted(ev.channelId, ev.messageId);
      }
    };
    sock.on('channel:msg_deleted', handler);
    return () => { sock.off('channel:msg_deleted', handler); };
  }, [channel.channelId, markDeleted]);

  useEffect(() => {
    joinChannel(channel.channelId, channel.orgId);
    void loadMessages(channel.channelId, channel.orgId);
    void loadPinned(channel.orgId, channel.channelId);
    void fetchChannelPermissions(channel.orgId, channel.channelId);
    return () => {
      if (typingDebounceRef.current !== null) {
        clearTimeout(typingDebounceRef.current);
      }
      emitTypingStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.channelId, channel.orgId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    threadBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeThreadReplies.length]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  // Load thread when panel opens
  useEffect(() => {
    if (activeThreadParentId !== null) {
      void loadThread(channel.orgId, channel.channelId, activeThreadParentId);
    }
  }, [activeThreadParentId, channel.orgId, channel.channelId]);

  // ── Keyboard shortcuts: Ctrl/Cmd+F to open search, Escape to close ──────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }
      if (e.key === 'Escape') {
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery('');
          setSearchResults([]);
        } else if (contextMenu) {
          setContextMenu(null);
          setPinnedExpanded(false);
        } else if (activeThreadParentId !== null) {
          setActiveThreadParentId(null);
        } else {
          setPinnedExpanded(false);
        }
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); };
  }, [contextMenu, activeThreadParentId, searchOpen]);

  // ── Search: auto-focus on open ────────────────────────────────────────────
  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      setSearchQuery('');
      setSearchResults([]);
      if (searchDebounceRef.current !== null) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
    }
  }, [searchOpen]);

  // ── Search: debounced fetch ───────────────────────────────────────────────
  useEffect(() => {
    if (searchDebounceRef.current !== null) {
      clearTimeout(searchDebounceRef.current);
    }
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchDebounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const authQuery = buildAuthQuery(channel.orgId, 'search');
          const channelParam =
            searchScope === 'channel'
              ? `&channelId=${encodeURIComponent(channel.channelId)}`
              : '';
          const res = await fetch(
            `${SERVER_URL}/work/org/${channel.orgId}/search?q=${encodeURIComponent(q)}${channelParam}&limit=50&${authQuery}`,
          );
          if (res.ok) {
            const data = (await res.json()) as { results?: Array<{ id: string; channelId: string; senderId: string; body: string; createdAt: number }> };
            const raw = Array.isArray(data.results) ? data.results : [];
            const enriched: SearchResult[] = raw.map((r) => ({
              ...r,
              channelName: channels.find((c) => c.channelId === r.channelId)?.name ?? r.channelId.slice(0, 12),
            }));
            setSearchResults(enriched);
          } else {
            setSearchResults([]);
          }
        } catch {
          setSearchResults([]);
        } finally {
          setSearchLoading(false);
        }
      })();
    }, 400);
    return () => {
      if (searchDebounceRef.current !== null) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchScope, channel.orgId, channel.channelId]);

  // ── Highlight flash: clear after 1.5s ─────────────────────────────────────
  useEffect(() => {
    if (!highlightedMessageId) return;
    const timer = setTimeout(() => setHighlightedMessageId(null), 1500);
    return () => clearTimeout(timer);
  }, [highlightedMessageId]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    function handleClick() { setContextMenu(null); }
    document.addEventListener('click', handleClick);
    return () => { document.removeEventListener('click', handleClick); };
  }, [contextMenu]);

  // ── File helpers ──────────────────────────────────────────────────────────

  const MAX_FILES = 5;
  const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

  function addFiles(files: FileList | File[]) {
    setAttachError(null);
    const arr = Array.from(files);
    for (const f of arr) {
      if (f.size > MAX_BYTES) {
        setAttachError(`"${f.name}" supera el límite de 50 MB.`);
        return;
      }
    }
    setPendingFiles((prev) => {
      const combined = [...prev, ...arr.map((f) => ({
        key: crypto.randomUUID(),
        file: f,
        previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
        uploading: false,
        error: null,
      } satisfies PendingFile))];
      if (combined.length > MAX_FILES) {
        setAttachError(`Máximo ${MAX_FILES} archivos por mensaje.`);
        return prev;
      }
      return combined;
    });
  }

  function removePending(key: string) {
    setPendingFiles((prev) => {
      const entry = prev.find((p) => p.key === key);
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  async function loadChannelFiles() {
    setFilesLoading(true);
    try {
      const authQuery = buildAuthQuery(channel.orgId, 'list_files');
      const res = await fetch(
        `${SERVER_URL}/work/org/${channel.orgId}/channels/${channel.channelId}/files?${authQuery}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { files?: ChannelFile[] };
        setChannelFiles(Array.isArray(data.files) ? data.files : []);
      }
    } catch {
      // offline — keep existing list
    } finally {
      setFilesLoading(false);
    }
  }

  function toggleFilesPanel() {
    const next = !filesPanelOpen;
    setFilesPanelOpen(next);
    if (next) {
      // close thread panel if open
      setActiveThreadParentId(null);
      void loadChannelFiles();
    }
  }

  async function handleSend() {
    const trimmed = text.trim();
    if ((trimmed === '' && pendingFiles.length === 0) || isReadOnly) return;

    if (pendingFiles.length > 0) {
      // Mark all as uploading
      setPendingFiles((prev) => prev.map((p) => ({ ...p, uploading: true, error: null })));
      let attachments: WorkAttachment[];
      try {
        const aegisId = identity?.aegisId ?? '';
        const results = await Promise.all(
          pendingFiles.map(async (pf) => {
            const { blobId, sizeBytes } = await uploadWorkBlob(pf.file);
            const att: WorkAttachment = {
              id: crypto.randomUUID(),
              messageId: '',  // server assigns real messageId
              blobId,
              filename: pf.file.name,
              mimeType: pf.file.type,
              sizeBytes,
              uploadedBy: aegisId,
              createdAt: new Date().toISOString(),
            };
            return att;
          }),
        );
        attachments = results;
      } catch {
        setPendingFiles((prev) => prev.map((p) => ({ ...p, uploading: false, error: 'Error al subir' })));
        return;
      }

      // Revoke object URLs
      pendingFiles.forEach((p) => { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
      setPendingFiles([]);

      sendMessage(channel.channelId, channel.orgId, trimmed, undefined, attachments);
    } else {
      sendMessage(channel.channelId, channel.orgId, trimmed);
    }

    setText('');
    setMentionQuery(null);
    setAttachError(null);
  }

  function handleThreadSend() {
    const trimmed = threadText.trim();
    if (!trimmed || !activeThreadParentId) return;
    sendMessage(channel.channelId, channel.orgId, trimmed, activeThreadParentId);
    setThreadText('');
  }

  function emitTypingStop() {
    const sock = getSocket();
    if (!sock) return;
    sock.emit('typing', { channelId: channel.channelId, orgId: channel.orgId, isTyping: false });
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setText(val);
    const cursor = e.target.selectionStart ?? val.length;
    setMentionQuery(getMentionQuery(val, cursor));

    if (val.trim() === '') {
      if (typingDebounceRef.current !== null) {
        clearTimeout(typingDebounceRef.current);
        typingDebounceRef.current = null;
      }
      emitTypingStop();
      return;
    }

    if (typingDebounceRef.current !== null) {
      clearTimeout(typingDebounceRef.current);
    }
    typingDebounceRef.current = setTimeout(() => {
      const sock = getSocket();
      if (sock) {
        sock.emit('typing', { channelId: channel.channelId, orgId: channel.orgId, isTyping: true });
      }
      typingDebounceRef.current = null;
    }, 400);
  }

  function handleInputBlur() {
    if (typingDebounceRef.current !== null) {
      clearTimeout(typingDebounceRef.current);
      typingDebounceRef.current = null;
    }
    emitTypingStop();
  }

  const pickSuggestion = useCallback(
    (member: WorkMember) => {
      if (!textareaRef.current) return;
      const cursor = textareaRef.current.selectionStart ?? text.length;
      const [newVal, newCursor] = insertMention(text, cursor, member.aegis_id);
      setText(newVal);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newCursor, newCursor);
        }
      });
    },
    [text],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        pickSuggestion(suggestions[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleThreadKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleThreadSend();
    }
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function rowIsMentioned(body: string): boolean {
    return myAegisId !== '' && body.includes(`@${myAegisId}`);
  }

  function handleContextMenu(e: React.MouseEvent, msg: WorkMessage) {
    e.preventDefault();
    const isPinned = pinnedMessages.some((p) => p.id === msg.id);
    setContextMenu({ x: e.clientX, y: e.clientY, messageId: msg.id, isPinned, senderId: msg.senderId });
  }

  async function handlePinToggle(messageId: string, pin: boolean) {
    setContextMenu(null);
    try {
      const authQuery = buildAuthQuery(channel.orgId, pin ? 'pin_message' : 'unpin_message');
      const res = await fetch(
        `${SERVER_URL}/work/org/${channel.orgId}/channels/${channel.channelId}/messages/${messageId}/pin?${authQuery}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        },
      );
      if (!res.ok) return;
      // Optimistic update — server will also broadcast channel:pin
      handlePinEvent({
        channelId: channel.channelId,
        messageId,
        pin,
        pinnedBy: myAegisId,
        pinnedAt: new Date().toISOString(),
      });
    } catch {
      // offline — silently ignore
    }
  }

  function handleCopyText(messageId: string) {
    setContextMenu(null);
    const msg = messages.find((m) => m.id === messageId);
    if (msg) {
      void navigator.clipboard.writeText(msg.body);
    }
  }

  function handleReplyInThread(messageId: string) {
    setContextMenu(null);
    setActiveThreadParentId(messageId);
  }

  function handleDeleteMsg(messageId: string) {
    setContextMenu(null);
    // Optimistic local update
    markDeleted(channel.channelId, messageId);
    // Emit to relay — server verifies permission and broadcasts to channel room
    emitDeleteChannelMsg({
      channelId: channel.channelId,
      orgId: channel.orgId,
      messageId,
    });
  }

  function handleSearchResultClick(result: SearchResult) {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    if (result.channelId !== channel.channelId && onOpenChannel) {
      onOpenChannel(result.channelId);
    } else {
      // Same channel — flash the message
      setHighlightedMessageId(result.id);
      setTimeout(() => {
        const el = document.getElementById(`msg-${result.id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: t.bg,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          borderBottom: `1px solid ${t.border}`,
          backgroundColor: t.surface,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          aria-label="Volver a canales"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            padding: 4,
            borderRadius: 6,
          }}
        >
          <I.ChevronL size={18} color={t.textDim} />
        </button>
        <span style={{ fontFamily: t.fontMono, fontSize: 16, color: t.textDim, fontWeight: 600 }}>
          {channel.isAnnouncements ? '📢' : '#'}
        </span>
        <span
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 16,
            fontWeight: 700,
            color: t.text,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {channel.name}
        </span>
        {channel.isAnnouncements && (
          <span
            style={{
              fontFamily: t.fontMono,
              fontSize: 9,
              color: t.textFaint,
              letterSpacing: 0.8,
              flexShrink: 0,
            }}
          >
            ANUNCIOS
          </span>
        )}
        <button
          onClick={() => setSearchOpen((v) => !v)}
          aria-label={searchOpen ? 'Cerrar búsqueda' : 'Buscar mensajes (Ctrl+F)'}
          title="Buscar (Ctrl+F)"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            padding: 4,
            borderRadius: 6,
            color: searchOpen ? WORK_ACCENT : t.textDim,
            flexShrink: 0,
          }}
        >
          <I.Search size={16} color={searchOpen ? WORK_ACCENT : t.textDim} />
        </button>
        {isOwnerRole && (
          <button
            onClick={() => {
              setPermsPanelOpen((v) => !v);
              setActiveThreadParentId(null);
            }}
            aria-label={permsPanelOpen ? 'Cerrar permisos del canal' : 'Permisos del canal'}
            title="Permisos del canal"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: 4,
              borderRadius: 6,
              flexShrink: 0,
            }}
          >
            <I.Settings size={16} color={permsPanelOpen ? WORK_ACCENT : t.textDim} />
          </button>
        )}
      </div>

      {/* Search panel */}
      <div
        style={{
          overflow: 'hidden',
          maxHeight: searchOpen ? 300 : 0,
          transition: 'max-height 0.2s ease',
          flexShrink: 0,
          borderBottom: searchOpen ? `1px solid ${t.border}` : 'none',
          backgroundColor: t.surface,
        }}
      >
        {/* Search bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          <I.Search size={15} color={t.textDim} />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar mensajes…"
            aria-label="Campo de búsqueda de mensajes"
            style={{
              flex: 1,
              fontFamily: t.font,
              fontSize: 13,
              color: t.text,
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
            }}
          />
          {searchQuery.length > 0 && (
            <button
              onClick={() => { setSearchQuery(''); setSearchResults([]); }}
              aria-label="Borrar búsqueda"
              style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 2, borderRadius: 4 }}
            >
              <I.X size={13} color={t.textDim} />
            </button>
          )}
          {/* Scope toggle pill */}
          <div
            style={{
              display: 'flex',
              borderRadius: 99,
              border: `1px solid ${t.border}`,
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {(['channel', 'workspace'] as const).map((scope) => {
              const label = scope === 'channel' ? 'Este canal' : 'Todo el workspace';
              const active = searchScope === scope;
              return (
                <button
                  key={scope}
                  onClick={() => setSearchScope(scope)}
                  aria-label={`Buscar en ${label}`}
                  style={{
                    padding: '3px 10px',
                    background: active ? WORK_ACCENT : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: t.fontMono,
                    fontSize: 10,
                    color: active ? '#fff' : t.textDim,
                    fontWeight: active ? 700 : 400,
                    letterSpacing: 0.3,
                    transition: 'background 0.12s, color 0.12s',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Results area */}
        <div style={{ maxHeight: 232, overflowY: 'auto' }}>
          {searchLoading ? (
            <div style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textFaint, letterSpacing: 0.4 }}>
                Buscando…
              </span>
            </div>
          ) : searchQuery.trim() === '' ? (
            <div style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: 0.6 }}>
              <I.Search size={14} color={t.textFaint} />
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textFaint }}>
                Escribe para buscar • Esc para cerrar
              </span>
            </div>
          ) : searchResults.length === 0 ? (
            <div style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: 0.6 }}>
              <I.Search size={14} color={t.textFaint} />
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textFaint }}>
                Sin resultados para &ldquo;{searchQuery.trim()}&rdquo;
              </span>
            </div>
          ) : (
            searchResults.map((result) => (
              <button
                key={result.id}
                onClick={() => handleSearchResultClick(result)}
                aria-label={`Ir al mensaje de ${result.senderId.slice(0, 8)}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  width: '100%',
                  padding: '8px 14px',
                  background: 'none',
                  border: 'none',
                  borderBottom: `1px solid ${t.border}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.1s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = `${WORK_ACCENT}0a`; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {searchScope === 'workspace' && (
                    <span
                      style={{
                        fontFamily: t.fontMono,
                        fontSize: 10,
                        color: WORK_ACCENT,
                        backgroundColor: `${WORK_ACCENT}18`,
                        borderRadius: 4,
                        padding: '1px 5px',
                        letterSpacing: 0.3,
                        flexShrink: 0,
                      }}
                    >
                      #{result.channelName}
                    </span>
                  )}
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: WORK_ACCENT, letterSpacing: 0.3 }}>
                    {result.senderId.slice(0, 8)}
                  </span>
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginLeft: 'auto' }}>
                    {relativeTime(result.createdAt)}
                  </span>
                </div>
                <span
                  style={{
                    fontFamily: t.font,
                    fontSize: 12,
                    color: t.text,
                    lineHeight: '18px',
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    wordBreak: 'break-word',
                  }}
                >
                  <HighlightedText text={result.body} query={searchQuery.trim()} />
                </span>
              </button>
            ))
          )}
          {searchResults.length > 0 && (
            <div style={{ padding: '6px 14px', display: 'flex', justifyContent: 'flex-end' }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.4 }}>
                {searchResults.length} resultado{searchResults.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Tab switcher */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          borderBottom: `1px solid ${t.border}`,
          backgroundColor: t.surface,
          flexShrink: 0,
        }}
      >
        {(['messages', 'files'] as const).map((tab) => {
          const label = tab === 'messages' ? 'Mensajes' : 'Archivos';
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              aria-label={`Ver ${label.toLowerCase()}`}
              aria-selected={isActive}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '10px 0',
                background: 'none',
                border: 'none',
                borderBottom: isActive ? `2px solid ${WORK_ACCENT}` : '2px solid transparent',
                cursor: 'pointer',
                fontFamily: t.fontMono,
                fontSize: 12,
                color: isActive ? WORK_ACCENT : t.textDim,
                fontWeight: isActive ? 700 : 400,
                letterSpacing: 0.4,
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {label}
              {tab === 'files' && channelAttachments.length > 0 && (
                <span
                  style={{
                    backgroundColor: WORK_ACCENT,
                    color: '#fff',
                    fontFamily: t.fontMono,
                    fontSize: 9,
                    fontWeight: 700,
                    borderRadius: 99,
                    padding: '1px 5px',
                  }}
                >
                  {channelAttachments.length > 99 ? '99+' : channelAttachments.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Offline banner */}
      {!online && (
        <div
          data-testid="offline-banner"
          style={{
            backgroundColor: '#3a2600',
            padding: '6px 16px',
            textAlign: 'center',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: '#f5a623',
              letterSpacing: 0.5,
            }}
          >
            SIN CONEXIÓN — los mensajes se enviarán al reconectar
          </span>
        </div>
      )}

      {/* Pinned messages banner */}
      {pinnedMessages.length > 0 && (
        <div style={{ flexShrink: 0, borderBottom: `1px solid ${t.border}` }}>
          {/* Sticky bar */}
          <button
            onClick={() => setPinnedExpanded((v) => !v)}
            aria-label={pinnedExpanded ? 'Colapsar mensajes fijados' : 'Expandir mensajes fijados'}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '7px 16px',
              backgroundColor: `${WORK_ACCENT}12`,
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <I.Pin size={13} color={WORK_ACCENT} />
            <span
              style={{
                fontFamily: t.fontMono,
                fontSize: 11,
                color: WORK_ACCENT,
                flex: 1,
                letterSpacing: 0.3,
              }}
            >
              {pinnedMessages.length} fijado{pinnedMessages.length !== 1 ? 's' : ''}
            </span>
            <I.ChevronD
              size={14}
              color={WORK_ACCENT}
              style={{ transform: pinnedExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
            />
          </button>

          {/* Expanded panel */}
          {pinnedExpanded && (
            <div
              style={{
                backgroundColor: t.surface,
                maxHeight: 220,
                overflowY: 'auto',
                borderTop: `1px solid ${t.border}`,
              }}
            >
              {pinnedMessages.map((pm) => {
                const senderShort = pm.senderId.slice(0, 8);
                return (
                  <div
                    key={pm.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '8px 16px',
                      borderBottom: `1px solid ${t.border}`,
                    }}
                  >
                    <I.Pin size={12} color={WORK_ACCENT} style={{ marginTop: 3, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          fontFamily: t.fontMono,
                          fontSize: 10,
                          color: WORK_ACCENT,
                          display: 'block',
                          marginBottom: 2,
                        }}
                      >
                        {senderShort}
                      </span>
                      <span
                        style={{
                          fontFamily: t.font,
                          fontSize: 13,
                          color: t.text,
                          lineHeight: '18px',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          wordBreak: 'break-word',
                        }}
                      >
                        {pm.body}
                      </span>
                    </div>
                    {canPinInMenu && (
                      <button
                        onClick={() => void handlePinToggle(pm.id, false)}
                        aria-label="Desfijar mensaje"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 4,
                          display: 'flex',
                          alignItems: 'center',
                          flexShrink: 0,
                          opacity: 0.6,
                        }}
                      >
                        <I.X size={13} color={t.textDim} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Typing indicator bar */}
      <div
        aria-live="polite"
        aria-label={typingPeers.length > 0 ? 'Alguien está escribiendo' : undefined}
        style={{
          height: 22,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 16,
          gap: 6,
          overflow: 'hidden',
        }}
      >
        {typingPeers.length > 0 && (
          <>
            <span style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 14 }}>
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  style={{
                    display: 'inline-block',
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    backgroundColor: WORK_ACCENT,
                    animation: `aegis-bounce 1s infinite`,
                    animationDelay: `${delay}ms`,
                  }}
                />
              ))}
            </span>
            <span
              style={{
                fontFamily: t.font,
                fontSize: 11,
                color: t.textDim,
                lineHeight: '14px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {typingPeers.length === 1
                ? `${typingPeers[0].slice(0, 10)} está escribiendo…`
                : 'Varios están escribiendo…'}
            </span>
          </>
        )}
      </div>

      {/* Files tab */}
      {activeTab === 'files' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Filter chips */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              padding: '10px 16px',
              borderBottom: `1px solid ${t.border}`,
              flexShrink: 0,
            }}
          >
            {(['all', 'images', 'documents'] as const).map((f) => {
              const label = f === 'all' ? 'Todos' : f === 'images' ? 'Imágenes' : 'Documentos';
              const active = fileTabFilter === f;
              return (
                <button
                  key={f}
                  onClick={() => setFileTabFilter(f)}
                  aria-label={`Filtrar por ${label}`}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 99,
                    border: `1px solid ${active ? WORK_ACCENT : t.border}`,
                    backgroundColor: active ? WORK_ACCENT : 'transparent',
                    color: active ? '#fff' : t.textDim,
                    fontFamily: t.fontMono,
                    fontSize: 11,
                    cursor: 'pointer',
                    letterSpacing: 0.3,
                    fontWeight: active ? 700 : 400,
                    transition: 'all 0.12s',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* File list */}
          {filteredChannelAttachments.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                opacity: 0.6,
              }}
            >
              <I.Attach size={32} color={t.textFaint} />
              <span style={{ fontFamily: t.font, fontSize: 13, color: t.textFaint }}>
                Sin archivos en este canal
              </span>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {filteredChannelAttachments.map((att) => {
                const isImage = att.mimeType.startsWith('image/');
                const blobUrl = att.blobId;
                return (
                  <a
                    key={att.id}
                    href={blobUrl}
                    download={att.filename}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Descargar ${att.filename}`}
                    style={{
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 16px',
                      borderBottom: `1px solid ${t.border}`,
                      textDecoration: 'none',
                      cursor: 'pointer',
                      backgroundColor: 'transparent',
                      transition: 'background-color 0.1s',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.backgroundColor = `${WORK_ACCENT}0a`; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.backgroundColor = 'transparent'; }}
                  >
                    {/* Thumbnail or icon */}
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        backgroundColor: `${WORK_ACCENT}18`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        overflow: 'hidden',
                      }}
                    >
                      {isImage ? (
                        <img
                          src={blobUrl}
                          alt={att.filename}
                          style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8 }}
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : att.mimeType.startsWith('audio/') ? (
                        <I.Mic size={20} color={WORK_ACCENT} />
                      ) : (
                        <I.Attach size={20} color={WORK_ACCENT} />
                      )}
                    </div>

                    {/* Meta */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          fontFamily: t.font,
                          fontSize: 13,
                          color: t.text,
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {att.filename}
                      </span>
                      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>
                        {formatBytes(att.sizeBytes)} · {att.senderId.slice(0, 8)} ·{' '}
                        {new Date(att.msgCreatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </span>
                    </div>

                    {/* Download icon */}
                    <I.Attach size={14} color={t.textFaint} style={{ flexShrink: 0 }} />
                  </a>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Body: messages + optional thread/perms panel side-by-side */}
      {activeTab === 'messages' && (
      <div style={{ display: 'flex', flexDirection: 'row', flex: 1, overflow: 'hidden' }}>

        {/* Messages area */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            minWidth: 0,
          }}
        >
          {messages.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                opacity: 0.7,
              }}
            >
              <span
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 40,
                  color: t.textFaint,
                }}
              >
                #
              </span>
              <span
                style={{
                  fontFamily: t.fontDisplay,
                  fontSize: 20,
                  fontWeight: 700,
                  color: t.text,
                }}
              >
                {channel.name}
              </span>
              <span
                style={{
                  fontFamily: t.font,
                  fontSize: 13,
                  color: t.textDim,
                  textAlign: 'center',
                  maxWidth: 280,
                  lineHeight: '19px',
                }}
              >
                {isReadOnly
                  ? 'Solo admins pueden escribir en este canal.'
                  : 'Este es el inicio del canal. Escribe el primer mensaje.'}
              </span>
            </div>
          ) : (
            messages.map((msg) => {
              const isOwn = msg.senderId === myAegisId;
              const senderShort = msg.senderId.slice(0, 8);
              const mentioned = rowIsMentioned(msg.body);
              const replyCount = msg.reply_count ?? 0;
              const isActiveThread = activeThreadParentId === msg.id;
              const isHighlighted = highlightedMessageId === msg.id;
              return (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  onContextMenu={(e) => handleContextMenu(e, msg)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: isOwn ? 'flex-end' : 'flex-start',
                    maxWidth: '80%',
                    alignSelf: isOwn ? 'flex-end' : 'flex-start',
                    borderLeft: isHighlighted
                      ? `3px solid ${WORK_ACCENT}`
                      : mentioned && !isOwn
                      ? `2px solid ${WORK_ACCENT}`
                      : undefined,
                    paddingLeft: (isHighlighted || (mentioned && !isOwn)) ? 6 : undefined,
                    backgroundColor: isHighlighted
                      ? `${WORK_ACCENT}22`
                      : isActiveThread
                      ? `${WORK_ACCENT}14`
                      : mentioned && !isOwn
                      ? `${WORK_ACCENT}0a`
                      : undefined,
                    borderRadius: (isHighlighted || (mentioned && !isOwn) || isActiveThread) ? 6 : undefined,
                    cursor: 'context-menu',
                    transition: 'background-color 0.3s, border-color 0.3s',
                  }}
                >
                  {!isOwn && (
                    <span
                      style={{
                        fontFamily: t.fontMono,
                        fontSize: 10,
                        color: WORK_ACCENT,
                        marginBottom: 3,
                        letterSpacing: 0.3,
                      }}
                    >
                      {senderShort}
                    </span>
                  )}
                  <div
                    style={{
                      backgroundColor: isOwn ? WORK_ACCENT : t.surface,
                      borderRadius: 12,
                      borderBottomRightRadius: isOwn ? 4 : 12,
                      borderBottomLeftRadius: isOwn ? 12 : 4,
                      padding: '8px 12px',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: t.font,
                        fontSize: 14,
                        color: isOwn ? '#fff' : t.text,
                        lineHeight: '20px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      <BodyWithMentions
                        body={msg.body}
                        myAegisId={myAegisId}
                        color={isOwn ? '#fff' : t.text}
                        fontFamily={t.font}
                      />
                    </span>
                  </div>
                  <span
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 10,
                      color: t.textFaint,
                      marginTop: 3,
                    }}
                  >
                    {formatTime(msg.createdAt)}
                  </span>

                  {/* Thread indicator */}
                  {replyCount > 0 && (
                    <button
                      onClick={() => setActiveThreadParentId(msg.id)}
                      aria-label={`Ver hilo — ${replyCount} respuesta${replyCount !== 1 ? 's' : ''}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 5,
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '3px 0',
                        marginTop: 2,
                      }}
                    >
                      <I.MessageSquare size={12} color={WORK_ACCENT} />
                      <span
                        style={{
                          fontFamily: t.fontMono,
                          fontSize: 11,
                          color: WORK_ACCENT,
                          letterSpacing: 0.2,
                        }}
                      >
                        {replyCount} respuesta{replyCount !== 1 ? 's' : ''}
                      </span>
                    </button>
                  )}
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {/* Thread side panel */}
        {activeThreadParentId !== null && (
          <div
            style={{
              width: 340,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              borderLeft: `1px solid ${t.border}`,
              backgroundColor: t.surface,
              overflow: 'hidden',
            }}
          >
            {/* Thread panel header */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                borderBottom: `1px solid ${t.border}`,
                flexShrink: 0,
              }}
            >
              <I.MessageSquare size={14} color={WORK_ACCENT} />
              <span
                style={{
                  fontFamily: t.fontDisplay,
                  fontSize: 14,
                  fontWeight: 700,
                  color: t.text,
                  flex: 1,
                }}
              >
                Hilo
              </span>
              <button
                onClick={() => setActiveThreadParentId(null)}
                aria-label="Cerrar hilo"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  padding: 4,
                  borderRadius: 4,
                }}
              >
                <I.X size={14} color={t.textDim} />
              </button>
            </div>

            {/* Parent message preview */}
            {activeThreadParent !== null && (
              <div
                style={{
                  padding: '10px 14px',
                  borderBottom: `1px solid ${t.border}`,
                  flexShrink: 0,
                  backgroundColor: `${WORK_ACCENT}08`,
                }}
              >
                <span
                  style={{
                    fontFamily: t.fontMono,
                    fontSize: 10,
                    color: WORK_ACCENT,
                    display: 'block',
                    marginBottom: 3,
                    letterSpacing: 0.3,
                  }}
                >
                  {activeThreadParent.senderId.slice(0, 8)}
                </span>
                <span
                  style={{
                    fontFamily: t.font,
                    fontSize: 13,
                    color: t.textDim,
                    fontStyle: 'italic',
                    lineHeight: '18px',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    wordBreak: 'break-word',
                  }}
                >
                  {activeThreadParent.body}
                </span>
              </div>
            )}

            {/* Thread reply list */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '10px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {activeThreadReplies.length === 0 ? (
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.5,
                  }}
                >
                  <span
                    style={{
                      fontFamily: t.font,
                      fontSize: 12,
                      color: t.textFaint,
                      textAlign: 'center',
                    }}
                  >
                    Aún no hay respuestas en este hilo.
                  </span>
                </div>
              ) : (
                activeThreadReplies.map((reply) => (
                  <MessageBubble
                    key={reply.id}
                    msg={reply}
                    myAegisId={myAegisId}
                    fontFamily={t.font}
                    fontMono={t.fontMono}
                    text={t.text}
                    surface={t.bg}
                    textFaint={t.textFaint}
                  />
                ))
              )}
              <div ref={threadBottomRef} />
            </div>

            {/* Thread input bar */}
            <div
              style={{
                borderTop: `1px solid ${t.border}`,
                padding: '10px 14px 14px',
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'flex-end',
                  gap: 8,
                }}
              >
                <textarea
                  ref={threadTextareaRef}
                  value={threadText}
                  onChange={(e) => setThreadText(e.target.value)}
                  onKeyDown={handleThreadKeyDown}
                  placeholder="Responder en hilo…"
                  aria-label="Campo de texto para responder en hilo"
                  rows={1}
                  style={{
                    flex: 1,
                    fontFamily: t.font,
                    fontSize: 13,
                    color: t.text,
                    backgroundColor: t.bg,
                    border: `1px solid ${t.border}`,
                    borderRadius: 16,
                    padding: '8px 12px',
                    outline: 'none',
                    resize: 'none',
                    maxHeight: 100,
                    overflowY: 'auto',
                  }}
                />
                <button
                  onClick={handleThreadSend}
                  disabled={!threadText.trim()}
                  aria-label="Enviar respuesta en hilo"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    backgroundColor: threadText.trim() ? WORK_ACCENT : t.surface2,
                    border: 'none',
                    cursor: threadText.trim() ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginBottom: 1,
                    transition: 'background-color 0.15s',
                  }}
                >
                  <I.Send size={14} color={threadText.trim() ? '#fff' : t.textFaint} />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Channel permissions panel — owner only, mutually exclusive with thread panel */}
        {permsPanelOpen && isOwnerRole && (
          <ChannelPermissionsPanel
            orgId={channel.orgId}
            channelId={channel.channelId}
            perms={permsForChannel}
            onClose={() => setPermsPanelOpen(false)}
            onUpdateOptimistic={setChannelPermissionsOptimistic}
            t={t}
          />
        )}
      </div>
      )}

      {/* Input bar — only shown in messages tab */}
      {activeTab === 'messages' && (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          borderTop: `1px solid ${t.border}`,
          backgroundColor: t.surface,
          flexShrink: 0,
          position: 'relative',
        }}
      >
        {/* @mention autocomplete dropdown */}
        {mentionQuery !== null && suggestions.length > 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 16,
              right: (activeThreadParentId !== null || permsPanelOpen) ? 356 : 16,
              backgroundColor: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              boxShadow: '0 -4px 20px rgba(0,0,0,0.35)',
              overflow: 'hidden',
              zIndex: 10,
            }}
          >
            {suggestions.map((member, idx) => (
              <button
                key={member.aegis_id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSuggestion(member);
                }}
                onMouseEnter={() => setMentionIndex(idx)}
                aria-label={`Mencionar a ${member.aegis_id}`}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 12px',
                  background: idx === mentionIndex ? `${WORK_ACCENT}22` : 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  borderBottom: idx < suggestions.length - 1 ? `1px solid ${t.border}` : 'none',
                  transition: 'background 0.1s',
                }}
              >
                <I.Shield size={14} color={WORK_ACCENT} />
                <span
                  style={{
                    fontFamily: t.fontMono,
                    fontSize: 12,
                    color: t.text,
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {member.aegis_id}
                </span>
                {member.team && (
                  <span
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 10,
                      color: t.textFaint,
                      flexShrink: 0,
                    }}
                  >
                    {member.team}
                  </span>
                )}
                {member.role === 'admin' && (
                  <span
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 9,
                      color: WORK_ACCENT,
                      letterSpacing: 0.6,
                      flexShrink: 0,
                    }}
                  >
                    ADMIN
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: 8,
            padding: '10px 16px 14px',
          }}
        >
          {isReadOnly ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                justifyContent: 'center',
                padding: '8px 0',
              }}
            >
              <I.Lock size={13} color={t.textFaint} />
              <span
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 11,
                  color: t.textFaint,
                  letterSpacing: 0.5,
                }}
              >
                Solo admins pueden escribir aquí
              </span>
            </div>
          ) : (
            <>
              {canUpload && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    aria-label="Seleccionar archivos para adjuntar"
                    style={{ display: 'none' }}
                    onChange={handleFileInputChange}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Adjuntar archivo"
                    title="Adjuntar archivo"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 6,
                      borderRadius: 8,
                      flexShrink: 0,
                      marginBottom: 1,
                    }}
                  >
                    <I.Attach size={18} color={t.textDim} />
                  </button>
                </>
              )}
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onBlur={handleInputBlur}
                placeholder={`Mensaje en #${channel.name}`}
                aria-label="Campo de texto del mensaje"
                rows={1}
                style={{
                  flex: 1,
                  fontFamily: t.font,
                  fontSize: 14,
                  color: t.text,
                  backgroundColor: t.bg,
                  border: `1px solid ${t.border}`,
                  borderRadius: 20,
                  padding: '9px 14px',
                  outline: 'none',
                  resize: 'none',
                  maxHeight: 120,
                  overflowY: 'auto',
                }}
              />
              <button
                onClick={handleSend}
                disabled={!text.trim()}
                aria-label="Enviar mensaje"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  backgroundColor: text.trim() ? WORK_ACCENT : t.surface2,
                  border: 'none',
                  cursor: text.trim() ? 'pointer' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginBottom: 1,
                  transition: 'background-color 0.15s',
                }}
              >
                <I.Send size={16} color={text.trim() ? '#fff' : t.textFaint} />
              </button>
            </>
          )}
        </div>
      </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            zIndex: 1000,
            minWidth: 180,
            overflow: 'hidden',
          }}
        >
          {/* Responder en hilo — always first */}
          <button
            onClick={() => handleReplyInThread(contextMenu.messageId)}
            aria-label="Responder en hilo"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '10px 14px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              borderBottom: `1px solid ${t.border}`,
              textAlign: 'left',
            }}
          >
            <I.MessageSquare size={13} color={t.textDim} />
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>
              Responder en hilo
            </span>
          </button>

          {canPinInMenu && (
            <button
              onClick={() => void handlePinToggle(contextMenu.messageId, !contextMenu.isPinned)}
              aria-label={contextMenu.isPinned ? 'Desfijar mensaje' : 'Fijar mensaje'}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 14px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                borderBottom: `1px solid ${t.border}`,
                textAlign: 'left',
              }}
            >
              <I.Pin size={13} color={t.textDim} />
              <span style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>
                {contextMenu.isPinned ? 'Desfijar' : 'Fijar'}
              </span>
            </button>
          )}
          <button
            onClick={() => handleCopyText(contextMenu.messageId)}
            aria-label="Copiar texto del mensaje"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '10px 14px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              borderBottom: (isAdmin || contextMenu.senderId === myAegisId) ? `1px solid ${t.border}` : 'none',
              textAlign: 'left',
            }}
          >
            <I.Copy size={13} color={t.textDim} />
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>
              Copiar texto
            </span>
          </button>

          {/* Delete: own message always; any message if admin */}
          {(isAdmin || contextMenu.senderId === myAegisId) && (
            <button
              onClick={() => handleDeleteMsg(contextMenu.messageId)}
              aria-label="Eliminar mensaje"
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 14px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <I.Trash size={13} color='#e53e3e' />
              <span style={{ fontFamily: t.font, fontSize: 13, color: '#e53e3e' }}>
                Eliminar mensaje
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
