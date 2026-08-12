import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import i18n, { applyDocumentLocale, LOCALE_STORAGE_KEY, resolveLocale, savedLocalePreference, type Locale, type LocalePreference } from './index';

type LocaleState = {
  locale: Locale;
  preference: LocalePreference;
  setPreference(preference: LocalePreference): void;
};

const LocaleContext = createContext<LocaleState | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<LocalePreference>(savedLocalePreference);
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(preference));

  useEffect(() => {
    const apply = () => {
      const next = resolveLocale(preference);
      setLocale(next);
      applyDocumentLocale(next);
      window.localStorage.setItem(LOCALE_STORAGE_KEY, preference);
      void i18n.changeLanguage(next);
    };
    apply();
    if (preference !== 'system') return;
    window.addEventListener('languagechange', apply);
    return () => window.removeEventListener('languagechange', apply);
  }, [preference]);

  const value = useMemo(() => ({ locale, preference, setPreference }), [locale, preference]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('LocaleProvider is missing');
  return value;
}
