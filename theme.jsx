// AegisLink — Two design directions, each available in dark + light mode.
// VAULT: cryptographic, mono+grotesk, mint accent
// ATRIUM: swiss-premium, serif+sans, indigo accent
//
// Every theme exposes the same token shape so screens are mode-agnostic.
// `italic` and `displayWeight` carry the direction's identity through mode flips.

const VAULT = {
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
  // shape
  radius: 14,
  radiusS: 8,
  radiusL: 22,
  // type
  font: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
  fontDisplay: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
};

const VAULT_LIGHT = {
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
  accent: '#0d8f5f',
  accentDeep: '#085c3e',
  accentInk: '#ffffff',
  danger: '#b8442a',
  warn: '#a87f1f',
  divider: 'rgba(10,22,20,0.06)',
  logoStroke: '#0d8f5f',
  bubbleIn: '#ece9df',
  bubbleInText: '#0a1614',
  bubbleOut: '#0d8f5f',
  bubbleOutText: '#ffffff',
};

const ATRIUM = {
  name: 'Atrium',
  tag: 'Swiss minimal · Editorial · Trust as craft',
  dark: false,
  italic: true,
  displayWeight: 400,
  bg: '#f4f1e9',
  surface: '#ffffff',
  surface2: '#ece8dd',
  surface3: '#e0dccf',
  border: 'rgba(28,26,20,0.08)',
  borderStrong: 'rgba(28,26,20,0.18)',
  text: '#191713',
  textDim: 'rgba(25,23,19,0.58)',
  textFaint: 'rgba(25,23,19,0.32)',
  accent: '#2b2f7a',
  accentDeep: '#1c1f55',
  accentInk: '#f4f1e9',
  danger: '#b8442a',
  warn: '#a87f1f',
  divider: 'rgba(28,26,20,0.06)',
  logoStroke: '#2b2f7a',
  bubbleIn: '#ece8dd',
  bubbleInText: '#191713',
  bubbleOut: '#2b2f7a',
  bubbleOutText: '#f4f1e9',
  radius: 4,
  radiusS: 2,
  radiusL: 8,
  font: '"Geist", ui-sans-serif, system-ui, sans-serif',
  fontMono: '"Geist Mono", ui-monospace, "SF Mono", monospace',
  fontDisplay: '"Instrument Serif", "Times New Roman", serif',
};

const ATRIUM_DARK = {
  ...ATRIUM,
  dark: true,
  bg: '#0f1019',
  surface: '#171829',
  surface2: '#20223a',
  surface3: '#2b2d47',
  border: 'rgba(244,241,233,0.08)',
  borderStrong: 'rgba(244,241,233,0.20)',
  text: '#f4f1e9',
  textDim: 'rgba(244,241,233,0.60)',
  textFaint: 'rgba(244,241,233,0.32)',
  accent: '#a5a8ff',
  accentDeep: '#7b7fde',
  accentInk: '#0f1019',
  danger: '#ff7d63',
  warn: '#e8c074',
  divider: 'rgba(244,241,233,0.06)',
  logoStroke: '#a5a8ff',
  bubbleIn: '#20223a',
  bubbleInText: '#f4f1e9',
  bubbleOut: '#a5a8ff',
  bubbleOutText: '#0f1019',
};

// Return the opposite-mode counterpart of a theme. Identity (italic, weights,
// fonts, radii) is preserved; only color tokens swap.
function flipMode(t) {
  if (t.name === 'Vault')  return t.dark ? VAULT_LIGHT : VAULT;
  if (t.name === 'Atrium') return t.dark ? ATRIUM      : ATRIUM_DARK;
  return t;
}

// Fonts loaded by index.html; this is just a safety net.
if (typeof document !== 'undefined' && !document.getElementById('aegis-fonts')) {
  const link = document.createElement('link');
  link.id = 'aegis-fonts';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&family=EB+Garamond:wght@400;500;600&display=swap';
  document.head.appendChild(link);
}

Object.assign(window, { VAULT, VAULT_LIGHT, ATRIUM, ATRIUM_DARK, flipMode });
