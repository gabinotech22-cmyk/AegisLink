// AegisLink icon set — stroke="currentColor", 24px viewBox
const Icon = ({ d, size = 18, stroke = 1.8, fill = 'none', children, viewBox = '0 0 24 24', style, color }) => (
  <svg
    width={size} height={size} viewBox={viewBox} fill={fill}
    stroke={color ?? 'currentColor'} strokeWidth={stroke}
    strokeLinecap="round" strokeLinejoin="round" style={style}
  >
    {d ? <path d={d} /> : children}
  </svg>
);

export const Shield     = (p) => <Icon {...p}><path d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6l9-4z"/></Icon>;
export const Lock       = (p) => <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></Icon>;
export const Key        = (p) => <Icon {...p}><circle cx="8" cy="14" r="4"/><path d="M11 13l9-9M17 7l3 3M14 10l3 3"/></Icon>;
export const Plus       = (p) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>;
export const Search     = (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></Icon>;
export const Settings   = (p) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8L3.2 7a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H8a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1A2 2 0 1119.7 7l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></Icon>;
export const Chat       = (p) => <Icon {...p}><path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z"/></Icon>;
export const Phone      = (p) => <Icon {...p}><path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.7a2 2 0 01-.5 2.1L8 9.6a16 16 0 006 6l1.1-1.1a2 2 0 012.1-.5c.9.3 1.8.5 2.7.6a2 2 0 011.7 2.2z"/></Icon>;
export const Video      = (p) => <Icon {...p}><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></Icon>;
export const Mic        = (p) => <Icon {...p}><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 11a7 7 0 01-14 0M12 19v3"/></Icon>;
export const MicOff     = (p) => <Icon {...p}><path d="M2 2l20 20M9 4.5a3 3 0 016 0V11M15 14.5a3 3 0 01-6 0V9M19 11a7 7 0 01-.8 3.3M12 19v3M5 11a7 7 0 008.7 6.8"/></Icon>;
export const Users      = (p) => <Icon {...p}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8"/></Icon>;
export const QR         = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v3M14 21h7M17 17v4"/></Icon>;
export const Timer      = (p) => <Icon {...p}><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></Icon>;
export const Cloud      = (p) => <Icon {...p}><path d="M18 17H7a4 4 0 01-1-7.9 6 6 0 0111.6 1.6A3.5 3.5 0 0118 17z"/></Icon>;
export const Check      = (p) => <Icon {...p}><path d="M20 6L9 17l-5-5"/></Icon>;
export const Chevron    = (p) => <Icon {...p}><path d="M9 18l6-6-6-6"/></Icon>;
export const ChevronL   = (p) => <Icon {...p}><path d="M15 18l-6-6 6-6"/></Icon>;
export const More       = (p) => <Icon {...p}><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></Icon>;
export const Send       = (p) => <Icon {...p}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></Icon>;
export const Attach     = (p) => <Icon {...p}><path d="M21 11.5l-9 9a5.5 5.5 0 11-7.8-7.8l9-9a3.7 3.7 0 115.2 5.2l-9 9a1.8 1.8 0 11-2.6-2.6L14 8"/></Icon>;
export const Eye        = (p) => <Icon {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></Icon>;
export const EyeOff     = (p) => <Icon {...p}><path d="M17.9 17.9A11 11 0 0112 20C5 20 1 12 1 12a21 21 0 015.1-6M9.9 4.2A11 11 0 0112 4c7 0 11 8 11 8a21 21 0 01-3.2 4.5M14.1 14.1a3 3 0 11-4.2-4.2M2 2l20 20"/></Icon>;
export const Mute       = (p) => <Icon {...p}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M23 9l-6 6M17 9l6 6"/></Icon>;
export const Flip       = (p) => <Icon {...p}><path d="M3 7v4a2 2 0 002 2h11l-3-3M21 17v-4a2 2 0 00-2-2H8l3-3"/></Icon>;
export const X          = (p) => <Icon {...p}><path d="M18 6L6 18M6 6l12 12"/></Icon>;
export const Bell       = (p) => <Icon {...p}><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M14 21a2 2 0 01-4 0"/></Icon>;
export const Globe      = (p) => <Icon {...p}><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20"/></Icon>;
export const Trash      = (p) => <Icon {...p}><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></Icon>;
export const Fingerprint= (p) => <Icon {...p}><path d="M6.5 17a13 13 0 01-1.5-6 7 7 0 0114 0v1M3 11a9 9 0 011.4-4.8M21 17v-1a13 13 0 00-1-5M11 7a4 4 0 014 4 25 25 0 01-1 7M9 16a25 25 0 002-7 2 2 0 014 0v3M9.5 20.5l.5-2.5"/></Icon>;
export const Building   = (p) => <Icon {...p}><rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/></Icon>;
export const Monitor    = (p) => <Icon {...p}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></Icon>;
export const Minimize   = (p) => <Icon {...p}><path d="M5 12h14"/></Icon>;
export const Maximize   = (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2"/></Icon>;
export const Devices    = (p) => <Icon {...p}><rect x="2" y="3" width="14" height="10" rx="2"/><path d="M14 8h6a2 2 0 012 2v5a2 2 0 01-2 2h-6M5 17v2M9 17v2M7 19h4"/></Icon>;
