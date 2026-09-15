import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import ar from './ar.json'
import en from './en.json'

const dictionaries = { ar, en }
const STORAGE_KEY = 'iyora.lang'

const I18nContext = createContext(null)

function readStoredLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'ar' || saved === 'en') return saved
  } catch {
    /* المتصفح قد يمنع التخزين — نتجاهل ونكمل بالافتراضي */
  }
  return 'ar'
}

export function I18nProvider({ children }) {
  const [lang, setLang] = useState(readStoredLang)
  const dir = lang === 'ar' ? 'rtl' : 'ltr'

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch {
      /* لا شيء */
    }
    document.documentElement.lang = lang
    document.documentElement.dir = dir
  }, [lang, dir])

  const t = useCallback(
    (key, vars) => {
      let text = dictionaries[lang]?.[key] ?? dictionaries.ar[key] ?? key
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value))
        }
      }
      return text
    },
    [lang],
  )

  const value = useMemo(
    () => ({
      lang,
      dir,
      t,
      setLang,
      toggleLang: () => setLang((current) => (current === 'ar' ? 'en' : 'ar')),
      locale: lang === 'ar' ? 'ar-EG' : 'en-GB',
    }),
    [lang, dir, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>')
  return context
}
