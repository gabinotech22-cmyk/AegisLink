import React, { useState, useEffect } from 'react';
import { useStore } from '../store/index.js';

export default function WorkSearchPanel({ t, orgId }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const setActiveChat = useStore((s) => s.setActiveChat);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      performSearch();
    }, 400);
    return () => clearTimeout(timer);
  }, [query]);

  async function performSearch() {
    setLoading(true);
    setError(null);
    try {
      const RELAY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_RELAY_URL)
        ? import.meta.env.VITE_RELAY_URL
        : 'http://localhost:3001';
        
      const res = await fetch(`${RELAY}/work/org/${encodeURIComponent(orgId)}/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      setResults(data.results || data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search workspace messages..."
          style={{
            width: '100%',
            padding: '12px 16px',
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.radius,
            color: t.text,
            fontFamily: t.font,
            fontSize: 14,
            outline: 'none',
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ color: t.textDim, fontFamily: t.font, padding: 10 }}>Searching...</div>}
        {error && <div style={{ color: t.warn, fontFamily: t.font, padding: 10 }}>{error}</div>}
        
        {!loading && !error && query && results.length === 0 && (
          <div style={{ color: t.textDim, fontFamily: t.font, padding: 10 }}>No results found.</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {results.map((r, i) => (
            <div
              key={i}
              onClick={() => {
                const channelId = r.channelId || r.channel;
                if (channelId) {
                  setActiveChat(channelId);
                }
              }}
              style={{
                background: t.surface,
                border: `1px solid ${t.border}`,
                borderRadius: t.radius,
                padding: '12px 16px',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent }}>#{r.channel || 'unknown'}</span>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{formatTime(r.time)}</span>
              </div>
              <div style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>
                <strong style={{ marginRight: 8 }}>{r.sender}:</strong>
                {r.snippet}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
