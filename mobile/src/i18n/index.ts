import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import { ss } from '../utils/secureStore';
import en from './locales/en.json';
import it from './locales/it.json';
import es from './locales/es.json';

export type SupportedLocale = 'en' | 'it' | 'es';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'it', 'es'];

/** SecureStore key the language choice is persisted under (see useLocale.ts). */
const LANGUAGE_KEY = 'app_language';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      it: { translation: it },
      es: { translation: es },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: {
      // React already escapes output — no need to escape again
      escapeValue: false,
    },
    compatibilityJSON: 'v4',
  });

/**
 * Resolve the user's chosen app language for NON-React / background contexts —
 * notifications are built while the app is backgrounded or freshly woken, where
 * the React `useLocale` hook may not have run yet and `i18n.language` is still
 * the init default ('en'). Reads the SAME persisted key `useLocale` writes,
 * falling back to the device locale, then 'en'. Never throws.
 */
export async function resolveActiveLocale(): Promise<SupportedLocale> {
  try {
    const stored = await ss.get(LANGUAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored as SupportedLocale)) {
      return stored as SupportedLocale;
    }
  } catch { /* SecureStore unavailable — fall through */ }
  try {
    for (const l of Localization.getLocales()) {
      const lang = l.languageCode?.toLowerCase();
      if (lang && SUPPORTED_LOCALES.includes(lang as SupportedLocale)) {
        return lang as SupportedLocale;
      }
    }
  } catch { /* Localization unavailable — fall through */ }
  return 'en';
}

/**
 * Background-safe translate: resolves the persisted locale and translates with
 * it EXPLICITLY (`{ lng }`), so a notification built before `i18n.changeLanguage`
 * ran still renders in the user's language instead of the default 'en'. Use this
 * for any string shown from a notification/background task, NOT React `t()`.
 */
export async function tAsync(
  key: string,
  opts?: Record<string, unknown>,
): Promise<string> {
  const lng = await resolveActiveLocale();
  return i18n.t(key, { lng, ...opts }) as string;
}

export default i18n;
