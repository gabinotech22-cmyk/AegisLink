import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';

interface Props {
  groupName?: string;
  memberCount?: number;
  onBack: () => void;
  onSend?: (question: string, options: string[]) => void;
}

export function PollScreen({ groupName, memberCount, onBack, onSend }: Props) {
  const { t } = useTheme();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [sending, setSending] = useState(false);

  function updateOption(idx: number, val: string) {
    setOptions((prev) => prev.map((o, i) => (i === idx ? val : o)));
  }

  function addOption() {
    if (options.length >= 6) return;
    setOptions((prev) => [...prev, '']);
  }

  function removeOption(idx: number) {
    if (options.length <= 2) return;
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleSend() {
    const q = question.trim();
    const filled = options.map((o) => o.trim()).filter(Boolean);
    if (!q) { window.alert('Enter a question.'); return; }
    if (filled.length < 2) { window.alert('Add at least 2 options.'); return; }
    if (!onSend) return;
    setSending(true);
    try { onSend(q, filled); } finally { setSending(false); }
  }

  const inputBase = {
    fontFamily: t.font, fontSize: 14, color: t.text,
    backgroundColor: t.surface, border: `1px solid ${t.border}`,
    borderRadius: t.radiusS, padding: '10px 12px',
    boxSizing: 'border-box' as const, width: '100%',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${t.divider}` }}>
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
          <I.ChevronL size={22} color={t.text} />
        </button>
        <div style={{ width: 36, height: 36, borderRadius: t.radiusL ?? t.radius, backgroundColor: `${t.accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <I.Poll size={18} color={t.accent} />
        </div>
        <div style={{ flex: 1 }}>
          <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 15, color: t.text, display: 'block' }}>Create poll</span>
          {groupName && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
              <I.Lock size={9} color={t.accent} />
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.6 }}>
                {groupName.toUpperCase()}{memberCount ? ` · ${memberCount} members` : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 32px', boxSizing: 'border-box' }}>
        {/* Anonymous badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 18 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, border: `1px solid ${t.accent}`, borderRadius: 99, padding: '2px 7px', letterSpacing: 0.8 }}>
            ANONYMOUS
          </span>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4 }}>
            Votes are cryptographically mixed
          </span>
        </div>

        {/* Question */}
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 6 }}>
          QUESTION
        </span>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask your question…"
          rows={3}
          style={{ ...inputBase, fontFamily: t.fontDisplay, fontSize: 17, fontWeight: '600', lineHeight: '24px', resize: 'vertical', marginBottom: 22, border: `1px solid ${t.borderStrong}`, borderRadius: t.radius }}
        />

        {/* Options */}
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>
          OPTIONS ({options.length}/6)
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {options.map((opt, idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 22, height: 22, borderRadius: 11, border: `2px solid ${t.borderStrong}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim }}>{String.fromCharCode(65 + idx)}</span>
              </div>
              <input
                value={opt}
                onChange={(e) => updateOption(idx, e.target.value)}
                placeholder={`Option ${String.fromCharCode(65 + idx)}`}
                style={{ ...inputBase, flex: 1 }}
              />
              {options.length > 2 && (
                <button
                  onClick={() => removeOption(idx)}
                  aria-label="Remove option"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, flexShrink: 0 }}
                >
                  <I.X size={16} color={t.textDim} />
                </button>
              )}
            </div>
          ))}
        </div>

        {options.length < 6 && (
          <button
            onClick={addOption}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 22 }}
            aria-label="Add option"
          >
            <div style={{ width: 22, height: 22, borderRadius: 11, border: `1.5px dashed ${t.accent}66`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <I.Plus size={12} color={t.accent} />
            </div>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.accent }}>Add option</span>
          </button>
        )}

        {/* Anonymity notice */}
        <div style={{ padding: 12, backgroundColor: t.surface, borderRadius: t.radiusS, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, border: `1px solid ${t.border}` }}>
          <I.EyeOff size={13} color={t.textDim} />
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.4, flex: 1 }}>
            Individual votes cannot be linked to identities. Results only show totals.
          </span>
        </div>

        <button
          onClick={handleSend}
          disabled={sending || !onSend}
          aria-label="Create poll"
          style={{
            width: '100%', padding: '14px 0', backgroundColor: t.accent, border: 'none',
            borderRadius: t.radius, cursor: sending || !onSend ? 'not-allowed' : 'pointer',
            fontFamily: t.font, fontWeight: '600', fontSize: 15, color: t.accentInk,
            opacity: sending || !onSend ? 0.7 : 1,
          }}
        >
          {sending ? 'Sending…' : 'Create poll'}
        </button>
      </div>
    </div>
  );
}
