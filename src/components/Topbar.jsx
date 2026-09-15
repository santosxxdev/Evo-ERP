import { useLocation } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../lib/theme'
import { NAV_ITEMS, NAV_GROUPS } from './Sidebar'
import { IconGlobe, IconLogout, IconMenu, IconMoon, IconSun } from './Icons'

export default function Topbar({ onOpenMenu }) {
  const { t, toggleLang } = useI18n()
  const { logout, username } = useAuth()
  const { isDark, toggle: toggleTheme } = useTheme()
  const { pathname, search } = useLocation()

  const current = NAV_ITEMS.find((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to)))

  /* صفحات التقارير: العنوان من الرابط الفرعي المطابق في الدرج */
  const here = pathname + search
  const reportChild = !current
    ? NAV_GROUPS.flatMap((group) => group.children).find((child) =>
        child.to.includes('?') ? here === child.to : pathname === child.to,
      )
    : null
  const titleKey = current?.labelKey ?? reportChild?.labelKey

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur-lg sm:px-6">
      <button
        type="button"
        onClick={onOpenMenu}
        className="rounded-xl p-2 text-slate-600 transition hover:bg-slate-100 lg:hidden"
        aria-label={t('top.menu')}
      >
        <IconMenu />
      </button>

      <h1 className="flex-1 truncate text-base font-bold text-slate-900 sm:text-lg">
        {titleKey ? t(titleKey) : t('app.name')}
      </h1>

      <button
        type="button"
        onClick={toggleTheme}
        aria-label={isDark ? t('top.light') : t('top.dark')}
        className="inline-flex items-center justify-center rounded-xl border border-slate-200 p-2 text-slate-600
                   transition hover:bg-slate-50"
      >
        {isDark ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
      </button>

      <button
        type="button"
        onClick={toggleLang}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold
                   text-slate-600 transition hover:bg-slate-50"
      >
        <IconGlobe className="h-4 w-4" />
        <span className="hidden sm:inline">{t('top.lang')}</span>
      </button>

      <div className="hidden items-center gap-2.5 rounded-xl bg-slate-100 py-1.5 pe-3 ps-1.5 sm:flex">
        <span
          className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-xs font-bold uppercase text-white"
          style={{ direction: 'ltr' }}
        >
          {(username ?? 'a').slice(0, 1)}
        </span>
        <span className="text-xs font-semibold text-slate-700">{t('top.admin')}</span>
      </div>

      <button
        type="button"
        onClick={logout}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold
                   text-slate-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
      >
        <IconLogout className="h-4 w-4" />
        <span className="hidden sm:inline">{t('top.logout')}</span>
      </button>
    </header>
  )
}
