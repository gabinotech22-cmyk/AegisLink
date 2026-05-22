import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useWorkMessages } from '../store/workMessages';
import { useWork } from '../store/work';
import type { WorkMessage } from '../store/workMessages';

const WORK_ACCENT = '#6366f1';

// ─── Result type ──────────────────────────────────────────────────────────────

interface SearchResult extends WorkMessage {
  channelId: string;
}

// ─── Highlight helper ─────────────────────────────────────────────────────────

function HighlightedText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
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
          <strong
            key={i}
            style={{ backgroundColor: `${WORK_ACCENT}33`, color: WORK_ACCENT, fontWeight: 700 }}
          >
            {p.t}
          </strong>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  onOpenChannel: (channelId: string) => void;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WorkSearch({ onClose, onOpenChannel }: Props) {
  const { t } = useTheme();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const byChannel = useWorkMessages((s) => s.byChannel);
  const channels = useWork((s) => s.channels);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // All messages in memory
  const allMessages: SearchResult[] = useMemo(() => {
    return Object.entries(byChannel).flatMap(([channelId, msgs]) =>
      msgs.map((m) => ({ ...m, channelId })),
    );
  }, [byChannel]);

  // Search results — max 50, newest first
  const results: SearchResult[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allMessages
      .filter((m) => m.body.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);
  }, [query, allMessages]);

  // Group by channel
  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const existing = map.get(r.channelId) ?? [];
      existing.push(r);
      map.set(r.channelId, existing);
    }
    return map;
  }, [results]);

  function getChannelName(channelId: string): string {
    return channels.find((c) => c.channelId === channelId)?.name ?? channelId.slice(0, 12);
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function handleResultClick(result: SearchResult) {
    onOpenChannel(result.channelId);
    onClose();
  }

  return (
    // Backdrop
    <div
      onClick={onClose}
      aria-label="Cerrar búsqueda"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 80,
        zIndex: 500,
        boxSizing: 'border-box',
      }}
    >
      {/* Modal */}
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Búsqueda en workspace"
        style={{
          width: '100%',
          maxWidth: 560,
          backgroundColor: t.surface,
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(100vh - 160px)',
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 16px',
            borderBottom: `1px solid ${t.border}`,
            flexShrink: 0,
          }}
        >
          <I.Search size={18} color={t.textDim} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en canales… (Esc para cerrar)"
            aria-label="Campo de búsqueda en workspace"
            style={{
              flex: 1,
              fontFamily: t.font,
              fontSize: 15,
              color: t.text,
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
            }}
          />
          {query.length > 0 && (
            <button
              onClick={() => setQuery('')}
              aria-label="Borrar búsqueda"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                padding: 2,
                borderRadius: 4,
              }}
            >
              <I.X size={14} color={t.textDim} />
            </button>
          )}
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {query.trim() === '' ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                padding: '40px 24px',
                opacity: 0.6,
              }}
            >
              <I.Search size={28} color={t.textFaint} />
              <span
                style={{
                  fontFamily: t.font,
                  fontSize: 13,
                  color: t.textFaint,
                  textAlign: 'center',
                  lineHeight: '19px',
                }}
              >
                Escribe para buscar en los mensajes de todos los canales cargados.
                <br />
                <span style={{ fontFamily: t.fontMono, fontSize: 11, letterSpacing: 0.4 }}>
                  Cmd+K para abrir · Esc para cerrar
                </span>
              </span>
            </div>
          ) : results.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                padding: '40px 24px',
                opacity: 0.6,
              }}
            >
              <I.Search size={28} color={t.textFaint} />
              <span
                style={{
                  fontFamily: t.font,
                  fontSize: 13,
                  color: t.textFaint,
                  textAlign: 'center',
                }}
              >
                Sin resultados para &ldquo;{query.trim()}&rdquo;
              </span>
            </div>
          ) : (
            <>
              {Array.from(grouped.entries()).map(([channelId, msgs]) => (
                <div key={channelId}>
                  {/* Channel section header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '10px 16px 4px',
                      position: 'sticky',
                      top: 0,
                      backgroundColor: t.surface,
                      zIndex: 1,
                    }}
                  >
                    <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.textDim }}>
                      #
                    </span>
                    <span
                      style={{
                        fontFamily: t.fontMono,
                        fontSize: 10,
                        color: t.textDim,
                        letterSpacing: 1,
                        textTransform: 'uppercase',
                      }}
                    >
                      {getChannelName(channelId)}
                    </span>
                  </div>

                  {/* Messages in this channel */}
                  {msgs.map((result) => (
                    <button
                      key={result.id}
                      onClick={() => handleResultClick(result)}
                      aria-label={`Ir al canal con mensaje de ${result.senderId.slice(0, 8)}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        width: '100%',
                        padding: '8px 16px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        borderBottom: `1px solid ${t.border}`,
                        transition: 'background-color 0.1s',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.backgroundColor = `${WORK_ACCENT}0a`;
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: t.fontMono,
                            fontSize: 10,
                            color: WORK_ACCENT,
                            letterSpacing: 0.3,
                          }}
                        >
                          {result.senderId.slice(0, 8)}
                        </span>
                        <span
                          style={{
                            fontFamily: t.fontMono,
                            fontSize: 10,
                            color: t.textFaint,
                            marginLeft: 'auto',
                          }}
                        >
                          {formatTime(result.createdAt)}
                        </span>
                      </div>
                      <span
                        style={{
                          fontFamily: t.font,
                          fontSize: 13,
                          color: t.text,
                          lineHeight: '19px',
                          overflow: 'hidden',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}
                      >
                        <HighlightedText text={result.body} query={query.trim()} />
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer hint */}
        {results.length > 0 && (
          <div
            style={{
              padding: '8px 16px',
              borderTop: `1px solid ${t.border}`,
              display: 'flex',
              gap: 16,
              flexShrink: 0,
            }}
          >
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.4 }}>
              {results.length} resultado{results.length !== 1 ? 's' : ''}
            </span>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.4 }}>
              Enter para ir al canal
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
