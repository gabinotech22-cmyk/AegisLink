import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { AegisMark } from '../components/AegisMark';
import { I } from '../components/icons';

interface Props {
  onNewIdentity: () => void;
  onRestore: () => void;
  onLinkMobile: () => void;
}

interface CardButtonProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  primary?: boolean;
  onClick: () => void;
  accent: string;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  font: string;
  fontMono: string;
  accentInk: string;
  radius: number;
}

function CardButton({
  icon,
  label,
  description,
  primary = false,
  onClick,
  accent,
  bg,
  surface,
  surface2,
  border,
  borderStrong,
  text,
  textDim,
  font,
  fontMono,
  accentInk,
  radius,
}: CardButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const cardStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: '16px 18px',
    borderRadius: radius,
    border: primary
      ? `1.5px solid ${accent}`
      : `1px solid ${hovered ? borderStrong : border}`,
    backgroundColor: primary
      ? hovered
        ? `${accent}22`
        : `${accent}14`
      : hovered
      ? surface2
      : surface,
    cursor: 'pointer',
    width: '100%',
    boxSizing: 'border-box',
    transition: 'background-color 0.15s, border-color 0.15s, opacity 0.1s',
    opacity: pressed ? 0.75 : 1,
    outline: 'none',
    textAlign: 'left',
  };

  const iconStyle: CSSProperties = {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: primary ? `${accent}28` : bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: primary ? accent : text,
  };

  return (
    <button
      style={cardStyle}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      aria-label={label}
    >
      <div style={iconStyle}>
        {icon}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontFamily: font,
            fontSize: 15,
            fontWeight: '600',
            color: primary ? accent : text,
            letterSpacing: -0.2,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: fontMono,
            fontSize: 10,
            color: primary ? accent : textDim,
            letterSpacing: 0.4,
            opacity: primary ? 0.8 : 1,
          }}
        >
          {description}
        </span>
      </div>
      <div style={{ marginLeft: 'auto', color: primary ? accent : textDim, fontSize: 16, opacity: 0.6 }}>
        ›
      </div>
    </button>
  );
}

export function EntryScreen({ onNewIdentity, onRestore, onLinkMobile }: Props) {
  const { t } = useTheme();

  const root: CSSProperties = {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    backgroundColor: t.bg,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const card: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: '100%',
    maxWidth: 480,
    padding: '40px 32px 28px',
    boxSizing: 'border-box',
  };

  return (
    <div style={root}>
      <div style={card}>
        {/* Logo */}
        <AegisMark t={t} size={56} />

        {/* App name */}
        <h1
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 30,
            fontWeight: '600',
            letterSpacing: -0.8,
            color: t.text,
            margin: '16px 0 6px',
          }}
        >
          AegisLink
        </h1>

        {/* Tagline */}
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.textDim,
            letterSpacing: 2,
            marginBottom: 36,
          }}
        >
          SECURE · ANONYMOUS · ON-DEVICE
        </span>

        {/* Options */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
          <CardButton
            icon={<I.QR size={20} stroke={1.8} />}
            label="Vincular con móvil"
            description="GENERAR IDENTIDAD Y MOSTRAR QR"
            primary
            onClick={onLinkMobile}
            accent={t.accent}
            bg={t.bg}
            surface={t.surface}
            surface2={t.surface2}
            border={t.border}
            borderStrong={t.borderStrong}
            text={t.text}
            textDim={t.textDim}
            font={t.font}
            fontMono={t.fontMono}
            accentInk={t.accentInk}
            radius={t.radius}
          />
          <CardButton
            icon={<I.Key size={20} stroke={1.8} />}
            label="Restaurar identidad"
            description="IMPORTAR DESDE COPIA DE SEGURIDAD"
            onClick={onRestore}
            accent={t.accent}
            bg={t.bg}
            surface={t.surface}
            surface2={t.surface2}
            border={t.border}
            borderStrong={t.borderStrong}
            text={t.text}
            textDim={t.textDim}
            font={t.font}
            fontMono={t.fontMono}
            accentInk={t.accentInk}
            radius={t.radius}
          />
          <CardButton
            icon={<I.Shield size={20} stroke={1.8} />}
            label="Nueva identidad"
            description="GENERAR CLAVES EN ESTE DISPOSITIVO"
            onClick={onNewIdentity}
            accent={t.accent}
            bg={t.bg}
            surface={t.surface}
            surface2={t.surface2}
            border={t.border}
            borderStrong={t.borderStrong}
            text={t.text}
            textDim={t.textDim}
            font={t.font}
            fontMono={t.fontMono}
            accentInk={t.accentInk}
            radius={t.radius}
          />
        </div>

        {/* Footer */}
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: 9,
            color: t.textFaint,
            letterSpacing: 1.2,
            marginTop: 32,
            textAlign: 'center',
          }}
        >
          ZERO METADATA · E2EE · OPEN SOURCE
        </span>
      </div>
    </div>
  );
}
