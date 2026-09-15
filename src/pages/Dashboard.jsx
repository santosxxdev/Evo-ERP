import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { canSeeMoneyInternals } from '../lib/roles'
import { COL, useCollection, useLookup } from '../lib/db'
import {
  formatDate,
  formatMoney,
  isWithin,
  lastMonths,
  monthKey,
  monthStartISO,
  todayISO,
  toNumber,
} from '../lib/format'
import { isClientFunded, isOverdue, remainingOf, statusOf, statusTone } from '../lib/invoice'
import { invoiceFees } from '../lib/costing'
import { Badge, Loading, PageHeader, StatCard, Td, TableWrap, Th } from '../components/ui'
import { IconClients, IconExpenses, IconInvoices, IconReports, IconTrendUp } from '../components/Icons'

export default function Dashboard() {
  const { t, locale } = useI18n()
  const { role } = useAuth()
  /* المصروفات وما يُشتق منها تخص المدير والمحاسب فقط — قسم المبيعات
     وغيره لا يرى الأرباح ولا المرتبات ولا المصروفات إطلاقًا */
  const finance = canSeeMoneyInternals(role)

  const { rows: invoices, loading } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc', finance)
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: expenseCategories } = useCollection(COL.expenseCategories, 'name', 'asc', finance)
  const categoryMap = useLookup(expenseCategories)

  const today = todayISO()
  const monthStart = monthStartISO()

  const stats = useMemo(() => {
    const monthInvoices = invoices.filter((invoice) => isWithin(invoice.date, monthStart, today))
    const monthExpenses = expenses.filter(
      (expense) => isWithin(expense.date, monthStart, today) && !isClientFunded(expense, categoryMap),
    )

    const revenue = monthInvoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0)
    /* الأتعاب = إيراد الشركة الصافي — بدون ميزانية الإعلانات وبدون الضريبة */
    const fees = monthInvoices.reduce((sum, invoice) => sum + invoiceFees(invoice), 0)
    const collected = monthInvoices.reduce((sum, invoice) => sum + toNumber(invoice.paidAmount), 0)
    const spent = monthExpenses.reduce((sum, expense) => sum + toNumber(expense.amount), 0)
    const due = invoices.reduce((sum, invoice) => sum + Math.max(remainingOf(invoice), 0), 0)

    return { revenue, fees, collected, spent, due, net: fees - spent }
  }, [invoices, expenses, categoryMap, monthStart, today])

  const chart = useMemo(() => {
    const months = lastMonths(6)
    const data = months.map((key) => ({ key, revenue: 0, expenses: 0 }))
    const index = new Map(data.map((entry, position) => [entry.key, position]))

    for (const invoice of invoices) {
      const position = index.get(monthKey(invoice.date))
      if (position !== undefined) data[position].revenue += toNumber(invoice.total)
    }
    for (const expense of expenses) {
      if (isClientFunded(expense, categoryMap)) continue
      const position = index.get(monthKey(expense.date))
      if (position !== undefined) data[position].expenses += toNumber(expense.amount)
    }
    return data
  }, [invoices, expenses, categoryMap])

  const chartMax = Math.max(1, ...chart.flatMap((entry) => [entry.revenue, entry.expenses]))

  const topEmployee = useMemo(() => {
    const map = new Map()
    for (const invoice of invoices) {
      if (!invoice.employeeId) continue
      const current = map.get(invoice.employeeId) ?? { name: invoice.employeeName || '—', value: 0 }
      current.value += toNumber(invoice.total)
      map.set(invoice.employeeId, current)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)[0] ?? null
  }, [invoices])

  const topService = useMemo(() => {
    const map = new Map()
    for (const invoice of invoices) {
      for (const item of invoice.items ?? []) {
        const current = map.get(item.name) ?? { name: item.name, value: 0 }
        current.value += toNumber(item.total)
        map.set(item.name, current)
      }
    }
    return [...map.values()].sort((a, b) => b.value - a.value)[0] ?? null
  }, [invoices])

  const overdue = useMemo(
    () => invoices.filter((invoice) => isOverdue(invoice, today)).slice(0, 5),
    [invoices, today],
  )

  const recent = invoices.slice(0, 5)

  if (loading) return <Loading />

  return (
    <div className="space-y-6">
      <PageHeader title={t('dash.title')} subtitle={t('dash.subtitle')} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label={t('dash.revenue')}
          value={formatMoney(stats.revenue)}
          suffix={t('common.currency')}
          Icon={IconInvoices}
        />
        <StatCard
          label={t('dash.collected')}
          value={formatMoney(stats.collected)}
          suffix={t('common.currency')}
          tone="text-emerald-600 bg-emerald-50"
          Icon={IconTrendUp}
        />
        <StatCard
          label={t('dash.due')}
          value={formatMoney(stats.due)}
          suffix={t('common.currency')}
          tone="text-amber-600 bg-amber-50"
          Icon={IconReports}
        />
        {finance && (
          <>
            <StatCard
              label={t('dash.expenses')}
              value={formatMoney(stats.spent)}
              suffix={t('common.currency')}
              tone="text-rose-600 bg-rose-50"
              Icon={IconExpenses}
            />
            <StatCard
              label={t('dash.profit')}
              value={formatMoney(stats.net)}
              suffix={t('common.currency')}
              tone="text-sky-600 bg-sky-50"
              Icon={IconTrendUp}
            />
          </>
        )}
        <StatCard
          label={t('dash.clients')}
          value={clients.length}
          tone="text-violet-600 bg-violet-50"
          Icon={IconClients}
        />
      </div>

      {/* الرسم البياني يقارن بالمصروفات — لا يظهر لمن لا يراها */}
      {finance && (
      <div className="card p-5">
        <h3 className="mb-5 text-sm font-bold text-slate-900">{t('dash.chart')}</h3>
        <div className="flex items-end justify-between gap-3 sm:gap-6">
          {chart.map((entry) => (
            <div key={entry.key} className="flex flex-1 flex-col items-center gap-2">
              <div className="flex h-40 w-full items-end justify-center gap-1.5">
                <div
                  className="w-full max-w-[26px] rounded-t-lg bg-brand-500 transition-all"
                  style={{ height: `${Math.max(2, (entry.revenue / chartMax) * 100)}%` }}
                  title={formatMoney(entry.revenue)}
                />
                <div
                  className="w-full max-w-[26px] rounded-t-lg bg-rose-400 transition-all"
                  style={{ height: `${Math.max(2, (entry.expenses / chartMax) * 100)}%` }}
                  title={formatMoney(entry.expenses)}
                />
              </div>
              <span className="num text-[11px] font-semibold text-slate-400">{entry.key.slice(2)}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-center gap-5 text-xs font-semibold text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-brand-500" />
            {t('reports.revenue')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
            {t('reports.expenses')}
          </span>
        </div>
      </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <HighlightCard label={t('dash.topEmployee')} entry={topEmployee} />
        <HighlightCard label={t('dash.topService')} entry={topService} />
      </div>

      {overdue.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-bold text-slate-900">{t('dash.overdue')}</h3>
          <InvoiceMiniTable rows={overdue} locale={locale} highlight />
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">{t('dash.recent')}</h3>
          <Link to="/invoices" className="text-xs font-semibold text-brand-600 hover:text-brand-700">
            {t('nav.invoices')} →
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="card px-4 py-10 text-center text-sm text-slate-400">{t('dash.noData')}</p>
        ) : (
          <InvoiceMiniTable rows={recent} locale={locale} />
        )}
      </div>
    </div>
  )
}

function HighlightCard({ label, entry }) {
  const { t } = useI18n()
  return (
    <div className="card p-5">
      <p className="text-sm font-semibold text-slate-500">{label}</p>
      {entry ? (
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <span className="truncate text-lg font-bold text-slate-900">{entry.name}</span>
          <span className="num shrink-0 text-lg font-extrabold text-brand-600">
            {formatMoney(entry.value)}
            <span className="ms-1 text-xs font-semibold text-slate-400">{t('common.currency')}</span>
          </span>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-400">{t('dash.noData')}</p>
      )}
    </div>
  )
}

function InvoiceMiniTable({ rows, locale, highlight }) {
  const { t } = useI18n()
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>{t('invoices.number')}</Th>
          <Th>{t('common.client')}</Th>
          <Th>{t('common.date')}</Th>
          <Th>{t('invoices.total')}</Th>
          <Th>{t('invoices.remaining')}</Th>
          <Th>{t('common.status')}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((invoice) => {
          const state = statusOf(invoice)
          return (
            <tr key={invoice.id} className={highlight ? 'bg-red-50/40' : ''}>
              <Td>
                <span className="num font-bold text-slate-800">{invoice.number}</span>
              </Td>
              <Td className="text-slate-700">{invoice.clientName || '—'}</Td>
              <Td className="text-slate-600">{formatDate(invoice.date, locale)}</Td>
              <Td>
                <span className="num font-semibold">{formatMoney(invoice.total)}</span>
              </Td>
              <Td>
                <span className="num font-semibold text-amber-600">{formatMoney(remainingOf(invoice))}</span>
              </Td>
              <Td>
                <Badge tone={statusTone(state)}>{t(`invoices.status.${state}`)}</Badge>
              </Td>
            </tr>
          )
        })}
      </tbody>
    </TableWrap>
  )
}
