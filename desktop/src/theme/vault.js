// Design tokens ported from theme.jsx — VAULT dark + VAULT_LIGHT

export const VAULT = {
  // identity
  name: 'Vault',
  tag: 'Cryptographic · Anonymous · On-device',
  dark: true,
  italic: false,
  displayWeight: 600,
  // colors
  bg: '#0a0e0d',
  surface: '#11181a',
  surface2: '#1a2326',
  surface3: '#243033',
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.14)',
  text: '#e8f0ec',
  textDim: 'rgba(232,240,236,0.58)',
  textFaint: 'rgba(232,240,236,0.32)',
  // keep textMuted alias so existing components work unchanged
  textMuted: 'rgba(232,240,236,0.58)',
  accent: '#5bf2b9',
  accentDeep: '#1f8a5b',
  accentInk: '#06231a',
  // keep accentDim alias for hover states
  accentDim: '#3fd49e',
  danger: '#ff6b6b',
  warn: '#f0c674',
  divider: 'rgba(255,255,255,0.05)',
  logoStroke: '#5bf2b9',
  bubbleIn: '#1a2326',
  bubbleInText: '#e8f0ec',
  bubbleOut: '#5bf2b9',
  bubbleOutText: '#06231a',
  // shape
  radius: 14,
  radiusS: 8,
  radiusL: 22,
  // type
  font: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
  fontDisplay: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
};

export const VAULT_LIGHT = {
  ...VAULT,
  dark: false,
  bg: '#f1efe7',
  surface: '#ffffff',
  surface2: '#ece9df',
  surface3: '#d8d4c6',
  border: 'rgba(10,22,20,0.08)',
  borderStrong: 'rgba(10,22,20,0.20)',
  text: '#0a1614',
  textDim: 'rgba(10,22,20,0.58)',
  textFaint: 'rgba(10,22,20,0.32)',
  textMuted: 'rgba(10,22,20,0.58)',
  accent: '#0d8f5f',
  accentDeep: '#085c3e',
  accentInk: '#ffffff',
  accentDim: '#0b7a52',
  danger: '#b8442a',
  warn: '#a87f1f',
  divider: 'rgba(10,22,20,0.06)',
  logoStroke: '#0d8f5f',
  bubbleIn: '#ece9df',
  bubbleInText: '#0a1614',
  bubbleOut: '#0d8f5f',
  bubbleOutText: '#ffffff',
};

// Default export: dark theme
export const vault = VAULT;
export default VAULT;
