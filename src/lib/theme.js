import { useEffect, useState } from 'react'

const KEY = 'iyora-theme'

function preferred() {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    /* وضع خاص / تخزين مقفول */
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** يُستدعى مرة واحدة قبل الرسم حتى لا تومض الشاشة الفاتحة */
export function initTheme() {
  document.documentElement.dataset.theme = preferred()
}

export function useTheme() {
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme || preferred(),
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  /* التخزين يحصل عند التبديل اليدوي فقط — من غير تبديل يفضل النظام يتبع
     إعداد الجهاز في كل مرة */
  const toggle = () =>
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(KEY, next)
      } catch {
        /* نتجاهل */
      }
      return next
    })

  return { theme, isDark: theme === 'dark', toggle }
}
