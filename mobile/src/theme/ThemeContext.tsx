import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { VAULT_DARK, VAULT_LIGHT, type Theme } from './vault';
import { usePreferences } from '../store/preferences';

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
  const hydrated = usePreferences((s) => s.hydrated);
  const prefDark = usePreferences((s) => s.themeDark);
  const prefAuto = usePreferences((s) => s.themeAutoMode);
  const setPref = usePreferences((s) => s.set);

  // Seed in-memory state from the persisted preferences once hydrated.
  const [autoMode, setAutoModeState] = useState(false);
  const [dark, setDarkState] = useState(true);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (hydrated && !seeded) {
      setAutoModeState(prefAuto);
      setDarkState(prefAuto ? scheme !== 'light' : prefDark);
      setSeeded(true);
    }
  }, [hydrated, seeded, prefAuto, prefDark, scheme]);

  // When auto mode is on, follow the system
  useEffect(() => {
    if (autoMode) setDarkState(scheme !== 'light');
  }, [scheme, autoMode]);

  const setDark = (d: boolean) => {
    setAutoModeState(false);
    setDarkState(d);
    void setPref('themeDark', d);
    void setPref('themeAutoMode', false);
  };

  const setAutoMode = (auto: boolean) => {
    setAutoModeState(auto);
    if (auto) setDarkState(scheme !== 'light');
    void setPref('themeAutoMode', auto);
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
