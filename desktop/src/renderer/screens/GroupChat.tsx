import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { useIdentity } from '../store/identity';
import { useMessages } from '../store/messages';
import { useConnection } from '../store/connection';
import { usePollsStore } from '../store/polls';
import { parseGroupPostMarker } from '../utils/groupPost';

// ---------------------------------------------------------------------------
// Stub types
// ---------------------------------------------------------------------------

interface StoredMessage {
  id: string;
  chatId: string;
  body: string;
  direction: 'in' | 'out';
  type: 'text' | 'image' | 'audio' | 'file';
  createdAt: number;
  mediaUri?: string | null;
  deleted?: boolean;
  starred?: boolean;
  reactions?: Record<string, string[]>;
  deliveryStatus?: 'sent' | 'delivered' | 'read';
}

interface StoredGroup {
  id: string;
  name: string;
  members: string[];
  adminId?: string;
  moderators?: string[];
  avatarColor?: string;
  avatarImage?: string;
  createdAt: number;
}

interface PollResult {
  counts: number[];
  myVote: number | null;
}

function colorFromId(id: string): string {
  const palette = ['#5bf2b9', '#06b6d4', '#a78bfa', '#f59e0b', '#ec4899', '#3b82f6', '#10b981', '#8b5cf6'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

function parsePollBody(body: string): { question: string; options: string[] } | null {
  if (!body.startsWith('[poll:') || !body.endsWith(']')) return null;
  const inner = body.slice(6, -1);
  const parts = inner.split('|');
  if (parts.length < 3) return null;
  return { question: parts[0].trim(), options: parts.slice(1).map((o) => o.trim()) };
}

function highlightMentions(text: string, names: string[]): { text: string; mention: boolean }[] {
  if (!text || names.length === 0) return [{ text, mention: false }];
  const pattern = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'gi');
  const split = text.split(pattern);
  return split.map((s) => ({ text: s, mention: !!s.match(pattern) }));
}

// ---------------------------------------------------------------------------

interface Props {
  group: StoredGroup;
  onBack: () => void;
  onGroupDetail?: () => void;
  onPoll?: () => void;
  onGroupPosts?: () => void;
}

export function GroupChatScreen({ group, onBack, onGroupDetail, onPoll, onGroupPosts }: Props) {
  const { t } = useTheme();
  const identity = useIdentity((s) => s.identity);
  const myAegisId = identity?.aegisId;
  const online = useConnection((s) => s.online);
  const pollResultsMap = usePollsStore((s) => s.results);

  const byChat = useMessages((s) => s.byChat);
  const loadChat = useMessages((s) => s.loadChat);
  const markRead = useMessages((s) => s.markRead);

  const list: StoredMessage[] = (byChat[group.id] as StoredMessage[] | undefined) ?? [];

  const pollResults: Record<string, PollResult> = {};
  for (const [msgId, result] of Object.entries(pollResultsMap)) {
    pollResults[msgId] = { counts: result.counts, myVote: result.myVote ?? null };
  }

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const memberNames: Record<string, string> = {};

  useEffect(() => {
    void loadChat(group.id);
    void markRead(group.id);
  }, [group.id]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [list.length]);


  const mentionMatches = mentionQuery !== null
    ? group.members
        .map((id) => ({ id, name: memberNames[id] ?? id }))
        .filter(({ name }) => name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
        .slice(0, 5)
    : [];

  function handleDraftChange(e: React.ChangeEvent<HTMLInputElement>) {
    const text = e.target.value;
    setDraft(text);
    const atMatch = text.match(/@(\w*)$/);
    setMentionQuery(atMatch ? atMatch[1] : null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function insertMention(name: string) {
    const replaced = draft.replace(/@(\w*)$/, `@${name} `);
    setDraft(replaced);
    setMentionQuery(null);
  }

  async function handleSend() {
    if (!draft.trim() || sending || !identity) return;
    const text = draft.trim();
    setDraft('');
    setMentionQuery(null);
    setSending(true);
    setErrorMsg(null);
    try {
      // sendGroupMessage encrypts a copy to every member over the ratchet AND
      // performs the optimistic local append itself — previously handleSend only
      // appended locally, so group messages never left the device.
      const { sendGroupMessage } = await import('../socket/client');
      await sendGroupMessage({ identity, groupId: group.id, plaintext: text });
    } catch (e) {
      setErrorMsg((e as Error).message);
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  function handleVote(pollMessageId: string, optionIndex: number) {
    const pollMsg = list.find((m) => m.id === pollMessageId);
    const poll = pollMsg ? parsePollBody(pollMsg.body) : null;
    const totalOptions = poll ? poll.options.length : 2;
    usePollsStore.getState().castVote(pollMessageId, group.id, optionIndex, totalOptions);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      {/* Header */}
      <div style={{ height: 56, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 12, borderBottom: `1px solid ${t.divider}`, gap: 8, flexShrink: 0 }}>
        <button onClick={onBack} aria-label="Back" style={iconBtn}>
          <I.ChevronL size={22} color={t.text} />
        </button>
        <button
          onClick={onGroupDetail}
          aria-label={`View group ${group.name}`}
          style={{ flex: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0, background: 'none', border: 'none', cursor: onGroupDetail ? 'pointer' : 'default', padding: 0, textAlign: 'left' }}
        >
          <Avatar t={t} name={group.avatarImage ?? group.name} color={group.avatarColor ?? t.accent} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontFamily: t.font, fontSize: 16, fontWeight: '600', color: t.text, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {group.name}
            </span>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <I.Lock size={10} color={t.accent} />
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5 }}>
                E2EE · {group.members.length} MEMBERS
              </span>
            </div>
          </div>
        </button>
        {onPoll && (
          <button onClick={onPoll} aria-label="Create poll" style={iconBtn}>
            <I.Poll size={20} color={t.textDim} />
          </button>
        )}
        {/* Announcements — visible only to owner and moderators */}
        {onGroupPosts && (group.adminId === myAegisId || group.moderators?.includes(myAegisId ?? '')) && (
          <button onClick={onGroupPosts} aria-label="Schedule group announcement" style={iconBtn}>
            <I.Broadcast size={20} color={t.textDim} />
          </button>
        )}
        {onGroupDetail && (
          <button onClick={onGroupDetail} aria-label="Group info" style={iconBtn}>
            <I.More size={20} color={t.textDim} />
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', paddingLeft: 14, paddingRight: 14, paddingTop: 12, paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {list.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.textFaint }}>No messages yet</span>
          </div>
        )}
        {list.map((item) => (
          <GroupBubble
            key={item.id}
            t={t}
            m={item}
            myAegisId={myAegisId}
            memberNames={memberNames}
            adminId={group.adminId}
            moderators={group.moderators}
            onContextMenu={() => {}}
            pollResult={pollResults[item.id]}
            onVote={(optionIndex) => handleVote(item.id, optionIndex)}
          />
        ))}
      </div>

      {/* Mention autocomplete */}
      {mentionMatches.length > 0 && (
        <div style={{ backgroundColor: t.surface, borderTop: `1px solid ${t.border}`, flexShrink: 0 }}>
          {mentionMatches.map(({ id, name }) => (
            <button
              key={id}
              onClick={() => insertMention(name)}
              aria-label={`Mention ${name}`}
              style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 16, paddingRight: 16, paddingTop: 10, paddingBottom: 10, backgroundColor: 'transparent', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}
            >
              <Avatar t={t} name={name} color={colorFromId(id)} size={28} />
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>@{name}</span>
            </button>
          ))}
        </div>
      )}

      {errorMsg && (
        <div style={{ padding: '6px 14px', backgroundColor: `${t.danger}22`, flexShrink: 0 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger }}>{errorMsg}</span>
        </div>
      )}

      {/* Input bar */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 12, borderTop: `1px solid ${t.divider}`, gap: 8, flexShrink: 0 }}>
        <input
          value={draft}
          onChange={handleDraftChange}
          onKeyDown={handleKeyDown}
          placeholder="Group message…"
          style={{ flex: 1, border: `1px solid ${t.border}`, borderRadius: 22, paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 8, fontSize: 15, color: t.text, backgroundColor: t.surface2, fontFamily: t.font, outline: 'none', maxHeight: 100 }}
        />
        <button
          onClick={() => void handleSend()}
          disabled={!draft.trim() || sending}
          aria-label="Send group message"
          style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: draft.trim() && online ? t.accent : t.surface2, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: !draft.trim() || sending ? 'not-allowed' : 'pointer', flexShrink: 0 }}
        >
          <I.Send size={18} color={draft.trim() && online ? t.accentInk : t.textDim} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupBubble
// ---------------------------------------------------------------------------

interface GroupBubbleProps {
  t: Theme;
  m: StoredMessage;
  myAegisId?: string;
  memberNames: Record<string, string>;
  adminId?: string;
  moderators?: string[];
  onContextMenu: () => void;
  pollResult?: PollResult;
  onVote: (optionIndex: number) => void;
}

function GroupBubble({ t, m, myAegisId, memberNames, adminId, moderators, onContextMenu, pollResult, onVote }: GroupBubbleProps) {
  const me = m.direction === 'out';
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const reactions = m.reactions ? Object.entries(m.reactions).filter(([, ids]) => ids.length > 0) : [];

  let sender = '';
  let body = m.body;
  let senderId = '';
  if (!me && body.includes(': ')) {
    const colonIdx = body.indexOf(': ');
    sender = body.substring(0, colonIdx);
    body = body.substring(colonIdx + 2);
    senderId = Object.entries(memberNames).find(([, n]) => n === sender)?.[0] ?? sender;
  }
  const senderColor = senderId ? colorFromId(senderId) : t.accent;
  const senderIsAdmin = senderId && adminId ? senderId === adminId : false;
  const senderIsMod = senderId && moderators ? moderators.includes(senderId) : false;

  function SenderLabel() {
    if (!sender) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</span>
        {senderIsAdmin && <div style={{ backgroundColor: `${t.accent}22`, paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1, borderRadius: 3 }}><span style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</span></div>}
        {senderIsMod && <div style={{ backgroundColor: `${t.warn}22`, paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1, borderRadius: 3 }}><span style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>MOD</span></div>}
      </div>
    );
  }

  if (m.deleted) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <SenderLabel />
        <div style={{ backgroundColor: t.surface2, paddingLeft: 13, paddingRight: 13, paddingTop: 8, paddingBottom: 8, borderRadius: t.radius, display: 'flex', alignItems: 'center', gap: 6 }}>
          <I.Trash size={13} color={t.textFaint} />
          <span style={{ color: t.textFaint, fontFamily: t.font, fontSize: 13, fontStyle: 'italic' }}>Deleted message</span>
        </div>
        <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginTop: 3, paddingLeft: 4, paddingRight: 4 }}>{time}</span>
      </div>
    );
  }

  // Announcement post — render BEFORE poll so [post:...] always wins. The
  // image prefix is already stripped from `body` by client.ts (incoming) or by
  // the sender's local append (outgoing), so we only see the [post:flags]Text
  // portion here. The marker is parsed and the body shown without it.
  const post = parseGroupPostMarker(body);
  if (post.isPost) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <SenderLabel />
        <div
          style={{
            maxWidth: 320,
            backgroundColor: t.surface,
            border: `1px solid ${post.pinned ? t.warn : `${t.accent}55`}`,
            borderRadius: t.radius,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <I.Broadcast size={12} color={t.accent} />
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.6 }}>
              ANNOUNCEMENT
            </span>
            {post.pinned && (
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.warn, letterSpacing: 0.4 }}>
                · PINNED
              </span>
            )}
            {post.repliesOff && (
              <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, letterSpacing: 0.4 }}>
                · READ-ONLY
              </span>
            )}
          </div>
          {m.mediaUri && m.type === 'image' && (
            <img
              src={m.mediaUri}
              alt="announcement"
              style={{ maxWidth: '100%', maxHeight: 240, borderRadius: t.radiusS, objectFit: 'cover' }}
            />
          )}
          {post.text && (
            <span style={{ fontFamily: t.font, fontSize: 14, color: t.text, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {post.text}
            </span>
          )}
          <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginTop: 2 }}>{time}</span>
        </div>
        <ReactionPills t={t} reactions={reactions} me={me} />
      </div>
    );
  }

  // Poll
  const poll = parsePollBody(body);
  if (poll) {
    const totalVotes = pollResult ? pollResult.counts.reduce((a: number, b: number) => a + b, 0) : 0;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <SenderLabel />
        <div style={{ width: 260, backgroundColor: me ? t.bubbleOut : t.bubbleIn, borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, padding: 12 }}>
          <span style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: me ? t.bubbleOutText : t.text, display: 'block', marginBottom: 10 }}>{poll.question}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {poll.options.map((opt, idx) => {
              const votes = pollResult?.counts[idx] ?? 0;
              const pct = totalVotes > 0 ? votes / totalVotes : 0;
              const selected = pollResult?.myVote === idx;
              return (
                <button
                  key={idx}
                  onClick={() => onVote(idx)}
                  aria-label={`Vote for ${opt}`}
                  style={{ position: 'relative', height: 38, borderRadius: 6, border: `1px solid ${selected ? t.accent : t.border}`, display: 'flex', alignItems: 'center', paddingLeft: 12, paddingRight: 12, overflow: 'hidden', cursor: 'pointer', backgroundColor: 'transparent' }}
                >
                  <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: `${pct * 100}%`, backgroundColor: selected ? `${t.accent}28` : `${t.text}0d`, borderRadius: 6 }} />
                  <span style={{ flex: 1, fontFamily: t.font, fontSize: 13, color: me ? t.bubbleOutText : t.text, fontWeight: selected ? '600' : '400', position: 'relative' }}>{opt}</span>
                  <span style={{ fontFamily: t.fontMono, fontSize: 12, color: me ? t.bubbleOutText : t.textDim, position: 'relative' }}>{votes}</span>
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 8, borderTop: `1px solid ${me ? 'rgba(255,255,255,0.15)' : t.divider}` }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 9.5, color: me ? t.bubbleOutText : t.textDim }}>Anonymous Poll · {totalVotes} votes</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 9.5, color: me ? t.bubbleOutText : t.textDim }}>{time}</span>
          </div>
        </div>
        <ReactionPills t={t} reactions={reactions} me={me} />
      </div>
    );
  }

  // Image
  if (m.type === 'image' && m.mediaUri) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <SenderLabel />
        <div onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }} style={{ borderRadius: t.radius, overflow: 'hidden', cursor: 'context-menu' }}>
          <img src={m.mediaUri} alt="group image" style={{ width: 200, height: 150, objectFit: 'cover', display: 'block', backgroundColor: t.surface2 }} />
        </div>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingLeft: 4, paddingRight: 4 }}>{time}</span>
      </div>
    );
  }

  // Audio with playback
  if (m.type === 'audio') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
        <SenderLabel />
        <GroupAudioBubble t={t} m={m} me={me} time={time} />
      </div>
    );
  }

  // Text
  const parts = highlightMentions(body, Object.values(memberNames));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
      <SenderLabel />
      <div
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(); }}
        style={{ backgroundColor: me ? t.bubbleOut : t.bubbleIn, paddingLeft: 13, paddingRight: 13, paddingTop: 10, paddingBottom: 10, borderRadius: t.radius, borderTopRightRadius: me ? t.radiusS : t.radius, borderTopLeftRadius: me ? t.radius : t.radiusS, cursor: 'context-menu' }}
      >
        <span style={{ fontFamily: t.font, fontSize: 15, lineHeight: '21px', color: me ? t.bubbleOutText : t.text }}>
          {parts.map((p, i) => p.mention
            ? <span key={i} style={{ color: t.accent, fontWeight: '600' }}>{p.text}</span>
            : <span key={i}>{p.text}</span>
          )}
        </span>
      </div>
      <ReactionPills t={t} reactions={reactions} me={me} />
      <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingLeft: 4, paddingRight: 4 }}>{time}</span>
    </div>
  );
}

function GroupAudioBubble({ t, m, me, time }: { t: Theme; m: StoredMessage; me: boolean; time: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    if (!m.mediaUri) return;
    const audio = new Audio(m.mediaUri);
    audioRef.current = audio;
    audio.addEventListener('loadedmetadata', () => setDuration(audio.duration));
    audio.addEventListener('timeupdate', () => {
      setCurrentTime(audio.currentTime);
      setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
    });
    audio.addEventListener('ended', () => { setPlaying(false); setProgress(0); setCurrentTime(0); });
    return () => { audio.pause(); audio.src = ''; };
  }, [m.mediaUri]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { void audio.play(); setPlaying(true); }
  }

  function fmt(s: number) {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, width: 230, backgroundColor: me ? t.bubbleOut : t.bubbleIn, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10, borderRadius: t.radius }}>
        <button
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: me ? 'rgba(255,255,255,0.2)' : t.surface3, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer', flexShrink: 0 }}
        >
          {playing
            ? <I.Pause size={15} color={me ? t.bubbleOutText : t.bubbleInText} />
            : <I.Play size={15} color={me ? t.bubbleOutText : t.bubbleInText} />
          }
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ height: 4, borderRadius: 2, backgroundColor: me ? 'rgba(255,255,255,0.2)' : t.surface3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress * 100}%`, backgroundColor: me ? t.bubbleOutText : t.accent, borderRadius: 2 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: me ? t.bubbleOutText : t.textDim }}>{fmt(currentTime)}</span>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: me ? `${t.bubbleOutText}88` : t.textFaint }}>{fmt(duration)}</span>
          </div>
        </div>
      </div>
      <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3 }}>{time}</span>
    </>
  );
}

function ReactionPills({ t, reactions, me }: { t: Theme; reactions: [string, string[]][]; me: boolean }) {
  if (reactions.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4, justifyContent: me ? 'flex-end' : 'flex-start' }}>
      {reactions.map(([emoji, ids]) => (
        <div key={emoji} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: t.surface2, borderRadius: 99, paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3, border: `1px solid ${t.border}` }}>
          <span style={{ fontSize: 13 }}>{emoji}</span>
          {ids.length > 1 && <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{ids.length}</span>}
        </div>
      ))}
    </div>
  );
}

const iconBtn: CSSProperties = {
  padding: 6,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};
