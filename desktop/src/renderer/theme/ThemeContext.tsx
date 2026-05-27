import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { VAULT_DARK, VAULT_LIGHT, type Theme } from './vault';

interface ThemeCtx {
  t: Theme;
  isDark: boolean;
  setDark: (dark: boolean) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // AegisLink desktop defaults to dark mode.
  // We do NOT follow the OS preference — dark is the canonical AegisLink theme.
  const [dark, setDark] = useState<boolean>(true);

  const value = useMemo<ThemeCtx>(
    () => ({
      t: dark ? VAULT_DARK : VAULT_LIGHT,
      isDark: dark,
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
