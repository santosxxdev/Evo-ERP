import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import { COL, useCollection } from '../lib/db'
import { useI18n } from '../i18n'
import { PoweredBy } from './ui'

/**
 * تنبيه صريح عندما ترفض Firestore القراءة/الكتابة، بدل إظهار شاشات فارغة
 * توحي بأن البيانات غير موجودة.
 */
function RulesBanner() {
  const { t } = useI18n()
  const { error } = useCollection(COL.clients, 'name', 'asc')

  if (error?.code !== 'permission-denied') return null

  return (
    <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-5 py-4">
      <p className="text-sm font-bold text-red-800">{t('error.rules.title')}</p>
      <p className="mt-1 text-sm leading-relaxed text-red-700">{t('error.rules.body')}</p>
    </div>
  )
}

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  return (
    <div className="min-h-dvh bg-slate-100">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />

      <div className="lg:ms-[264px]">
        <Topbar onOpenMenu={() => setMenuOpen(true)} />
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
          <RulesBanner />
          <Outlet />

          {/* توقيع يظهر في الطباعة والتقارير فقط */}
          <div className="hidden print:mt-8 print:flex print:justify-between print:border-t print:border-slate-200 print:pt-3">
            <span className="text-[11px] font-semibold text-slate-500">iyora</span>
            <PoweredBy />
          </div>
        </main>
      </div>
    </div>
  )
}
