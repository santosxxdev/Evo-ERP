import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { canAccess } from '../lib/roles'
import Brand from './Brand'
import { PoweredBy } from './ui'
import {
  IconAccounting,
  IconAssets,
  IconCampaign,
  IconChevronDown,
  IconClients,
  IconClose,
  IconDashboard,
  IconEmployees,
  IconExpenses,
  IconInvoices,
  IconReports,
  IconServices,
  IconSettings,
  IconTreasury,
  IconUsers,
  IconVendors,
  IconVouchers,
} from './Icons'

export const NAV_ITEMS = [
  { to: '/', labelKey: 'nav.dashboard', Icon: IconDashboard, end: true },
  { to: '/clients', labelKey: 'nav.clients', Icon: IconClients },
  { to: '/payroll', labelKey: 'nav.payroll', Icon: IconExpenses },
  { to: '/vendors', labelKey: 'nav.vendors', Icon: IconVendors },
  { to: '/assets', labelKey: 'nav.assets', Icon: IconAssets },
  { to: '/invoices', labelKey: 'nav.invoices', Icon: IconInvoices },
  { to: '/campaigns', labelKey: 'nav.campaigns', Icon: IconCampaign },
  { to: '/expenses', labelKey: 'nav.expenses', Icon: IconExpenses },
  { to: '/services', labelKey: 'nav.services', Icon: IconServices },
  { to: '/treasury', labelKey: 'nav.treasury', Icon: IconTreasury },
  { to: '/users', labelKey: 'nav.users', Icon: IconUsers },
]

/**
 * مجموعات الدرج القابلة للطي — كل رابط بيروح لصفحته المستقلة، فالمستخدم
 * يلاقي كل قسم في مكانه من غير ما نكرّر المنطق في تبويبات.
 */
export const NAV_GROUPS = [
  {
    groupKey: 'nav.employees',
    Icon: IconEmployees,
    children: [
      { to: '/employees', labelKey: 'nav.employees.list' },
      { to: '/employees?modal=depts', labelKey: 'nav.employees.depts' },
      { to: '/employees?modal=positions', labelKey: 'nav.employees.positions' },
      { to: '/employees?modal=migration', labelKey: 'nav.employees.renumber' },
    ],
  },
  {
    groupKey: 'nav.group.chart',
    Icon: IconAccounting,
    children: [
      { to: '/accounting/tree', labelKey: 'acct.tab.tree' },
      { to: '/accounting/journal', labelKey: 'acct.tab.journal' },
      { to: '/reports/general-ledger', labelKey: 'acct.tab.ledger' },
      { to: '/reports/trial-balance', labelKey: 'acct.tab.trial' },
      { to: '/reports/income-statement', labelKey: 'acct.tab.income' },
      { to: '/reports/balance-sheet', labelKey: 'acct.tab.balance' },
      { to: '/reports/cash-flow', labelKey: 'acct.tab.cashflow' },
      { to: '/reports/tax-return', labelKey: 'acct.tab.tax' },
    ],
  },
  {
    groupKey: 'nav.group.financeReports',
    Icon: IconReports,
    children: [
      { to: '/reports/expenses-detail', labelKey: 'nav.rep.expensesDetail' },
      { to: '/reports/revenue-detail', labelKey: 'nav.rep.revenueDetail' },
      { to: '/reports/receivables', labelKey: 'nav.rep.receivables' },
    ],
  },
  {
    groupKey: 'nav.group.vouchers',
    Icon: IconVouchers,
    children: [
      { to: '/vouchers?type=opening', labelKey: 'vouchers.type.opening' },
      { to: '/vouchers?type=payment', labelKey: 'vouchers.type.payment' },
      { to: '/vouchers?type=receipt', labelKey: 'vouchers.type.receipt' },
      { to: '/vouchers?type=drawing', labelKey: 'vouchers.type.drawing' },
      { to: '/vouchers?type=tax', labelKey: 'vouchers.type.tax' },
      { to: '/vouchers?type=transfer', labelKey: 'vouchers.type.transfer' },
      { to: '/vouchers?type=manual', labelKey: 'vouchers.type.manual' },
    ],
  },
  {
    groupKey: 'nav.group.salesReports',
    Icon: IconReports,
    children: [
      { to: '/reports/sales-report', labelKey: 'nav.rep.salesReport' },
      { to: '/reports/invoice-profit', labelKey: 'nav.rep.invoiceProfit' },
      { to: '/reports/ad-budget', labelKey: 'nav.rep.ads' },
      { to: '/quotations', labelKey: 'nav.rep.quotes' },
      { to: '/reports/invoices-report', labelKey: 'nav.rep.invoicesReport' },
    ],
  },
  {
    groupKey: 'nav.settings',
    Icon: IconSettings,
    children: [
      { to: '/settings/expense-categories', labelKey: 'settings.expenseCategories' },
      { to: '/settings/activity-types', labelKey: 'settings.activityTypes' },
      { to: '/settings/payment-methods', labelKey: 'settings.paymentMethods' },
      { to: '/settings/service-categories', labelKey: 'settings.serviceCategories' },
      { to: '/settings/company', labelKey: 'settings.company' },
    ],
  },
]

const stripQuery = (to) => to.split('?')[0]
/** القسم الأعلى للمسار — للتحقق من الصلاحية (canAccess يعرف الأقسام لا الصفحات) */
const sectionOf = (to) => `/${stripQuery(to).split('/')[1] ?? ''}`

function NavGroup({ group, role, onClose, isOpen, onToggle }) {
  const { t } = useI18n()
  const { pathname, search } = useLocation()
  const here = pathname + search

  const children = group.children.filter((child) => canAccess(role, sectionOf(child.to)))
  const isChildActive = (child) =>
    child.to.includes('?') ? here === child.to : pathname === child.to

  if (children.length === 0) return null

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold text-slate-400 transition hover:bg-white/5 hover:text-white"
      >
        <group.Icon className="h-5 w-5 shrink-0" />
        <span className="flex-1 truncate text-start">{t(group.groupKey)}</span>
        <IconChevronDown className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="mt-1 space-y-0.5 ps-4">
          {children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              onClick={onClose}
              className={() =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-semibold transition ${
                  isChildActive(child)
                    ? 'bg-brand-600/90 text-white'
                    : 'text-slate-500 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
              <span className="truncate">{t(child.labelKey)}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar({ open, onClose }) {
  const { t, dir } = useI18n()
  const { role } = useAuth()
  const { pathname, search } = useLocation()

  /* على الشاشات الكبيرة الشريط ثابت دائمًا، ولا يُخفى إطلاقًا */
  const isDesktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  const drawerHidden = !open && !isDesktop

  /* الأقسام المعروضة تتبع دور المستخدم */
  const items = NAV_ITEMS.filter((item) => canAccess(role, item.to))

  /* أكورديون: مجموعة واحدة مفتوحة فقط — تُفتح مجموعة الصفحة الحالية تلقائيًا */
  const here = pathname + search
  const activeGroupKey =
    NAV_GROUPS.find((group) =>
      group.children.some((child) =>
        child.to.includes('?') ? here === child.to : pathname === child.to,
      ),
    )?.groupKey ?? ''
  const [openGroup, setOpenGroup] = useState(activeGroupKey)
  useEffect(() => {
    if (activeGroupKey) setOpenGroup(activeGroupKey)
  }, [activeGroupKey])

  return (
    <>
      {/* غطاء التعتيم على الموبايل */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-slate-900/50 backdrop-blur-sm transition-opacity dark:bg-black/60 lg:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      {/*
        الموضع والإزاحة بأنماط صريحة لا بأدوات اتجاهية: مع RTL كانت الأدوات
        المنطقية تدفع الدرج خارج حافة الشاشة فيتقطّع نصّه على الموبايل.
      */}
      <aside
        data-theme="light"
        style={{
          insetInlineStart: 0,
          transform: drawerHidden ? `translateX(${dir === 'rtl' ? '' : '-'}100%)` : 'translateX(0)',
        }}
        className="fixed inset-y-0 z-40 flex w-[264px] flex-col bg-ink-950 transition-transform duration-300"
      >
        <div className="flex items-center justify-between px-5 py-5">
          <Brand tone="dark" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white lg:hidden"
            aria-label={t('top.menu')}
          >
            <IconClose />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-6">
          {items.map(({ to, labelKey, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold transition ${
                  isActive
                    ? 'bg-brand-600 text-white shadow-lg shadow-brand-900/40'
                    : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="truncate">{t(labelKey)}</span>
            </NavLink>
          ))}

          {NAV_GROUPS.some((group) =>
            group.children.some((child) => canAccess(role, sectionOf(child.to))),
          ) && (
            <>
              <p className="px-3.5 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wider text-slate-600">
                {t('nav.group.reports')}
              </p>
              {NAV_GROUPS.map((group) => (
                <NavGroup
                  key={group.groupKey}
                  group={group}
                  role={role}
                  onClose={onClose}
                  isOpen={openGroup === group.groupKey}
                  onToggle={() =>
                    setOpenGroup((current) => (current === group.groupKey ? '' : group.groupKey))
                  }
                />
              ))}
            </>
          )}
        </nav>

        <div className="border-t border-white/5 px-5 py-4">
          <p className="text-[11px] font-medium text-slate-600">v1.0 · iyora</p>
          <PoweredBy tone="dark" className="mt-1" />
        </div>
      </aside>
    </>
  )
}
