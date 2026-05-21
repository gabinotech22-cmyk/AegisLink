import {
  AbsoluteFill,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  Easing,
  spring,
  Sequence,
  staticFile,
} from "remotion";
import React from "react";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadEBGaramond } from "@remotion/google-fonts/EBGaramond";

// Load premium Google Fonts matching AegisLink theme
const { fontFamily: spaceGroteskFont } = loadSpaceGrotesk("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

const { fontFamily: jetBrainsMonoFont } = loadJetBrainsMono("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});

const { fontFamily: ebGaramondFont } = loadEBGaramond("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});

const orbitronFont = spaceGroteskFont;
const interFont = spaceGroteskFont;

// Implement the official AegisLink VAULT theme token map
const VAULT = {
  name: 'Vault',
  tag: 'Cryptographic · Anonymous · On-device',
  dark: true,
  italic: false,
  displayWeight: 600,
  bg: '#0a0e0d',
  surface: '#11181a',
  surface2: '#1a2326',
  surface3: '#243033',
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.14)',
  text: '#e8f0ec',
  textDim: 'rgba(232,240,236,0.58)',
  textFaint: 'rgba(232,240,236,0.32)',
  accent: '#5bf2b9',
  accentDeep: '#1f8a5b',
  accentInk: '#06231a',
  danger: '#ff6b6b',
  warn: '#f0c674',
  divider: 'rgba(255,255,255,0.05)',
  logoStroke: '#5bf2b9',
  bubbleIn: '#1a2326',
  bubbleInText: '#e8f0ec',
  bubbleOut: '#5bf2b9',
  bubbleOutText: '#06231a',
  radius: 14,
  radiusS: 8,
  radiusL: 22,
  font: spaceGroteskFont,
  fontMono: jetBrainsMonoFont,
  fontDisplay: spaceGroteskFont,
};

// Stylized Background Grid with glowing matrix elements
const GridBackground: React.FC = () => {
  const frame = useCurrentFrame();
  
  // Move grid diagonally over time
  const gridOffsetY = interpolate(frame, [0, 900], [0, 300], {
    extrapolateRight: "clamp",
  });
  const gridOffsetX = interpolate(frame, [0, 900], [0, 200], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      className="absolute inset-0 bg-[#0a0e0d]"
      style={{
        backgroundImage: `
          linear-gradient(to right, rgba(91, 242, 185, 0.02) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(91, 242, 185, 0.02) 1px, transparent 1px)
        `,
        backgroundSize: "60px 60px",
        backgroundPosition: `${gridOffsetX}px ${gridOffsetY}px`,
      }}
    >
      {/* Sleek multi-color neon aura glow behind screens */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(circle at 30% 20%, rgba(91, 242, 185, 0.05) 0%, transparent 60%), radial-gradient(circle at 70% 80%, rgba(139, 92, 246, 0.04) 0%, transparent 60%)",
        }}
      />
    </div>
  );
};

// SVG Icons from icons.jsx
const Icon: React.FC<{
  size?: number;
  stroke?: number;
  fill?: string;
  viewBox?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ size = 22, stroke = 2, fill = 'none', viewBox = '0 0 24 24', style, children }) => (
  <svg width={size} height={size} viewBox={viewBox} fill={fill}
       stroke="currentColor" strokeWidth={stroke}
       strokeLinecap="round" strokeLinejoin="round" style={style}>
    {children}
  </svg>
);

const I = {
  Shield:  (p: any) => <Icon {...p}><path d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6l9-4z"/></Icon>,
  Lock:    (p: any) => <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></Icon>,
  Key:     (p: any) => <Icon {...p}><circle cx="8" cy="14" r="4"/><path d="M11 13l9-9M17 7l3 3M14 10l3 3"/></Icon>,
  Plus:    (p: any) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>,
  Search:  (p: any) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></Icon>,
  Settings:(p: any) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8L3.2 7a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H8a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1A2 2 0 1119.7 7l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></Icon>,
  Chat:    (p: any) => <Icon {...p}><path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z"/></Icon>,
  Phone:   (p: any) => <Icon {...p}><path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.7a2 2 0 01-.5 2.1L8 9.6a16 16 0 006 6l1.1-1.1a2 2 0 012.1-.5c.9.3 1.8.5 2.7.6a2 2 0 011.7 2.2z"/></Icon>,
  Video:   (p: any) => <Icon {...p}><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></Icon>,
  Mic:     (p: any) => <Icon {...p}><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 11a7 7 0 01-14 0M12 19v3"/></Icon>,
  MicOff:  (p: any) => <Icon {...p}><path d="M2 2l20 20M9 4.5a3 3 0 016 0V11M15 14.5a3 3 0 01-6 0V9M19 11a7 7 0 01-.8 3.3M12 19v3M5 11a7 7 0 008.7 6.8"/></Icon>,
  Users:   (p: any) => <Icon {...p}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8"/></Icon>,
  QR:      (p: any) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v3M14 21h7M17 17v4"/></Icon>,
  Timer:   (p: any) => <Icon {...p}><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></Icon>,
  Check:   (p: any) => <Icon {...p}><path d="M20 6L9 17l-5-5"/></Icon>,
  ChevronL:(p: any) => <Icon {...p}><path d="M15 18l-6-6 6-6"/></Icon>,
  More:    (p: any) => <Icon {...p}><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></Icon>,
  Send:    (p: any) => <Icon {...p}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></Icon>,
  Attach:  (p: any) => <Icon {...p}><path d="M21 11.5l-9 9a5.5 5.5 0 11-7.8-7.8l9-9a3.7 3.7 0 015.2 5.2l-9 9a1.8 1.8 0 11-2.6-2.6L14 8"/></Icon>,
  Flip:    (p: any) => <Icon {...p}><path d="M3 7v4a2 2 0 002 2h11l-3-3M21 17v-4a2 2 0 00-2-2H8l3-3"/></Icon>,
};

// Brand Mark and Wordmark from logo.jsx
const AegisMark: React.FC<{ t: typeof VAULT; size?: number; mono?: boolean }> = ({ t, size = 32, mono = false }) => {
  const stroke = mono ? 'currentColor' : t.accent;
  const fill = mono ? 'currentColor' : t.accent;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" style={{ display: 'block' }}>
      <path d="M20 2 L35 10 L35 30 L20 38 L5 30 L5 10 Z"
            stroke={stroke} strokeWidth="2.4" strokeLinejoin="round"/>
      <rect x="13" y="15" width="14" height="3.2" rx="0.4" fill={fill}/>
      <rect x="13" y="21.8" width="14" height="3.2" rx="0.4" fill={fill} opacity="0.55"/>
    </svg>
  );
};

const AegisWord: React.FC<{ t: typeof VAULT; size?: number; compact?: boolean }> = ({ t, size = 22, compact = false }) => {
  return (
    <span style={{
      fontFamily: ebGaramondFont,
      fontWeight: 500,
      fontSize: size,
      letterSpacing: '-0.005em',
      fontStyle: 'normal',
      color: t.text,
      lineHeight: 1,
    }}>
      {compact ? 'Aegis' : 'AegisLink'}
    </span>
  );
};

// Premium App Icon Container utilizing the REAL vector app icon
const AppIcon: React.FC<{ scale: number; glow: number }> = ({ scale, glow }) => {
  return (
    <div
      style={{
        transform: `scale(${scale})`,
        filter: `drop-shadow(0 0 ${glow * 25}px rgba(91, 242, 185, 0.45))`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 140,
        height: 140,
        borderRadius: "36px",
        position: "relative",
        background: "radial-gradient(140% 110% at 30% 20%, #1a2326 0%, #06090a 70%)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: "0 20px 50px rgba(0, 0, 0, 0.4)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(80% 50% at 100% 100%, rgba(91, 242, 185, 0.18), transparent 60%), radial-gradient(40% 30% at 0% 0%, rgba(255, 255, 255, 0.06), transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <AegisMark t={VAULT} size={80} />
    </div>
  );
};// Beautiful, premium iOS Status Bar component
const IOSStatusBar: React.FC<{ time?: string; color?: string }> = ({ time = '9:41', color = '#fff' }) => {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 20px 0',
      boxSizing: 'border-box',
      position: 'relative',
      zIndex: 20,
      width: '100%',
    }}>
      {/* Time */}
      <span style={{
        fontFamily: spaceGroteskFont,
        fontWeight: 600,
        fontSize: '11px',
        color: color,
        opacity: 0.9,
      }}>{time}</span>
      {/* Right icons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.9 }}>
        <svg width="15" height="10" viewBox="0 0 19 12" fill={color}>
          <rect x="0" y="7.5" width="3.2" height="4.5" rx="0.7"/>
          <rect x="4.8" y="5" width="3.2" height="7" rx="0.7"/>
          <rect x="9.6" y="2.5" width="3.2" height="9.5" rx="0.7"/>
          <rect x="14.4" y="0" width="3.2" height="12" rx="0.7"/>
        </svg>
        <svg width="14" height="10" viewBox="0 0 17 12" fill={color}>
          <path d="M8.5 3.2C10.8 3.2 12.9 4.1 14.4 5.6L15.5 4.5C13.7 2.7 11.2 1.5 8.5 1.5C5.8 1.5 3.3 2.7 1.5 4.5L2.6 5.6C4.1 4.1 6.2 3.2 8.5 3.2Z"/>
          <path d="M8.5 6.8C9.9 6.8 11.1 7.3 12 8.2L13.1 7.1C11.8 5.9 10.2 5.1 8.5 5.1C6.8 5.1 5.2 5.9 3.9 7.1L5 8.2C5.9 7.3 7.1 6.8 8.5 6.8Z"/>
          <circle cx="8.5" cy="10.5" r="1.5"/>
        </svg>
        <svg width="22" height="11" viewBox="0 0 27 13">
          <rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke={color} strokeOpacity="0.35" fill="none"/>
          <rect x="2" y="2" width="20" height="9" rx="2" fill={color}/>
          <path d="M25 4.5V8.5C25.8 8.2 26.5 7.2 26.5 6.5C26.5 5.8 25.8 4.8 25 4.5Z" fill={color} fillOpacity="0.4"/>
        </svg>
      </div>
    </div>
  );
};

// Premium High-Fidelity Smartphone Mockup Frame matching ios-frame.jsx
const IOSDevice: React.FC<{
  scale: number;
  children: React.ReactNode;
  glowColor?: string;
}> = ({ scale, children, glowColor = "rgba(91, 242, 185, 0.2)" }) => {
  return (
    <div
      style={{
        transform: `scale(${scale})`,
        width: 280,
        height: 600,
        borderRadius: "44px",
        border: "5px solid rgba(255, 255, 255, 0.08)",
        backgroundColor: "#0a0e0d",
        position: "relative",
        boxShadow: `0 35px 80px rgba(0, 0, 0, 0.7), 0 0 40px ${glowColor}, inset 0 0 15px rgba(255, 255, 255, 0.02)`,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      {/* Outer border highlighted with accent color */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "39px",
          border: "1.5px solid rgba(91, 242, 185, 0.2)",
          pointerEvents: "none",
          zIndex: 65,
        }}
      />

      {/* Camera dynamic island notch */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: "50%",
          transform: "translateX(-50%)",
          width: 88,
          height: 26,
          borderRadius: "18px",
          backgroundColor: "#000",
          zIndex: 50,
          border: "1px solid rgba(255, 255, 255, 0.06)",
        }}
      />
      
      {/* Status Bar */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 40 }}>
        <IOSStatusBar time="9:41" color="#e8f0ec" />
      </div>
      
      {/* Screen Area Content Wrapper */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        paddingTop: 34,
        paddingBottom: 16,
        position: "relative",
        overflow: "hidden",
        backgroundColor: "#0a0e0d"
      }}>
        {children}
      </div>
      
      {/* Home Indicator Pill */}
      <div
        style={{
          position: "absolute",
          bottom: 5,
          left: "50%",
          transform: "translateX(-50%)",
          width: 96,
          height: 4,
          borderRadius: "2px",
          backgroundColor: "rgba(232, 240, 236, 0.35)",
          zIndex: 45,
          pointerEvents: "none",
        }}
      />
    </div>
  );
};

// Beautiful high-fidelity Onboarding Screen with frame-interpolated multi-step transitions
const OnboardingScreen: React.FC = () => {
  const frame = useCurrentFrame();
  
  let step = 0;
  if (frame >= 45 && frame < 125) {
    step = 1;
  } else if (frame >= 125) {
    step = 2;
  }

  if (step === 0) {
    return (
      <div style={{ flex: 1, padding: "20px", display: "flex", flexDirection: "column", color: VAULT.text, height: "100%", justifyContent: "space-between", fontFamily: VAULT.font }}>
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ filter: "drop-shadow(0 0 12px rgba(91,242,185,0.45))", marginBottom: 12 }}>
            <AegisMark t={VAULT} size={50} />
          </div>
          <div style={{ fontFamily: VAULT.fontMono, fontSize: "11px", fontWeight: "bold", color: VAULT.accent, letterSpacing: "2.5px" }}>
            AEGIS LINK
          </div>
        </div>
        
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", margin: "20px 0" }}>
          <div style={{ fontSize: "28px", fontFamily: VAULT.fontDisplay, fontWeight: 700, lineHeight: 1.1, color: VAULT.text, letterSpacing: "-0.02em" }}>
            Messaging without a trace.
          </div>
          <div style={{ fontSize: "12px", color: VAULT.textDim, lineHeight: 1.45 }}>
            No phone number. No email. No metadata. Your identity is a key, generated and stored only on this device.
          </div>
        </div>
        
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{
            background: VAULT.accent, color: VAULT.accentInk, borderRadius: "12px", padding: "12px",
            fontSize: "11px", fontWeight: "bold", textAlign: "center", letterSpacing: "0.5px",
            boxShadow: "0 4px 15px rgba(91, 242, 185, 0.25)"
          }}>
            GENERATE MY IDENTITY
          </div>
          <div style={{
            border: `1px solid ${VAULT.borderStrong}`, color: VAULT.text, borderRadius: "12px", padding: "11px",
            fontSize: "11px", fontWeight: "bold", textAlign: "center"
          }}>
            RESTORE FROM BACKUP
          </div>
        </div>

        <div style={{
          fontFamily: VAULT.fontMono, fontSize: "8px", color: VAULT.textFaint,
          textAlign: "center", marginTop: 10, letterSpacing: "0.06em"
        }}>
          v0.9.2 · OPEN SOURCE · AUDITED 2026 Q1
        </div>
      </div>
    );
  }

  if (step === 1) {
    const spinAngle = (frame * 5) % 360;
    const progress = interpolate(frame, [45, 120], [0, 100], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

    return (
      <div style={{ flex: 1, padding: "24px", display: "flex", flexDirection: "column", color: VAULT.text, height: "100%", justifyContent: "center", alignItems: "center", textAlign: "center", fontFamily: VAULT.font }}>
        {/* Rotating key spinner */}
        <div style={{
          width: 80, height: 80, borderRadius: "50%",
          border: `2px solid ${VAULT.surface3}`,
          borderTopColor: VAULT.accent,
          transform: `rotate(${spinAngle}deg)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          position: "relative"
        }}>
          <div style={{ transform: `rotate(${-spinAngle}deg)`, color: VAULT.accent }}>
            <I.Key size={24} stroke={2} />
          </div>
        </div>

        <div style={{ fontSize: "20px", fontFamily: VAULT.fontDisplay, fontWeight: VAULT.displayWeight, color: VAULT.text, marginTop: 24, letterSpacing: "-0.01em" }}>
          Generating keypair
        </div>
        <div style={{ fontFamily: VAULT.fontMono, fontSize: "10px", color: VAULT.accent, marginTop: 8, letterSpacing: "0.05em" }}>
          Curve25519 · 256-bit · on-device
        </div>

        {/* Dynamic Progress Bar */}
        <div style={{ width: "100%", height: 3, background: VAULT.surface3, borderRadius: 99, overflow: "hidden", marginTop: 30 }}>
          <div style={{ width: `${progress}%`, height: "100%", background: VAULT.accent, borderRadius: 99 }} />
        </div>
      </div>
    );
  }

  // step 2: Show identity
  const fingerprint = ['a7f3', '92e1', 'b4c8', '5d0a', '6f12', 'eb73', '8c9d', '1a45'];
  return (
    <div style={{ flex: 1, padding: "16px", display: "flex", flexDirection: "column", color: VAULT.text, height: "100%", justifyContent: "space-between", fontFamily: VAULT.font }}>
      <div>
        <div style={{ fontFamily: VAULT.fontMono, fontSize: "9px", color: VAULT.accent, letterSpacing: "1px", marginBottom: "8px" }}>
          YOUR IDENTITY
        </div>
        <div style={{ fontSize: "20px", fontFamily: VAULT.fontDisplay, fontWeight: VAULT.displayWeight, lineHeight: 1.15, marginBottom: "16px", letterSpacing: "-0.01em" }}>
          This is yours. Nobody else has it.
        </div>
        
        {/* Identity card */}
        <div style={{
          border: `1.5px solid ${VAULT.borderStrong}`, borderRadius: "16px",
          padding: "12px", background: VAULT.surface,
          boxShadow: "0 8px 24px rgba(0,0,0,0.2)"
        }}>
          <div style={{ fontFamily: VAULT.fontMono, fontSize: "8px", color: VAULT.textDim, letterSpacing: "1px", marginBottom: "4px" }}>
            AEGIS ID
          </div>
          <div style={{ fontFamily: VAULT.fontMono, fontSize: "16px", color: VAULT.text, fontWeight: "bold", marginBottom: "10px" }}>
            7K9-PQ2M-X4VR
          </div>
          <div style={{ fontFamily: VAULT.fontMono, fontSize: "8px", color: VAULT.textDim, letterSpacing: "1px", marginBottom: "4px" }}>
            PUBLIC KEY FINGERPRINT
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "4px" }}>
            {fingerprint.map((f, i) => (
              <div key={i} style={{
                fontFamily: VAULT.fontMono, fontSize: "9px", color: VAULT.text,
                padding: "4px 2px", background: VAULT.surface2,
                borderRadius: "6px", textAlign: "center", border: `1px solid ${VAULT.divider}`
              }}>{f}</div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ fontSize: "10.5px", color: VAULT.textDim, lineHeight: 1.45, margin: "10px 0" }}>
        Write this down or back it up encrypted. If you lose it, no one — not even us — can recover it.
      </div>

      <div style={{
        background: VAULT.accent, color: VAULT.accentInk, borderRadius: "12px", padding: "12px",
        fontSize: "11px", fontWeight: "bold", textAlign: "center", letterSpacing: "0.5px",
        boxShadow: "0 4px 15px rgba(91, 242, 185, 0.25)"
      }}>
        ENTER AEGISLINK
      </div>
    </div>
  );
};

// Premium high-fidelity Chats list screen mockup
const HomeScreenMockup: React.FC = () => {
  const mockChats = [
    { name: "satoshi.eth", last: "Bridge confirmed. Sending the tx...", unread: 2, color: "#8b5cf6", time: "12:42", verified: true },
    { name: "Pseudonym 4B2", last: "I can hop on a call in five.", unread: 0, color: "#5bf2b9", time: "11:08", verified: true },
    { name: "DAO · Treasury", last: "Alex: multisig is signed by 3/5", unread: 5, color: "#f59e0b", time: "09:30" },
    { name: "vitalik.lens", last: "thanks, will review the spec", unread: 0, color: "#ec4899", time: "Tue", verified: true },
    { name: "0xC3F…91A", last: "attachment · keystore.json", unread: 0, color: "#06b6d4", time: "Tue" },
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", color: VAULT.text, height: "100%", background: VAULT.bg, fontFamily: VAULT.font }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${VAULT.divider}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <AegisMark t={VAULT} size={22} />
          <AegisWord t={VAULT} size={15} compact />
        </div>
        <div style={{ display: "flex", gap: "10px", color: VAULT.textDim }}>
          <I.Search size={16} />
          <I.Settings size={16} />
        </div>
      </div>
      
      {/* E2EE Lock Banner */}
      <div style={{
        margin: "8px 12px 6px", padding: "8px 10px",
        background: "rgba(91, 242, 185, 0.03)", borderRadius: "10px",
        border: `1.5px solid ${VAULT.border}`,
        display: "flex", alignItems: "center", gap: "6px",
        fontSize: "8.5px", fontFamily: VAULT.fontMono, color: VAULT.accent,
        letterSpacing: "0.05em"
      }}>
        <I.Lock size={10} /> <span>E2EE · ZERO METADATA</span>
      </div>

      {/* Chat list container */}
      <div style={{ flex: 1, overflowY: "hidden", display: "flex", flexDirection: "column", padding: "0 6px" }}>
        {mockChats.map((c, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 6px", borderBottom: `1.5px solid ${VAULT.divider}` }}>
            <div style={{
              width: 32, height: 32, borderRadius: "10px",
              background: c.color + "25", color: c.color,
              display: "flex", alignItems: "center", justifyItems: "center", justifyContent: "center",
              fontSize: "10px", fontFamily: VAULT.fontDisplay, fontWeight: "bold",
              flexShrink: 0
            }}>
              {c.name.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{
                  fontSize: "11px", fontWeight: "bold",
                  fontFamily: c.name.includes('.') || c.name.startsWith('0x') ? VAULT.fontMono : VAULT.font,
                  color: VAULT.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
                }}>
                  {c.name}
                </span>
                {c.verified && <I.Check size={10} style={{ color: VAULT.accent }} />}
              </div>
              <div style={{ fontSize: "9.5px", color: VAULT.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: "2px" }}>
                {c.last}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "3px", flexShrink: 0 }}>
              <span style={{ fontSize: "7.5px", fontFamily: VAULT.fontMono, color: VAULT.textFaint }}>{c.time}</span>
              {c.unread > 0 && (
                <span style={{
                  background: VAULT.accent, color: VAULT.accentInk,
                  fontSize: "8.5px", fontFamily: VAULT.fontMono, fontWeight: "bold",
                  padding: "1px 5px", borderRadius: "10px"
                }}>
                  {c.unread}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{
        display: "flex", justifyContent: "space-around",
        padding: "8px 8px 10px", flexShrink: 0,
        borderTop: `1px solid ${VAULT.divider}`, background: VAULT.surface,
      }}>
        {[
          { icon: I.Chat, label: "CHATS", active: true },
          { icon: I.Users, label: "GROUPS" },
          { icon: I.QR, label: "VERIFY" },
          { icon: I.Shield, label: "PRIVACY" },
        ].map((tab, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", color: tab.active ? VAULT.accent : VAULT.textFaint, cursor: "pointer" }}>
            <tab.icon size={16} stroke={tab.active ? 2.2 : 1.8} />
            <span style={{ fontFamily: VAULT.fontMono, fontSize: "7.5px", fontWeight: tab.active ? 600 : 400 }}>{tab.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Premium high-fidelity Key generation / Private keys screen mockup
const KeyGenerationMockup: React.FC<{ frame: number }> = ({ frame }) => {
  const fingerprint = ["a7f3", "92e1", "b4c8", "5d0a", "6f12", "eb73", "8c9d", "1a45"];
  const spinAngle = (frame * 3) % 360;
  
  return (
    <div style={{ flex: 1, padding: "14px", display: "flex", flexDirection: "column", color: VAULT.text, height: "100%", justifyContent: "space-between", fontFamily: VAULT.font, background: VAULT.bg }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "10px", borderBottom: `1.5px solid ${VAULT.divider}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", color: VAULT.textDim }}>
          <I.ChevronL size={16} />
          <span style={{ fontSize: "11px", fontWeight: "bold" }}>Identity</span>
        </div>
        <I.More size={16} style={{ color: VAULT.textDim }} />
      </div>

      {/* Main info card */}
      <div style={{ marginTop: "10px" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "3px 8px", background: "rgba(91, 242, 185, 0.05)", borderRadius: "8px", border: `1px solid ${VAULT.accent}40`, marginBottom: "8px" }}>
          <span style={{ width: 4, height: 4, borderRadius: "50%", background: VAULT.accent }} />
          <span style={{ fontFamily: VAULT.fontMono, fontSize: "7px", letterSpacing: "0.5px", color: VAULT.accent }}>CURVE25519 KEYPAIR</span>
        </div>
        <div style={{ fontSize: "16px", fontFamily: VAULT.fontDisplay, fontWeight: VAULT.displayWeight, color: VAULT.text, letterSpacing: "-0.01em" }}>
          On-Device Keys
        </div>
      </div>
      
      {/* Visual key generator / active status widget */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", margin: "8px 0" }}>
        <div style={{
          width: 50, height: 50, borderRadius: "50%",
          border: `2px dashed rgba(91,242,185,0.2)`,
          borderTopColor: VAULT.accent,
          transform: `rotate(${spinAngle}deg)`,
          display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <div style={{ transform: `rotate(${-spinAngle}deg)`, color: VAULT.accent }}>
            <I.Key size={18} />
          </div>
        </div>
        <span style={{ fontFamily: VAULT.fontMono, fontSize: "7.5px", color: VAULT.accent, marginTop: "6px", letterSpacing: "1.5px", fontWeight: "bold" }}>STORAGE SECURE</span>
      </div>

      {/* Keys details card */}
      <div style={{
        border: `1.5px solid ${VAULT.borderStrong}`, borderRadius: "14px",
        padding: "10px", background: VAULT.surface,
        boxShadow: "0 4px 15px rgba(0,0,0,0.15)"
      }}>
        <div style={{ fontFamily: VAULT.fontMono, fontSize: "7.5px", color: VAULT.textDim, letterSpacing: "1px", marginBottom: "4px" }}>
          AEGIS ID
        </div>
        <div style={{ fontFamily: VAULT.fontMono, fontSize: "14px", color: VAULT.text, fontWeight: "bold", marginBottom: "8px" }}>
          7K9-PQ2M-X4VR
        </div>
        <div style={{ fontFamily: VAULT.fontMono, fontSize: "7.5px", color: VAULT.textDim, letterSpacing: "1px", marginBottom: "4px" }}>
          PUBLIC KEY FINGERPRINT
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "4px" }}>
          {fingerprint.map((f, i) => (
            <div key={i} style={{
              fontFamily: VAULT.fontMono, fontSize: "8.5px", color: VAULT.accent,
              padding: "4px 2px", background: "rgba(91, 242, 185, 0.05)",
              borderRadius: "5px", textAlign: "center", border: `1px solid ${VAULT.border}`
            }}>{f}</div>
          ))}
        </div>
      </div>

      {/* Backup Option */}
      <div style={{
        border: `1.5px solid ${VAULT.borderStrong}`, borderRadius: "12px",
        padding: "8px 12px", background: VAULT.surface2, display: "flex",
        alignItems: "center", justifyItems: "center", justifyContent: "space-between", marginTop: "8px"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <I.Shield size={14} style={{ color: VAULT.textDim }} />
          <span style={{ fontSize: "10px", fontWeight: "bold" }}>Secure Backup</span>
        </div>
        <span style={{ fontSize: "8.5px", fontFamily: VAULT.fontMono, color: VAULT.accent }}>ACTIVE ✓</span>
      </div>
    </div>
  );
};

// Premium high-fidelity active E2EE voice/video call mockup screen with real-time ticker
const ActiveCallMockup: React.FC<{ frame: number }> = ({ frame }) => {
  const callDurationSeconds = 258 + Math.floor(frame / 30);
  const m = Math.floor(callDurationSeconds / 60).toString().padStart(2, "0");
  const s = (callDurationSeconds % 60).toString().padStart(2, "0");
  
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", color: VAULT.text, height: "100%", position: "relative", background: "linear-gradient(135deg, #0d1615 0%, #06090a 100%)", justifyContent: "space-between", fontFamily: VAULT.font, padding: "14px" }}>
      {/* Floating scanning filter / scanlines */}
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,0.015) 0 1px, transparent 1px 3px)",
        pointerEvents: "none", zIndex: 1
      }} />

      {/* Top Header Badge */}
      <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", marginTop: 10 }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "3px 8px",
          background: "rgba(0,0,0,0.6)",
          borderRadius: "20px",
          border: `1px solid ${VAULT.accent}40`,
          backdropFilter: "blur(6px)"
        }}>
          <span style={{ width: 4, height: 4, borderRadius: "50%", background: VAULT.accent, display: "inline-block" }} />
          <span style={{ fontFamily: VAULT.fontMono, fontSize: "7px", letterSpacing: "0.5px", color: VAULT.accent }}>E2EE · CURVE25519 · SRTP</span>
        </div>
        <div style={{ fontSize: "20px", fontFamily: VAULT.fontDisplay, fontWeight: VAULT.displayWeight, marginTop: "14px", color: VAULT.text, letterSpacing: "-0.01em" }}>satoshi.eth</div>
        <div style={{ fontFamily: VAULT.fontMono, fontSize: "11px", color: VAULT.textDim, marginTop: "4px" }}>{m}:{s}</div>
      </div>

      {/* Self View Frame floating on right */}
      <div style={{
        position: "absolute", top: "75px", right: "12px", width: "60px", height: "85px", borderRadius: "10px",
        background: "linear-gradient(135deg, rgba(91,242,185,0.1) 0%, #111a18 100%)",
        border: `1.5px solid ${VAULT.borderStrong}`, display: "flex", alignItems: "flex-end", padding: "4px", zIndex: 3,
        boxShadow: "0 6px 16px rgba(0,0,0,0.3)"
      }}>
        <span style={{ fontSize: "6.5px", color: VAULT.textDim, fontFamily: VAULT.fontMono, letterSpacing: "0.5px", fontWeight: "bold" }}>YOU</span>
      </div>

      {/* Call Fingerprint Card */}
      <div style={{
        padding: "8px 10px", background: "rgba(0,0,0,0.5)",
        border: `1.5px solid ${VAULT.borderStrong}`, borderRadius: "12px",
        display: "flex", flexDirection: "column", zIndex: 2,
        boxShadow: "0 4px 15px rgba(0,0,0,0.2)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: VAULT.fontMono, fontSize: "7.5px", color: VAULT.textDim }}>CALL FINGERPRINT</span>
          <span style={{ color: VAULT.accent, fontSize: "7.5px", fontWeight: "bold" }}>✓ VERIFIED</span>
        </div>
        <div style={{ fontFamily: VAULT.fontMono, fontSize: "10px", color: VAULT.text, fontWeight: "bold", marginTop: "4px", letterSpacing: "0.5px" }}>
          orbit · cedar · lantern · gust
        </div>
      </div>

      {/* Action Controls Bar */}
      <div style={{
        display: "flex", justifyContent: "space-between",
        padding: "8px 4px 0", borderTop: `1.5px solid ${VAULT.divider}`,
        background: "rgba(0,0,0,0.2)", zIndex: 2, flexShrink: 0
      }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: VAULT.surface3, border: `1px solid ${VAULT.borderStrong}`, display: "flex", alignItems: "center", justifyContent: "center", color: VAULT.text }}>
          <I.MicOff size={13} />
        </div>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: VAULT.accent, color: VAULT.accentInk, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <I.Video size={13} />
        </div>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: VAULT.surface3, border: `1px solid ${VAULT.borderStrong}`, display: "flex", alignItems: "center", justifyContent: "center", color: VAULT.text }}>
          <I.Flip size={13} />
        </div>
        {/* End button in red */}
        <div style={{ width: 34, height: 34, borderRadius: "50%", background: VAULT.danger, display: "flex", alignItems: "center", justifyContent: "center", transform: "rotate(135deg)", color: "#fff", cursor: "pointer" }}>
          <I.Phone size={16} />
        </div>
      </div>
    </div>
  );
};

// Premium mathematical QR code vector builder component
const QRBlock: React.FC = () => {
  // Mathematical QR code pattern generator from screens.jsx
  const cells: { x: number; y: number }[] = [];
  const seed = 0x9c3a7;
  for (let i = 0; i < 441; i++) {
    const x = i % 21;
    const y = Math.floor(i / 21);
    
    // finder corners
    const inFinder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
    let on = false;
    if (inFinder) {
      const ax = x < 7 ? x : (x - 14);
      const ay = y < 7 ? y : (y - 14);
      on = (ax === 0 || ax === 6 || ay === 0 || ay === 6) || (ax >= 2 && ax <= 4 && ay >= 2 && ay <= 4);
    } else {
      // pseudo random
      on = ((x * 73 + y * 131 + seed) & 0x3) === 0 || ((x * x + y) & 0x7) === 1;
    }
    if (on) cells.push({ x, y });
  }

  return (
    <div style={{
      width: 130, height: 130, padding: "8px",
      background: "#0a0e0d",
      borderRadius: "14px", border: `1.5px solid ${VAULT.accent}35`,
      position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
      boxShadow: "0 8px 30px rgba(0,0,0,0.3)"
    }}>
      <svg viewBox="0 0 21 21" width="114" height="114" style={{ display: 'block' }}>
        {cells.map((c, i) => (
          <rect key={i} x={c.x} y={c.y} width="1" height="1" fill={VAULT.accent} />
        ))}
      </svg>
      {/* Center Shield logo */}
      <div style={{
        position: 'absolute', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: "6px",
          background: VAULT.bg, border: `1.5px solid ${VAULT.accent}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: VAULT.accent,
        }}>
          <AegisMark t={VAULT} size={14} mono />
        </div>
      </div>
    </div>
  );
};

// Premium high-fidelity Verification / QR screen mockup
const VerificationMockup: React.FC = () => {
  return (
    <div style={{ flex: 1, padding: "14px", display: "flex", flexDirection: "column", color: VAULT.text, height: "100%", alignItems: "center", justifyContent: "space-between", fontFamily: VAULT.font, background: VAULT.bg }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", paddingBottom: "10px", borderBottom: `1.5px solid ${VAULT.divider}`, marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "4px", color: VAULT.textDim }}>
            <I.ChevronL size={16} />
            <span style={{ fontSize: "11px", fontWeight: "bold" }}>Verify contact</span>
          </div>
          <I.More size={16} style={{ color: VAULT.textDim }} />
        </div>
        <div style={{ fontSize: "9px", fontFamily: VAULT.fontMono, color: VAULT.accent, letterSpacing: "1px", textAlign: "center", marginBottom: "4px" }}>
          TRUSTLESS VALIDATION
        </div>
        <div style={{ fontSize: "10.5px", color: VAULT.textDim, textAlign: "center", lineHeight: 1.4, padding: "0 10px" }}>
          Scan code or compare safety words to verify.
        </div>
      </div>
      
      {/* High fidelity mathematical QR code */}
      <QRBlock />

      {/* Safety words grid */}
      <div style={{ width: "100%", margin: "8px 0" }}>
        <div style={{ fontFamily: VAULT.fontMono, fontSize: "7.5px", color: VAULT.textDim, letterSpacing: "1px", marginBottom: "6px", textAlign: "center" }}>
          SAFETY WORDS
        </div>
        <div style={{
          background: "rgba(91,242,185,0.02)", border: `1.5px solid ${VAULT.borderStrong}`,
          borderRadius: "12px", padding: "8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px"
        }}>
          {["orbit", "cedar", "lantern", "gust"].map((w, i) => (
            <div key={i} style={{ display: "flex", gap: "4px", fontSize: "9.5px", background: VAULT.surface, padding: "4px 6px", borderRadius: "6px", border: `1px solid ${VAULT.divider}` }}>
              <span style={{ color: VAULT.textFaint, fontFamily: VAULT.fontMono }}>0{i+1}</span>
              <span style={{ fontWeight: "bold", fontFamily: VAULT.fontMono, color: VAULT.accent }}>{w}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: "6px", width: "100%", marginTop: "4px" }}>
        <div style={{ flex: 1, border: `1px solid ${VAULT.borderStrong}`, color: VAULT.text, borderRadius: "10px", padding: "8px", textAlign: "center", fontSize: "9px", fontWeight: "bold" }}>Scan QR</div>
        <div style={{ flex: 1, background: VAULT.accent, color: VAULT.accentInk, borderRadius: "10px", padding: "8px", textAlign: "center", fontSize: "9px", fontWeight: "bold" }}>Mark Verified</div>
      </div>
    </div>
  );
};

// Scene 1: Introduction (0s - 6s / Frame 0-180)
const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 80 },
  });

  const logoGlow = interpolate(frame, [0, 90, 180], [0.2, 1.2, 0.6]);

  const textOpacity = interpolate(frame, [30, 70], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const textSpacing = interpolate(frame, [30, 180], [22, 10], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  const subtitleOpacity = interpolate(frame, [70, 110], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Phone slides up from bottom
  const phoneY = interpolate(frame, [50, 120], [600, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const phoneOpacity = interpolate(frame, [50, 80], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill className="flex flex-row items-center justify-center text-white select-none px-20">
      
      {/* Left side Brand Header */}
      <div className="flex-1 flex flex-col items-start justify-center pr-10 z-10">
        <div className="mb-6">
          <AppIcon scale={logoScale} glow={logoGlow} />
        </div>
        
        <h1
          style={{
            fontFamily: orbitronFont,
            letterSpacing: `${textSpacing}px`,
            opacity: textOpacity,
          }}
          className="text-5xl font-black bg-gradient-to-r from-emerald-400 via-emerald-100 to-emerald-400 bg-clip-text text-transparent drop-shadow-[0_0_15px_rgba(91,242,185,0.35)]"
        >
          AEGIS LINK
        </h1>

        <p
          style={{
            fontFamily: interFont,
            opacity: subtitleOpacity,
          }}
          className="mt-4 text-gray-400 text-md font-light tracking-[4px] uppercase text-left max-w-md leading-relaxed"
        >
          El futuro de la mensajería privada, descentralizada y libre de metadatos.
        </p>
      </div>

      {/* Right side Phone Preview */}
      <div 
        className="flex-shrink-0 flex items-center justify-center z-10"
        style={{
          transform: `translateY(${phoneY}px)`,
          opacity: phoneOpacity,
        }}
      >
        <IOSDevice scale={0.9}>
          <OnboardingScreen />
        </IOSDevice>
      </div>

    </AbsoluteFill>
  );
};

// Scene 2: Zero Metadata (6s - 12s / Frame 180-360)
const MetadataScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  // Scanning laser beam
  const laserY = interpolate(frame, [30, 140], [-50, 480], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const laserOpacity = interpolate(frame, [10, 30, 140, 160], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Nodes metadata values
  const nodes = [
    { label: "IP: 192.168.2.14", top: 120, left: 100, angle: 0.1 },
    { label: "GPS: 41.403, 2.174", top: 220, left: 880, angle: -0.1 },
    { label: "PHONE: +1(555)382-90", top: 380, left: 80, angle: -0.15 },
    { label: "TIMESTAMP ACCESS", top: 400, left: 910, angle: 0.1 },
  ];

  const phoneScale = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 70 },
  });

  return (
    <AbsoluteFill className="flex flex-row items-center justify-center text-white select-none px-20">
      
      {/* Left side Texts */}
      <div className="flex-1 flex flex-col items-start justify-center pr-10 z-10">
        <h2
          style={{ fontFamily: orbitronFont }}
          className="text-4xl font-bold tracking-wider text-[#5bf2b9] drop-shadow-[0_0_10px_rgba(91,242,185,0.25)]"
        >
          CERO METADATOS
        </h2>
        <p
          style={{ fontFamily: interFont }}
          className="text-gray-300 mt-4 text-md max-w-lg font-light leading-relaxed text-left"
        >
          AegisLink no almacena registros de direcciones IP, timestamps de tus mensajes ni la frecuencia con la que hablas con tus contactos.
        </p>
        <p
          style={{ fontFamily: interFont }}
          className="text-gray-500 mt-3 text-sm max-w-lg font-light text-left"
        >
          Tus comunicaciones son completamente invisibles para los servidores. Lo que no se registra, nunca se puede filtrar.
        </p>
      </div>

      {/* Right side Phone with Scanning laser passing over actual home screen */}
      <div className="flex-shrink-0 relative flex items-center justify-center z-10">
        
        {/* Grid nodes floating around being scanned */}
        {nodes.map((node, i) => {
          const nodeTriggerFrame = 35 + i * 20;
          
          const nodeOpacity = interpolate(
            frame,
            [nodeTriggerFrame, nodeTriggerFrame + 18],
            [0.85, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );

          const nodeScale = interpolate(
            frame,
            [nodeTriggerFrame, nodeTriggerFrame + 18],
            [1, 0.1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );

          const floatY = Math.sin((frame + i * 40) / 12) * 8;

          return (
            <div
              key={i}
              className="absolute border border-red-500/30 bg-black/85 backdrop-blur-md px-4 py-2 rounded-xl z-20"
              style={{
                top: node.top + floatY,
                left: node.left - 520, // offset left position to surround the phone
                transform: `scale(${nodeScale}) rotate(${node.angle}rad)`,
                opacity: nodeOpacity,
                boxShadow: "0 6px 20px rgba(239, 68, 68, 0.08)",
              }}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                <span style={{ fontFamily: orbitronFont }} className="text-red-400 text-[9px] font-bold tracking-widest uppercase">
                  {node.label}
                </span>
                <span className="text-red-500 text-[9px] font-black">X</span>
              </div>
            </div>
          );
        })}

        <IOSDevice scale={phoneScale} glowColor="rgba(239, 68, 68, 0.06)">
          <HomeScreenMockup />
          
          {/* Laser scanning bar passing over screen */}
          <div
            className="absolute left-0 right-0 h-[3px] bg-gradient-to-r from-transparent via-red-500 to-transparent drop-shadow-[0_0_12px_rgba(239,68,68,0.95)] z-30 pointer-events-none"
            style={{
              top: `${laserY}px`,
              opacity: laserOpacity,
            }}
          />
        </IOSDevice>

        {/* Floating Verified Shield Badge after scan completes */}
        <div
          className="absolute z-45 flex flex-col items-center gap-2"
          style={{
            opacity: interpolate(frame, [110, 145], [0, 1], { extrapolateLeft: "clamp" }),
            transform: `scale(${interpolate(frame, [110, 145], [0.6, 1], { extrapolateLeft: "clamp" })})`,
          }}
        >
          <div className="w-18 h-18 border border-[#5bf2b9]/40 rounded-full bg-[#06090a]/90 backdrop-blur-md flex items-center justify-center shadow-[0_0_35px_rgba(91,242,185,0.25)]">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none">
              <path d="M12 22C12 22 20 18 20 12V5L12 2L4 5V12C4 18 12 22 12 22Z" fill="#042f2e" stroke="#5bf2b9" strokeWidth="2"/>
              <path d="M9 12L11 14L15 10" stroke="#a7f3d0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span style={{ fontFamily: orbitronFont }} className="text-[#5bf2b9] font-bold tracking-widest text-[9px] bg-[#06090a] px-3 py-1 rounded-full border border-[#5bf2b9]/25 uppercase shadow-md">
            CONEXIÓN PURIFICADA
          </span>
        </div>
      </div>

    </AbsoluteFill>
  );
};

// Scene 3: On-Device Cryptography (12s - 18s / Frame 360-540)
const CryptoScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Ring pulse scale
  const ringScale = interpolate(frame % 45, [0, 45], [0.8, 1.6]);
  const ringOpacity = interpolate(frame % 45, [0, 45], [0.45, 0]);

  // Phone entrance
  const phoneScale = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 60 },
  });

  return (
    <AbsoluteFill className="flex flex-row items-center justify-center text-white select-none px-20">
      
      {/* Left side Texts */}
      <div className="flex-1 flex flex-col items-start justify-center pr-10 z-10">
        <h2
          style={{ fontFamily: orbitronFont }}
          className="text-4xl font-bold tracking-wider text-[#5bf2b9] drop-shadow-[0_0_10px_rgba(91,242,185,0.25)]"
        >
          CLAVES LOCALES
        </h2>
        <p
          style={{ fontFamily: interFont }}
          className="text-gray-300 mt-4 text-md max-w-lg font-light leading-relaxed text-left"
        >
          Tu Aegis ID y claves criptográficas de Curve25519 se generan y almacenan de forma local mediante algoritmos auditados de código abierto.
        </p>
        <p
          style={{ fontFamily: interFont }}
          className="text-gray-500 mt-3 text-sm max-w-lg font-light text-left"
        >
          Tus claves privadas Double Ratchet jamás abandonan tu almacenamiento seguro local. Eres el único guardián de tus llaves.
        </p>
      </div>

      {/* Right side Phone with Orbiting keys and active generation mockup */}
      <div className="flex-shrink-0 relative flex items-center justify-center z-10">
        
        {/* Pulsing secure wave background */}
        <div
          className="absolute w-[260px] h-[260px] rounded-full border border-[#5bf2b9]/15"
          style={{
            transform: `scale(${ringScale})`,
            opacity: ringOpacity,
          }}
        />
        <div
          className="absolute w-[260px] h-[260px] rounded-full border border-[#8b5cf6]/10"
          style={{
            transform: `scale(${ringScale + 0.35})`,
            opacity: Math.max(0, ringOpacity - 0.25),
          }}
        />

        <IOSDevice scale={phoneScale}>
          <KeyGenerationMockup frame={frame} />
        </IOSDevice>

        {/* Orbiting keys */}
        {[0, 1, 2].map((i) => {
          const orbitAngle = (frame / 22) + (i * (Math.PI * 2 / 3));
          const orbitRadiusX = 180;
          const orbitRadiusY = 85;
          const kx = Math.cos(orbitAngle) * orbitRadiusX;
          const ky = Math.sin(orbitAngle) * orbitRadiusY;
          const kscale = interpolate(Math.sin(orbitAngle), [-1, 1], [0.65, 0.95]);
          const kopacity = interpolate(Math.sin(orbitAngle), [-1, 1], [0.3, 0.95]);

          return (
            <div
              key={i}
              className="absolute z-20 pointer-events-none"
              style={{
                transform: `translate(${kx}px, ${ky}px) scale(${kscale})`,
                opacity: kopacity,
              }}
            >
              <div className="w-10 h-10 bg-[#061a14] border border-[#5bf2b9]/40 rounded-full flex items-center justify-center shadow-[0_0_15px_rgba(91,242,185,0.3)]">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                  <path d="M15 9C15 11.7614 12.7614 14 10 14C7.23858 14 5 11.7614 5 9C5 6.23858 7.23858 4 10 4C12.7614 4 13.5 5.5 15 9Z" stroke="#5bf2b9" strokeWidth="2"/>
                  <path d="M14 10.5L20 16.5M18.5 15L20 13.5M17 17L18.5 15.5" stroke="#5bf2b9" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </div>
            </div>
          );
        })}

      </div>

    </AbsoluteFill>
  );
};

// Scene 4: Encrypted Calls (18s - 24s / Frame 540-720)
const CallsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Waveform constants
  const wavesCount = 4;
  const dotsCount = 26;

  const phoneScale = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 60 },
  });

  return (
    <AbsoluteFill className="flex flex-row items-center justify-center text-white select-none px-20">
      
      {/* Left side Texts */}
      <div className="flex-1 flex flex-col items-start justify-center pr-10 z-10">
        <h2
          style={{ fontFamily: orbitronFont }}
          className="text-4xl font-bold tracking-wider text-[#5bf2b9] drop-shadow-[0_0_10px_rgba(91,242,185,0.25)]"
        >
          LLAMADAS E2EE
        </h2>
        <p
          style={{ fontFamily: interFont }}
          className="text-gray-300 mt-4 text-md max-w-lg font-light leading-relaxed text-left"
        >
          Comunicaciones de voz y video encriptadas de extremo a extremo (DTLS-SRTP). Tráfico directo Peer-to-Peer sin intermediación de servidores centralizados.
        </p>
        <p
          style={{ fontFamily: interFont }}
          className="text-gray-500 mt-3 text-sm max-w-lg font-light text-left"
        >
          Compara las safety words del cifrado en tiempo real con total claridad, privacidad de grado militar y latencia ultra baja.
        </p>
      </div>

      {/* Right side Phone with undulating active audio waves running across */}
      <div className="flex-shrink-0 relative flex items-center justify-center z-10">
        
        {/* Animated wave lines in background behind phone */}
        <svg
          viewBox="0 0 600 240"
          width="500"
          height="200"
          className="absolute z-0 px-8 opacity-45 pointer-events-none"
          style={{ left: -110 }}
        >
          {[...Array(wavesCount)].map((_, w) => {
            const points = [];
            const offset = (frame / 5.5) + (w * 5.2);
            for (let i = 0; i <= dotsCount; i++) {
              const x = (i / dotsCount) * 600;
              // Undulating sine waves with decay envelopes on edges
              const y = 120 + Math.sin(i * 0.45 + offset) * (45 - w * 10) * Math.sin((i / dotsCount) * Math.PI);
              points.push(`${x},${y}`);
            }
            const pathData = `M ${points.join(" L ")}`;

            return (
              <path
                key={w}
                d={pathData}
                fill="none"
                stroke={w === 0 ? "#5bf2b9" : w % 2 === 0 ? "#8b5cf6" : "#047857"}
                strokeWidth={w === 0 ? "4" : "1.8"}
                opacity={0.85 - (w * 0.2)}
                strokeLinecap="round"
              />
            );
          })}
        </svg>

        <IOSDevice scale={phoneScale} glowColor="rgba(139, 92, 246, 0.08)">
          <ActiveCallMockup frame={frame} />
        </IOSDevice>

      </div>

    </AbsoluteFill>
  );
};

// Scene 5: Outro / Call To Action (24s - 30s / Frame 720-900)
const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 70 },
  });

  const buttonPulse = 1 + Math.sin(frame / 7) * 0.02;

  // Phone scale and entry
  const phoneScale = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 60 },
  });

  return (
    <AbsoluteFill className="flex flex-row items-center justify-center text-white select-none px-20">
      
      {/* Left side CTA details */}
      <div className="flex-1 flex flex-col items-start justify-center pr-10 z-10">
        {/* Brand Icon showing the REAL app logo with ambient breathing glow */}
        <div className="mb-5">
          <AppIcon scale={logoScale * 0.9} glow={0.65} />
        </div>

        {/* Brand Title */}
        <h1
          style={{ fontFamily: orbitronFont }}
          className="text-4xl font-black bg-gradient-to-r from-emerald-300 via-emerald-100 to-emerald-400 bg-clip-text text-transparent drop-shadow-[0_0_15px_rgba(91,242,185,0.4)] tracking-[8px]"
        >
          AEGIS LINK
        </h1>

        <p
          style={{ fontFamily: interFont }}
          className="text-gray-400 mt-2 text-sm tracking-[4px] uppercase font-light text-left"
        >
          Tu Privacidad No Se Negocia
        </p>

        {/* Mock Aegis ID showing complete anonymity */}
        <div className="mt-6 bg-black/60 border border-[#5bf2b9]/25 px-5 py-3 rounded-2xl backdrop-blur-md flex items-center gap-3">
          <span style={{ fontFamily: orbitronFont }} className="text-gray-400 text-[10px] uppercase tracking-widest font-bold">
            Tu ID Anónimo:
          </span>
          <span
            style={{ fontFamily: orbitronFont }}
            className="text-[#5bf2b9] text-xs font-bold tracking-widest bg-emerald-950/30 px-3 py-1 rounded-lg border border-[#5bf2b9]/20"
          >
            AEG-9024-KZX9
          </span>
        </div>

        {/* Call to Action Button */}
        <button
          style={{
            fontFamily: orbitronFont,
            transform: `scale(${buttonPulse})`,
            textShadow: "0 0 10px rgba(91, 242, 185, 0.4)",
          }}
          className="mt-8 bg-gradient-to-r from-[#10b981] to-[#0d8f5f] hover:from-[#5bf2b9] hover:to-[#10b981] border border-[#5bf2b9]/65 text-white font-bold tracking-[3px] text-[10px] px-8 py-4 rounded-full shadow-[0_0_30px_rgba(91,242,185,0.3)] cursor-pointer"
        >
          ENTRAR A LA RED ANÓNIMA
        </button>

        {/* Available platforms details */}
        <div
          style={{ fontFamily: interFont }}
          className="mt-8 flex items-center gap-4 text-gray-500 text-[10.5px] tracking-wider"
        >
          <span>DISPONIBLE EN IOS Y ANDROID</span>
          <span>•</span>
          <span>REGISTRO 100% ANÓNIMO</span>
        </div>
      </div>

      {/* Right side Phone showing Verification QR screen */}
      <div className="flex-shrink-0 relative flex items-center justify-center z-10">
        <IOSDevice scale={phoneScale}>
          <VerificationMockup />
        </IOSDevice>
      </div>

    </AbsoluteFill>
  );
};

// Main Composition Component integrating the scenes via Sequenced layers
export const MyComposition: React.FC = () => {
  const { fps } = useVideoConfig();
  
  // Timing variables adjusted for a 30-second video (900 frames)
  const SCENE_DURATION = 6 * fps; // 180 frames per scene (6 seconds)

  return (
    <AbsoluteFill className="overflow-hidden font-sans">
      
      {/* Dark ambient cyberpunk background music */}
      <Audio src={staticFile("bgm.wav")} volume={0.75} />

      {/* Background Grid remains active throughout the video */}
      <GridBackground />

      {/* Scene 1: Intro (0s - 6s / Frame 0-180) */}
      <Sequence from={0} durationInFrames={SCENE_DURATION}>
        <IntroScene />
      </Sequence>

      {/* Scene 2: Zero Metadata (6s - 12s / Frame 180-360) */}
      <Sequence from={SCENE_DURATION} durationInFrames={SCENE_DURATION}>
        <MetadataScene />
      </Sequence>

      {/* Scene 3: On-Device Keys (12s - 18s / Frame 360-540) */}
      <Sequence from={2 * SCENE_DURATION} durationInFrames={SCENE_DURATION}>
        <CryptoScene />
      </Sequence>

      {/* Scene 4: Encrypted Calls (18s - 24s / Frame 540-720) */}
      <Sequence from={3 * SCENE_DURATION} durationInFrames={SCENE_DURATION}>
        <CallsScene />
      </Sequence>

      {/* Scene 5: Outro / CTA (24s - 30s / Frame 720-900) */}
      <Sequence from={4 * SCENE_DURATION} durationInFrames={SCENE_DURATION}>
        <OutroScene />
      </Sequence>

    </AbsoluteFill>
  );
};
