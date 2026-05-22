import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import it from './locales/it.json';
import es from './locales/es.json';

export type SupportedLocale = 'en' | 'it' | 'es';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'it', 'es'];

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

export default i18n;
