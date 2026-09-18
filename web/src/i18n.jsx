import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { getLocale, setLocale as updateLocale, subscribeLocale, translate } from './i18n.js';

const I18nContext = createContext(null);

function useLocaleSnapshot() {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export function I18nProvider({ children }) {
  const locale = useLocaleSnapshot();
  const setLocale = useCallback((nextLocale) => updateLocale(nextLocale), []);
  const value = useMemo(() => ({
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
  }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (context) return context;
  const locale = getLocale();
  return {
    locale,
    setLocale: (nextLocale) => updateLocale(nextLocale),
    t: (key, params) => translate(locale, key, params),
  };
}

export function LanguageSelect(props) {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      id="language-select"
      className="language-select"
      aria-label={t('language.label')}
      title={t('language.label')}
      value={locale}
      onChange={(event) => setLocale(event.target.value)}
      {...props}
    >
      <option value="zh-CN">{t('language.zh')}</option>
      <option value="en">{t('language.en')}</option>
    </select>
  );
}

