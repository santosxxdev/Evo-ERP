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
  IconQuote,
  IconReports,
  IconServices,
  IconSettings,
  IconTarget,
  IconTreasury,
  IconUsers,
  IconVendors,
  IconVouchers,
} from './Icons'

/**
 * هيكلية القائمة الجانبية مقسمة ومرتبة منطقياً حسب أقسام الـ ERP المتكاملة:
 * 1. الرئيسية
 * 2. المبيعات والعملاء
 * 3. المشتريات والموردون
 * 4. الموارد البشرية والرواتب
 * 5. الخزينة والمصروفات
 * 6. الحسابات والتقارير العامة
 * 7. إدارة النظام والإعدادات
 */
export const SIDEBAR_SECTIONS = [
  // 1. لوحة التحكم الرئيسية
  {
    items: [
      { type: 'link', to: '/', labelKey: 'nav.dashboard', Icon: IconDashboard, end: true },
    ],
  },

  // 2. إدارة المبيعات والعملاء
  {
    headerKey: 'nav.section.sales',
    items: [
      { type: 'link', to: '/clients', labelKey: 'nav.clients', Icon: IconClients },
      { type: 'link', to: '/invoices', labelKey: 'nav.invoices', Icon: IconInvoices },
      { type: 'link', to: '/quotations', labelKey: 'nav.rep.quotes', Icon: IconQuote },
      { type: 'link', to: '/campaigns', labelKey: 'nav.campaigns', Icon: IconCampaign },
      { type: 'link', to: '/services', labelKey: 'nav.services', Icon: IconServices },
      {
        type: 'group',
        groupKey: 'nav.group.commissions',
        Icon: IconTarget,
        children: [
          { to: '/sales-commissions', labelKey: 'nav.salesCommissions' },
          { to: '/sales-periods', labelKey: 'nav.salesPeriods' },
          { to: '/commission-rules', labelKey: 'nav.commissionRules' },
        ],
      },
    ],
  },

  // 3. المشتريات والموردون والدائنون التجاريون
  {
    headerKey: 'nav.section.purchases',
    items: [
      {
        type: 'group',
        groupKey: 'nav.group.vendors',
        Icon: IconVendors,
        children: [
          { to: '/vendors', labelKey: 'nav.vendors.list' },
          { to: '/vendor-statement', labelKey: 'nav.vendors.statement' },
        ],
      },
    ],
  },

  // 4. الموارد البشرية والمرتبات
  {
    headerKey: 'nav.section.hr',
    items: [
      {
        type: 'group',
        groupKey: 'nav.employees',
        Icon: IconEmployees,
        children: [
          { to: '/employees', labelKey: 'nav.employees.list' },
          { to: '/payroll', labelKey: 'nav.payroll' },
          { to: '/attendance', labelKey: 'nav.employees.attendance' },
          { to: '/departments', labelKey: 'nav.employees.depts' },
          { to: '/positions', labelKey: 'nav.employees.positions' },
          { to: '/employee-migration', labelKey: 'nav.employees.renumber' },
        ],
      },
    ],
  },

  // 5. الخزينة والمالية العامة
  {
    headerKey: 'nav.section.finance',
    items: [
      { type: 'link', to: '/treasury', labelKey: 'nav.treasury', Icon: IconTreasury },
      { type: 'link', to: '/expenses', labelKey: 'nav.expenses', Icon: IconExpenses },
      { type: 'link', to: '/assets', labelKey: 'nav.assets', Icon: IconAssets },
    ],
  },

  // 6. المحاسبة العامة والتقارير
  {
    headerKey: 'nav.section.accounting',
    items: [
      {
        type: 'group',
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
        type: 'group',
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
        type: 'group',
        groupKey: 'nav.group.salesReports',
        Icon: IconReports,
        children: [
          { to: '/reports/sales-report', labelKey: 'nav.rep.salesReport' },
          { to: '/reports/invoice-profit', labelKey: 'nav.rep.invoiceProfit' },
          { to: '/reports/receivables', labelKey: 'nav.rep.receivables' },
          { to: '/reports/ad-budget', labelKey: 'nav.rep.ads' },
          { to: '/reports/invoices-report', labelKey: 'nav.rep.invoicesReport' },
        ],
      },
      {
        type: 'group',
        groupKey: 'nav.group.financeReports',
        Icon: IconReports,
        children: [
          { to: '/reports/expenses-detail', labelKey: 'nav.rep.expensesDetail' },
          { to: '/reports/revenue-detail', labelKey: 'nav.rep.revenueDetail' },
        ],
      },
    ],
  },

  // 7. إدارة النظام والمستخدمين والإعدادات
  {
    headerKey: 'nav.section.admin',
    items: [
      { type: 'link', to: '/users', labelKey: 'nav.users', Icon: IconUsers },
      {
        type: 'group',
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
    ],
  },
]

// للمطابقة مع Topbar.jsx والتوافقية الكاملة
export const NAV_ITEMS = SIDEBAR_SECTIONS.flatMap((s) => s.items).filter((i) => i.type === 'link')
export const NAV_GROUPS = SIDEBAR_SECTIONS.flatMap((s) => s.items).filter((i) => i.type === 'group')

const stripQuery = (to) => to.split('?')[0]
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
        className="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-slate-400 transition hover:bg-white/5 hover:text-white"
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

  const isDesktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  const drawerHidden = !open && !isDesktop

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

      <aside
        data-theme="light"
        style={{
          insetInlineStart: 0,
          transform: drawerHidden ? `translateX(${dir === 'rtl' ? '' : '-'}100%)` : 'translateX(0)',
        }}
        className="fixed inset-y-0 z-40 flex w-[268px] flex-col bg-ink-950 transition-transform duration-300"
      >
        {/* الهوية وشعار النظام */}
        <div className="flex items-center justify-between px-5 py-5 border-b border-white/5">
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

        {/* قائمة التنقل المصنفة والمرتبة */}
        <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
          {SIDEBAR_SECTIONS.map((section, sIdx) => {
            // تصفية العناصر المسموحة لدور المستخدم الحالي
            const accessibleItems = section.items.filter((item) => {
              if (item.type === 'link') {
                return canAccess(role, item.to)
              }
              if (item.type === 'group') {
                return item.children.some((child) => canAccess(role, sectionOf(child.to)))
              }
              return false
            })

            // إذا لم يكن هناك أي عنصر متاح في هذا القسم للمستخدم، لا يُعرض القسم
            if (accessibleItems.length === 0) return null

            return (
              <div key={section.headerKey || `section-${sIdx}`} className="space-y-1">
                {section.headerKey && (
                  <p className="px-3.5 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    {t(section.headerKey)}
                  </p>
                )}

                {accessibleItems.map((item) => {
                  if (item.type === 'link') {
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        onClick={onClose}
                        className={({ isActive }) =>
                          `flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
                            isActive
                              ? 'bg-brand-600 text-white shadow-lg shadow-brand-900/40'
                              : 'text-slate-400 hover:bg-white/5 hover:text-white'
                          }`
                        }
                      >
                        <item.Icon className="h-5 w-5 shrink-0" />
                        <span className="truncate">{t(item.labelKey)}</span>
                      </NavLink>
                    )
                  }

                  if (item.type === 'group') {
                    return (
                      <NavGroup
                        key={item.groupKey}
                        group={item}
                        role={role}
                        onClose={onClose}
                        isOpen={openGroup === item.groupKey}
                        onToggle={() =>
                          setOpenGroup((current) => (current === item.groupKey ? '' : item.groupKey))
                        }
                      />
                    )
                  }

                  return null
                })}
              </div>
            )
          })}
        </nav>

        {/* تذييل السايدبار */}
        <div className="border-t border-white/5 px-5 py-4">
          <p className="text-[11px] font-medium text-slate-600">v1.0 · iyora</p>
          <PoweredBy tone="dark" className="mt-1" />
        </div>
      </aside>
    </>
  )
}
