import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import en from './en.json';
import ar from './ar.json';

const translations = { en, ar };
const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(() => localStorage.getItem('locale') || 'en');
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.setAttribute('dir', dir);
    document.documentElement.setAttribute('lang', locale);
    localStorage.setItem('locale', locale);
  }, [locale, dir]);

  useEffect(() => {
    const handler = (e) => { if (e.detail?.locale && translations[e.detail.locale]) setLocaleState(e.detail.locale); };
    window.addEventListener('user-preferences', handler);
    return () => window.removeEventListener('user-preferences', handler);
  }, []);

  const setLocale = useCallback((lang) => {
    if (translations[lang]) setLocaleState(lang);
  }, []);

  const t = useCallback((key, params) => {
    const keys = key.split('.');
    let value = translations[locale];
    for (const k of keys) {
      value = value?.[k];
    }
    if (value === undefined || value === null) {
      // Fallback to English
      let fallback = translations.en;
      for (const k of keys) {
        fallback = fallback?.[k];
      }
      value = fallback !== undefined && fallback !== null ? fallback : key;
    }
    if (params && typeof value === 'string') {
      Object.entries(params).forEach(([k, v]) => {
        value = value.replaceAll(`{${k}}`, v);
      });
    }
    return value;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t, dir }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useTranslation must be used within I18nProvider');
  return context;
}
