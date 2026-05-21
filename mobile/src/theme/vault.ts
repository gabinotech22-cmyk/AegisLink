import { Platform } from 'react-native';

export interface Theme {
  name: 'Vault';
  dark: boolean;
  // Colors
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentDeep: string;
  accentInk: string;
  danger: string;
  warn: string;
  divider: string;
  bubbleIn: string;
  bubbleInText: string;
  bubbleOut: string;
  bubbleOutText: string;
  // Shape
  radius: number;
  radiusS: number;
  radiusL: number;
  // Fonts
  font: string;
  fontMono: string;
  fontDisplay: string;
}

const fontMono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
}) as string;

const fontDisplay = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'System',
}) as string;

const baseShape = {
  name: 'Vault' as const,
  radius: 14,
  radiusS: 8,
  radiusL: 22,
  font: fontDisplay,
  fontMono,
  fontDisplay,
};

export const VAULT_DARK: Theme = {
  ...baseShape,
  dark: true,
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
  bubbleIn: '#1a2326',
  bubbleInText: '#e8f0ec',
  bubbleOut: '#5bf2b9',
  bubbleOutText: '#06231a',
};

export const VAULT_LIGHT: Theme = {
  ...baseShape,
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
  bubbleIn: '#ece9df',
  bubbleInText: '#0a1614',
  bubbleOut: '#0d8f5f',
  bubbleOutText: '#ffffff',
};
