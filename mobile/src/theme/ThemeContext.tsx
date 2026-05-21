import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { VAULT_DARK, VAULT_LIGHT, type Theme } from './vault';

interface ThemeCtx {
  t: Theme;
  setDark: (dark: boolean) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [dark, setDark] = useState(scheme !== 'light');

  const value = useMemo<ThemeCtx>(
    () => ({
      t: dark ? VAULT_DARK : VAULT_LIGHT,
      setDark,
      toggle: () => setDark((d) => !d),
    }),
    [dark]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
