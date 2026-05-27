import { useCallback, useEffect, useState } from 'react';
import i18n, { type SupportedLocale, SUPPORTED_LOCALES } from './index';
import { usePreferences } from '../store/preferences';

const LANGUAGE_KEY = 'app_language';

/**
 * Resolves the device locale to a supported app locale.
 * Defaults to 'en' for any unsupported locale.
 */
function resolveDeviceLocale(): SupportedLocale {
  const languages = navigator.languages || [navigator.language];
  for (const l of languages) {
    const lang = l.split('-')[0].toLowerCase() as SupportedLocale;
    if (lang && SUPPORTED_LOCALES.includes(lang)) return lang;
  }
  return 'en';
}

/**
 * Hook to read and change the active app language.
 *
 * - On first render, reads from localStorage.
 * - Falls back to device locale (IT/EN/ES) if nothing is stored.
 * - `setLocale` persists the choice and calls `i18n.changeLanguage` instantly.
 */
export function useLocale() {
  const [locale, setLocaleState] = useState<SupportedLocale>(
    (i18n.language as SupportedLocale) ?? 'en'
  );
  const setPref = usePreferences((s) => s.set);

  // Initialise once from localStorage
  useEffect(() => {
    let active = true;
    try {
      const stored = localStorage.getItem(LANGUAGE_KEY);
      const lang: SupportedLocale =
        stored && SUPPORTED_LOCALES.includes(stored as SupportedLocale)
          ? (stored as SupportedLocale)
          : resolveDeviceLocale();
      if (active && lang !== i18n.language) {
        void i18n.changeLanguage(lang);
      }
      if (active) setLocaleState(lang);
    } catch {
      // localStorage unavailable — use current i18n language
      if (active) setLocaleState(i18n.language as SupportedLocale);
    }
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback(
    async (lang: SupportedLocale) => {
      setLocaleState(lang);
      await i18n.changeLanguage(lang);
      try {
        localStorage.setItem(LANGUAGE_KEY, lang);
      } catch { /* storage unavailable */ }
      void setPref('language', lang);
    },
    [setPref]
  );

  return { locale, setLocale };
}
