// Brand fonts, loaded at startup via useFonts() in App.tsx.
//
// VAULT design language = Space Grotesk (display + body) + JetBrains Mono.
// These match the prototype (prototype/theme.jsx); before this the app fell
// back to the system font (Roboto/San Francisco), which is why screens did not
// look like the prototype.
//
// Only App.tsx imports this module — it pulls in the .ttf assets via
// @expo-google-fonts. vault.ts references the family-name strings directly
// (plain literals) so the theme has no dependency on the font binaries and
// stays trivially importable from the Jest suite.
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono';

/** Map passed to useFonts(). Keys become the fontFamily strings used in styles. */
export const fontAssets = {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} as const;
