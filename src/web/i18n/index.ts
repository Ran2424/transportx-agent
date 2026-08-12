import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { enUS, zhCN } from './resources';

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = Locale | 'system';

export const LOCALE_STORAGE_KEY = 'tau-locale';

export function systemLocale(languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages): Locale {
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith('zh')) return 'zh-CN';
    if (normalized.startsWith('en')) return 'en-US';
  }
  return 'zh-CN';
}

export function savedLocalePreference(): LocalePreference {
  if (typeof window === 'undefined') return 'system';
  const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return saved === 'zh-CN' || saved === 'en-US' || saved === 'system' ? saved : 'system';
}

export function resolveLocale(preference: LocalePreference): Locale {
  return preference === 'system' ? systemLocale() : preference;
}

const initialLocale = resolveLocale(savedLocalePreference());

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: initialLocale,
  fallbackLng: 'zh-CN',
  keySeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function applyDocumentLocale(locale: Locale) {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

applyDocumentLocale(initialLocale);

export default i18n;
