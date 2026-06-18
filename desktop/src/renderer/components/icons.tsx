import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  stroke?: number;
  color?: string;
  style?: CSSProperties;
}

function IconBase({
  size = 22,
  stroke = 2,
  color,
  style,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {children}
    </svg>
  );
}

export const I = {
  Shield: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6l9-4z" />
    </IconBase>
  ),
  Lock: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={4} y={11} width={16} height={10} rx={2} />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </IconBase>
  ),
  Key: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx={8} cy={14} r={4} />
      <path d="M11 13l9-9M17 7l3 3M14 10l3 3" />
    </IconBase>
  ),
  Plus: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  ),
  Search: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx={11} cy={11} r={7} />
      <path d="M21 21l-4.3-4.3" />
    </IconBase>
  ),
  Settings: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx={12} cy={12} r={3} />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8L3.2 7a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H8a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1A2 2 0 1119.7 7l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </IconBase>
  ),
  Chat: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z" />
    </IconBase>
  ),
  Phone: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.7a2 2 0 01-.5 2.1L8 9.6a16 16 0 006 6l1.1-1.1a2 2 0 012.1-.5c.9.3 1.8.5 2.7.6a2 2 0 011.7 2.2z" />
    </IconBase>
  ),
  Video: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={2} y={6} width={14} height={12} rx={2} />
      <path d="M22 8l-6 4 6 4V8z" />
    </IconBase>
  ),
  Mic: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={9} y={2} width={6} height={12} rx={3} />
      <path d="M19 11a7 7 0 01-14 0M12 19v3" />
    </IconBase>
  ),
  MicOff: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 2l20 20M9 4.5a3 3 0 016 0V11M15 14.5a3 3 0 01-6 0V9M19 11a7 7 0 01-.8 3.3M12 19v3M5 11a7 7 0 008.7 6.8" />
    </IconBase>
  ),
  Users: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx={9} cy={7} r={4} />
      <path d="M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8" />
    </IconBase>
  ),
  Person: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx={12} cy={7} r={4} />
    </IconBase>
  ),
  Reply: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 17l-5-5 5-5" />
      <path d="M20 18v-2a4 4 0 00-4-4H4" />
    </IconBase>
  ),
  Forward: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M15 17l5-5-5-5" />
      <path d="M4 18v-2a4 4 0 014-4h12" />
    </IconBase>
  ),
  Star: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </IconBase>
  ),
  Smile: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx={12} cy={12} r={10} />
      <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
    </IconBase>
  ),
  Image: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={3} y={3} width={18} height={18} rx={2} />
      <circle cx={8.5} cy={8.5} r={1.5} />
      <path d="M21 15l-5-5L5 21" />
    </IconBase>
  ),
  QR: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={3} y={3} width={7} height={7} rx={1} />
      <rect x={14} y={3} width={7} height={7} rx={1} />
      <rect x={3} y={14} width={7} height={7} rx={1} />
      <path d="M14 14h3v3h-3zM21 14v3M14 21h7M17 17v4" />
    </IconBase>
  ),
  Timer: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx={12} cy={13} r={8} />
      <path d="M12 9v4l2 2M9 2h6" />
    </IconBase>
  ),
  Cloud: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 17H7a4 4 0 01-1-7.9 6 6 0 0111.6 1.6A3.5 3.5 0 0118 17z" />
    </IconBase>
  ),
  Check: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M20 6L9 17l-5-5" />
    </IconBase>
  ),
  Chevron: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9 18l6-6-6-6" />
    </IconBase>
  ),
  ChevronL: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M15 18l-6-6 6-6" />
    </IconBase>
  ),
  More: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx={12} cy={12} r={1} />
      <circle cx={19} cy={12} r={1} />
      <circle cx={5} cy={12} r={1} />
    </IconBase>
  ),
  Send: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </IconBase>
  ),
  Attach: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 11.5l-9 9a5.5 5.5 0 11-7.8-7.8l9-9a3.7 3.7 0 015.2 5.2l-9 9a1.8 1.8 0 11-2.6-2.6L14 8" />
    </IconBase>
  ),
  Eye: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
      <circle cx={12} cy={12} r={3} />
    </IconBase>
  ),
  EyeOff: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M17.9 17.9A11 11 0 0112 20C5 20 1 12 1 12a21 21 0 015.1-6M9.9 4.2A11 11 0 0112 4c7 0 11 8 11 8a21 21 0 01-3.2 4.5M14.1 14.1a3 3 0 11-4.2-4.2M2 2l20 20" />
    </IconBase>
  ),
  Mute: (p: IconProps) => (
    <IconBase {...p}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
      <path d="M23 9l-6 6M17 9l6 6" />
    </IconBase>
  ),
  Flip: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 7v4a2 2 0 002 2h11l-3-3M21 17v-4a2 2 0 00-2-2H8l3-3" />
    </IconBase>
  ),
  X: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 6L6 18M6 6l12 12" />
    </IconBase>
  ),
  Bell: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M14 21a2 2 0 01-4 0" />
    </IconBase>
  ),
  Broadcast: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M5 16c-1.61-1.61-2.5-3.79-2.5-6S3.39 5.61 5 4M19 4c1.61 1.61 2.5 3.79 2.5 6s-.89 4.39-2.5 6M8.5 13.5C7.67 12.67 7.25 11.62 7.25 10.5S7.67 8.33 8.5 7.5M15.5 7.5c.83.83 1.25 1.88 1.25 3s-.42 2.17-1.25 3M12 12v8m-3 0h6" />
      <circle cx={12} cy={10.5} r={1.2} />
    </IconBase>
  ),
  Globe: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx={12} cy={12} r={10} />
      <path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20" />
    </IconBase>
  ),
  Trash: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </IconBase>
  ),
  Fingerprint: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6.5 17a13 13 0 01-1.5-6 7 7 0 0114 0v1M3 11a9 9 0 011.4-4.8M21 17v-1a13 13 0 00-1-5M11 7a4 4 0 014 4 25 25 0 01-1 7M9 16a25 25 0 002-7 2 2 0 014 0v3M9.5 20.5l.5-2.5" />
    </IconBase>
  ),
  Building: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={4} y={2} width={16} height={20} rx={1} />
      <path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" />
    </IconBase>
  ),
  Copy: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={9} y={9} width={13} height={13} rx={2} />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </IconBase>
  ),
  Play: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M5 3l14 9-14 9V3z" />
    </IconBase>
  ),
  Pause: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M10 4H6v16h4M18 4h-4v16h4" />
    </IconBase>
  ),
  ChevronD: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6 9l6 6 6-6" />
    </IconBase>
  ),
  Pin: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2l2 5h5l-4 3.5 1.5 5.5L12 13l-4.5 3 1.5-5.5L5 7h5l2-5z" />
      <path d="M12 13v9" />
    </IconBase>
  ),
  Archive: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={2} y={4} width={20} height={4} rx={1} />
      <path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8" />
      <path d="M10 12h4" />
    </IconBase>
  ),
  Poll: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M18 20V10" />
      <path d="M12 20V4" />
      <path d="M6 20v-6" />
    </IconBase>
  ),
  Monitor: (p: IconProps) => (
    <IconBase {...p}>
      <rect x={2} y={3} width={20} height={14} rx={2} />
      <path d="M8 21h8M12 17v4" />
    </IconBase>
  ),
  Zap: (p: IconProps) => (
    <IconBase {...p}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </IconBase>
  ),
  CheckCheck: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M2 12l5 5L16 6M7 12l5 5L23 6" />
    </IconBase>
  ),
  FlipCamera: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M20 7h-9m3-3l-3 3 3 3M4 17h9m-3 3l3-3-3-3" />
    </IconBase>
  ),
  BellOff: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M13.7 18H2l2-2V10a6 6 0 019.7-4.7M18 8a6 6 0 01.3 2v4l2 2H10M2 2l20 20M10 21a2 2 0 004 0" />
    </IconBase>
  ),
  Volume: (p: IconProps) => (
    <IconBase {...p}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 010 7M19.07 4.93a10 10 0 010 14.14" />
    </IconBase>
  ),
  RotateCW: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M23 4v6h-6" />
      <path d="M20.5 15a9 9 0 11-2.7-8.5L23 10" />
    </IconBase>
  ),
  Brush: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 114.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94C5.79 16.22 5 17 5 17l-3 1 1-3c0 0 .78-.79 2.06-2.07M10 10l4 4" />
    </IconBase>
  ),
  Type: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 7V4h16v3M9 20h6M12 4v16" />
    </IconBase>
  ),
  Eraser: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M20 20H7L3 16l9-9 8 8M6 11l7-7" />
    </IconBase>
  ),
  Crop: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M6 2v14a2 2 0 002 2h14M18 22V8a2 2 0 00-2-2H2" />
    </IconBase>
  ),
  UserMinus: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M16 11c1.7 0 3-1.3 3-3s-1.3-3-3-3-3 1.3-3 3 1.3 3 3 3zM22 20c0-3.3-2.7-6-6-6s-6 2.7-6 6M1 15h8" />
    </IconBase>
  ),
  ShieldCheck: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6l9-4z" />
      <path d="M9 12l2 2 4-4" />
    </IconBase>
  ),
  ShieldOff: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M19.7 14a8.5 8.5 0 00.3-2V6l-9-4-3.7 1.6M4.7 4.7L3 6v6c0 4 2.5 7.4 7 9 1.7-.6 3.2-1.6 4.3-2.8M2 2l20 20" />
    </IconBase>
  ),
  CheckCircle: (p: IconProps) => (
    <IconBase {...p}>
      <circle cx={12} cy={12} r={10} />
      <path d="M9 12l2 2 4-4" />
    </IconBase>
  ),
  MessageSquare: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </IconBase>
  ),
  Paperclip: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </IconBase>
  ),
  Download: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </IconBase>
  ),
  File: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
    </IconBase>
  ),
  Hash: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
    </IconBase>
  ),
  UserIcon: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx={12} cy={7} r={4} />
    </IconBase>
  ),
  Loader: (p: IconProps) => (
    <IconBase {...p}>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </IconBase>
  ),
};
