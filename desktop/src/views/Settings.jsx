import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store/index.js';
import { clearIdentity } from '../crypto/identity.js';
import { disconnectFromRelay } from '../socket/client.js';
import { loadSetting, saveSetting } from '../db/local.js';

const SETTING_KEYS = [
  'read_receipts_enabled',
  'ephemeral_default_seconds',
  'notifications_enabled',
  'sound_enabled',
  'theme',
];

const SETTING_DEFAULTS = {
  read_receipts_enabled: true,
  ephemeral_default_seconds: null,
  notifications_enabled: true,
  sound_enabled: true,
  theme: 'dark',
};

function parseSetting(key, raw) {
  if (raw === null || raw === undefined) return SETTING_DEFAULTS[key];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const n = Number(raw);
  return isNaN(n) ? raw : n;
}

export default function Settings({ t, onClose, onPanic, onOpenBackup, setView }) {
  const identity = useStore((s) => s.identity);
  const setSetting = useStore((s) => s.setSetting);
  const storeSettings = useStore((s) => s.settings);
  const storeState = useStore((s) => s);

  const [copiedField, setCopiedField] = useState(null);
  const [showPanicConfirm, setShowPanicConfirm] = useState(false);
  const [panicPhrase, setPanicPhrase] = useState('');
  const [wiping, setWiping] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 3-click panic activation state
  const panicClicksRef = useRef(0);
  const panicTimerRef = useRef(null);

  // Load settings from DB on mount
  useEffect(() => {
    async function load() {
      for (const key of SETTING_KEYS) {
        const raw = await loadSetting(key);
        const value = parseSetting(key, raw);
        setSetting(key, value);
        // Apply theme on load
        if (key === 'theme' && raw) {
          document.documentElement.setAttribute('data-theme', raw);
        }
      }
      setLoaded(true);
    }
    load();
  }, [setSetting]);

  async function handleToggle(key, value) {
    setSetting(key, value);
    await saveSetting(key, value);

    if (key === 'theme') {
      document.documentElement.setAttribute('data-theme', value ? 'dark' : 'light');
    }

    // Request notification permission when enabling
    if (key === 'notifications_enabled' && value === true) {
      try {
        if (Notification.permission === 'default') {
          await Notification.requestPermission();
        }
      } catch { /* ignore */ }
    }
  }

  async function handleThemeToggle(isDark) {
    const theme = isDark ? 'dark' : 'light';
    setSetting('theme', theme);
    await saveSetting('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  }

  function copyToClipboard(text, field) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    });
  }

  function handlePanicButtonClick() {
    panicClicksRef.current += 1;
    if (panicTimerRef.current) clearTimeout(panicTimerRef.current);
    panicTimerRef.current = setTimeout(() => {
      panicClicksRef.current = 0;
    }, 2000);
    if (panicClicksRef.current >= 3) {
      panicClicksRef.current = 0;
      clearTimeout(panicTimerRef.current);
      setShowPanicConfirm(true);
    }
  }

  async function handlePanic() {
    if (panicPhrase.trim().toUpperCase() !== 'BORRAR TODO') return;
    setWiping(true);
    try {
      disconnectFromRelay();
      // 1. Clear DB data
      try {
        const d = window.db;
        if (d) {
          await d.run('DELETE FROM messages', []);
          await d.run('DELETE FROM contacts', []);
          await d.run('DELETE FROM ratchet_sessions', []);
          await d.run('DELETE FROM scheduled_messages', []);
        }
      } catch { /* best effort */ }
      // 2. Clear identity from secure store
      await clearIdentity();
      // 3. Clear Zustand store
      useStore.setState({
        identity: null,
        contacts: [],
        messages: {},
        conversations: {},
        groups: [],
        groupMessages: {},
      });
      // 4. Navigate to onboarding
      if (setView) {
        setView('onboarding');
      } else if (onPanic) {
        onPanic();
      } else {
        window.location.reload();
      }
    } catch {
      setWiping(false);
    }
  }

  const aegisId = identity?.aegisId ?? '—';
  const pubKeyB64 = identity?.publicKeyB64 ?? '—';
  const signPubKeyB64 = identity?.signingPublicKeyB64 ?? '—';

  const isDark = storeSettings.theme !== 'light';

  // Data export
  function handleExportData() {
    try {
      const d = window.db;
      if (!d) return;
      d.all('SELECT * FROM messages ORDER BY created_at', []).then((data) => {
        const json = JSON.stringify({ exportedAt: Date.now(), messages: data }, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'aegislink-export.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 520,
          maxHeight: '80vh',
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 22px',
            borderBottom: `1px solid ${t.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 16, color: t.text }}>
            Configuración
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', padding: 4 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Identity section */}
          <Section label="IDENTIDAD" t={t}>
            <InfoRow label="AegisID" value={aegisId} mono t={t}
              onCopy={() => copyToClipboard(aegisId, 'aegisId')}
              copied={copiedField === 'aegisId'} />
            <InfoRow label="Clave pública (X25519)" value={pubKeyB64} truncate mono t={t}
              onCopy={() => copyToClipboard(pubKeyB64, 'pubKey')}
              copied={copiedField === 'pubKey'} />
            <InfoRow label="Clave de firma (Ed25519)" value={signPubKeyB64} truncate mono t={t}
              onCopy={() => copyToClipboard(signPubKeyB64, 'signKey')}
              copied={copiedField === 'signKey'} />
          </Section>

          {/* Apariencia section */}
          <Section label="APARIENCIA" t={t}>
            <ToggleRow
              label="Tema"
              detail={isDark ? 'Modo oscuro activo' : 'Modo claro activo'}
              t={t}
              on={isDark}
              onChange={(v) => handleThemeToggle(v)}
              labelOn="Oscuro"
              labelOff="Claro"
            />
          </Section>

          {/* Privacy section */}
          <Section label="PRIVACIDAD" t={t}>
            <ToggleRow
              label="Confirmaciones de lectura"
              detail="Enviar y recibir ticks de lectura"
              t={t}
              on={storeSettings.read_receipts_enabled}
              onChange={(v) => handleToggle('read_receipts_enabled', v)}
            />
            <ToggleRow
              label="Notificaciones de escritorio"
              detail="Mostrar notificación al llegar mensajes (sin revelar contenido)"
              t={t}
              on={storeSettings.notifications_enabled}
              onChange={(v) => handleToggle('notifications_enabled', v)}
            />
            <ToggleRow
              label="Sonido de notificación"
              detail="Reproducir sonido al llegar mensajes"
              t={t}
              on={storeSettings.sound_enabled}
              onChange={(v) => handleToggle('sound_enabled', v)}
            />
          </Section>

          {/* Backup section */}
          <Section label="BACKUP Y RESTAURACIÓN" t={t}>
            <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, lineHeight: 1.5, marginBottom: 4 }}>
              Exporta tu frase semilla o conversaciones cifradas para restaurarlas en otro dispositivo.
            </div>
            <button
              onClick={() => { onClose(); if (onOpenBackup) onOpenBackup(); }}
              style={{
                width: '100%',
                padding: '10px 0',
                background: 'transparent',
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusS,
                color: t.text,
                fontFamily: t.font,
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              Gestionar backup
            </button>
          </Section>

          {/* Data export section */}
          <Section label="EXPORTAR DATOS" t={t}>
            <div style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, lineHeight: 1.5, marginBottom: 4 }}>
              Exporta todas tus conversaciones como JSON (sin cifrar — úsalo con cuidado).
            </div>
            <button
              onClick={handleExportData}
              style={{
                width: '100%',
                padding: '10px 0',
                background: 'transparent',
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusS,
                color: t.text,
                fontFamily: t.font,
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M12 18v-6M9 15l3 3 3-3" />
              </svg>
              Exportar conversaciones
            </button>
          </Section>

          {/* About section */}
          <Section label="ACERCA DE" t={t}>
            <InfoRow label="Versión" value="AegisLink Desktop 0.1.0" t={t} />
            <InfoRow label="Protocolo" value="Double Ratchet + X3DH · NaCl secretbox" t={t} />
            <InfoRow label="Metadatos almacenados" value="0 bytes — por diseño" t={t} accent />
          </Section>

          {/* Danger zone */}
          <Section label="ZONA DE PELIGRO" t={t} danger>
            {!showPanicConfirm ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: t.font, fontSize: 12, color: t.textMuted, lineHeight: 1.5 }}>
                  Haz clic 3 veces en menos de 2 segundos para activar el modo pánico.
                </div>
                <button
                  onClick={handlePanicButtonClick}
                  style={{
                    width: '100%',
                    padding: '11px 0',
                    background: 'transparent',
                    border: `1px solid ${t.danger}`,
                    borderRadius: t.radiusS,
                    color: t.danger,
                    fontFamily: t.font,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                  Modo pánico — borrar todo y relanzar
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontFamily: t.font, fontSize: 13, color: t.danger, lineHeight: 1.5 }}>
                  Esta acción borra tu identidad, todos los mensajes y claves de este dispositivo de forma irreversible. Escribe <b>BORRAR TODO</b> para confirmar.
                </div>
                <input
                  value={panicPhrase}
                  onChange={(e) => setPanicPhrase(e.target.value)}
                  placeholder="BORRAR TODO"
                  style={{
                    background: t.surface2,
                    border: `1px solid ${t.danger}`,
                    borderRadius: t.radiusS,
                    color: t.danger,
                    fontFamily: t.fontMono,
                    fontSize: 13,
                    padding: '8px 12px',
                    outline: 'none',
                    letterSpacing: '0.06em',
                  }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => { setShowPanicConfirm(false); setPanicPhrase(''); }}
                    style={{ flex: 1, padding: '9px 0', background: 'transparent', border: `1px solid ${t.border}`, borderRadius: t.radiusS, color: t.textMuted, fontFamily: t.font, fontSize: 13, cursor: 'pointer' }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handlePanic}
                    disabled={panicPhrase.trim().toUpperCase() !== 'BORRAR TODO' || wiping}
                    style={{
                      flex: 1,
                      padding: '9px 0',
                      background: panicPhrase.trim().toUpperCase() === 'BORRAR TODO' ? t.danger : t.surface2,
                      border: 'none',
                      borderRadius: t.radiusS,
                      color: panicPhrase.trim().toUpperCase() === 'BORRAR TODO' ? '#fff' : t.textMuted,
                      fontFamily: t.font,
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: panicPhrase.trim().toUpperCase() === 'BORRAR TODO' ? 'pointer' : 'default',
                    }}
                  >
                    {wiping ? 'Borrando…' : 'Borrar todo'}
                  </button>
                </div>
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children, t, danger }) {
  return (
    <div style={{ padding: '18px 22px', borderBottom: `1px solid ${t.divider ?? t.border}` }}>
      <div style={{ fontFamily: t.fontMono, fontSize: 10, color: danger ? t.danger : t.textMuted, letterSpacing: '0.1em', marginBottom: 14 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono, truncate, accent, t, onCopy, copied }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontFamily: t.font, fontSize: 13, color: t.textMuted, flexShrink: 0, paddingTop: 1 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{
          fontFamily: mono ? t.fontMono : t.font,
          fontSize: mono ? 11 : 13,
          color: accent ? t.accent : t.text,
          overflow: truncate ? 'hidden' : undefined,
          textOverflow: truncate ? 'ellipsis' : undefined,
          whiteSpace: truncate ? 'nowrap' : undefined,
          maxWidth: truncate ? 220 : undefined,
          letterSpacing: mono ? '0.03em' : undefined,
        }}>
          {value}
        </span>
        {onCopy && (
          <button
            onClick={onCopy}
            title="Copiar"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? t.accent : t.textMuted, display: 'flex', padding: 2, flexShrink: 0 }}
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function ToggleRow({ label, detail, on, onChange, t, labelOn, labelOff }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div>
        <div style={{ fontFamily: t.font, fontSize: 13, color: t.text }}>{label}</div>
        {detail && <div style={{ fontFamily: t.font, fontSize: 11, color: t.textMuted, marginTop: 2 }}>{detail}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {labelOff && (
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: !on ? t.accent : t.textMuted, letterSpacing: '0.06em' }}>
            {labelOff}
          </span>
        )}
        <button
          onClick={() => onChange(!on)}
          style={{
            width: 38,
            height: 22,
            borderRadius: 11,
            background: on ? t.accent : t.surface2,
            border: `1px solid ${on ? t.accent : t.border}`,
            cursor: 'pointer',
            position: 'relative',
            flexShrink: 0,
            transition: 'background 0.2s',
            padding: 0,
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
              background: '#fff',
              transition: 'left 0.2s',
            }}
          />
        </button>
        {labelOn && (
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: on ? t.accent : t.textMuted, letterSpacing: '0.06em' }}>
            {labelOn}
          </span>
        )}
      </div>
    </div>
  );
}
