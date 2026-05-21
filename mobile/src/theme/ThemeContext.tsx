import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { VAULT_DARK, VAULT_LIGHT, type Theme } from './vault';

interface ThemeCtx {
  t: Theme;
  dark: boolean;
  autoMode: boolean;
  setDark: (dark: boolean) => void;
  setAutoMode: (auto: boolean) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [autoMode, setAutoModeState] = useState(true);
  const [dark, setDarkState] = useState(scheme !== 'light');

  // When auto mode is on, follow the system
  useEffect(() => {
    if (autoMode) setDarkState(scheme !== 'light');
  }, [scheme, autoMode]);

  const setDark = (d: boolean) => {
    setAutoModeState(false);
    setDarkState(d);
  };

  const setAutoMode = (auto: boolean) => {
    setAutoModeState(auto);
    if (auto) setDarkState(scheme !== 'light');
  };

  const value = useMemo<ThemeCtx>(
    () => ({
      t: dark ? VAULT_DARK : VAULT_LIGHT,
      dark,
      autoMode,
      setDark,
      setAutoMode,
      toggle: () => setDark(!dark),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dark, autoMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
