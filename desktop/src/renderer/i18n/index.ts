import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import it from './locales/it.json';
import es from './locales/es.json';

export type SupportedLocale = 'en' | 'it' | 'es';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'it', 'es'];

const LANGUAGE_KEY = 'app_language';

/**
 * Initial language: the user's saved choice (Privacy → Language), else the OS
 * locale when supported, else English. Resolved HERE at module init — not in a
 * screen hook — so the very first render (splash, sidebar, home) is already in
 * the right language instead of flipping when the settings screen mounts.
 */
export function resolveInitialLocale(): SupportedLocale {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LANGUAGE_KEY) : null;
    if (stored && SUPPORTED_LOCALES.includes(stored as SupportedLocale)) return stored as SupportedLocale;
  } catch { /* storage unavailable */ }
  const languages = typeof navigator !== 'undefined' ? (navigator.languages || [navigator.language]) : [];
  for (const l of languages) {
    const lang = (l || '').split('-')[0].toLowerCase() as SupportedLocale;
    if (lang && SUPPORTED_LOCALES.includes(lang)) return lang;
  }
  return 'en';
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      it: { translation: it },
      es: { translation: es },
    },
    lng: resolveInitialLocale(),
    fallbackLng: 'en',
    interpolation: {
      // React already escapes output — no need to escape again
      escapeValue: false,
    },
    compatibilityJSON: 'v4',
  });

export default i18n;
