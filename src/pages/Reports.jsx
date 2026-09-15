import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useI18n } from '../i18n'
import { COL, useCollection, useLookup } from '../lib/db'
import { formatDate, formatMoney, isWithin, monthStartISO, round2, todayISO, toNumber } from '../lib/format'
import { isClientFunded, remainingOf, statusOf, statusTone } from '../lib/invoice'
import {
  calculateEmployeeTieredCommission,
  expectedProfitBy,
  expectedProfitByService,
  invoiceExpectedProfit,
  invoiceFees,
  invoiceProfit,
  profitBy,
  profitByService,
} from '../lib/costing'
import { JOB_COSTS_COL } from './Vendors'
import {
  Badge,
  Button,
  Field,
  Input,
  Loading,
  PageHeader,
  StatCard,
  Td,
  TableWrap,
  Th,
} from '../components/ui'
import { IconExpenses, IconInvoices, IconReports, IconTrendUp } from '../components/Icons'

const TABS = ['sales', 'receivables', 'ads', 'profitability', 'expenses', 'profit', 'payroll']

/** أتعاب الشركة في الفاتورة = الإجمالي ناقص ميزانية الإعلانات والضريبة */
function feesOf(invoice) {
  return toNumber(invoice.total) - toNumber(invoice.adBudgetTotal) - toNumber(invoice.taxAmount)
}

export default function Reports() {
  const { t, locale } = useI18n()
  const { rows: invoices, loading } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: expenseCategories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')

  const clientMap = useLookup(clients)
  const categoryMap = useLookup(expenseCategories)

  const [searchParams, setSearchParams] = useSearchParams()
  const urlTab = searchParams.get('tab')
  const tab = TABS.includes(urlTab) ? urlTab : 'sales'
  const setTab = (next) => setSearchParams((params) => {
    params.set('tab', next)
    return params
  }, { replace: true })
  const [from, setFrom] = useState(monthStartISO())
  const [to, setTo] = useState(todayISO())

  const periodInvoices = useMemo(
    () => invoices.filter((invoice) => isWithin(invoice.date, from, to)),
    [invoices, from, to],
  )
  const periodExpenses = useMemo(
    () => expenses.filter((expense) => isWithin(expense.date, from, to)),
    [expenses, from, to],
  )

  /* مصروفات الشركة الحقيقية تستبعد الإنفاق الإعلاني المموَّل من ميزانية عميل */
  const companyExpenses = useMemo(
    () => periodExpenses.filter((expense) => !isClientFunded(expense, categoryMap)),
    [periodExpenses, categoryMap],
  )
  const clientAdSpend = useMemo(
    () => periodExpenses.filter((expense) => isClientFunded(expense, categoryMap)),
    [periodExpenses, categoryMap],
  )

  const totals = useMemo(() => {
    const revenue = periodInvoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0)
    const fees = periodInvoices.reduce((sum, invoice) => sum + feesOf(invoice), 0)
    const adBudget = periodInvoices.reduce((sum, invoice) => sum + toNumber(invoice.adBudgetTotal), 0)
    const collected = periodInvoices.reduce((sum, invoice) => sum + toNumber(invoice.paidAmount), 0)
    const spent = companyExpenses.reduce((sum, expense) => sum + toNumber(expense.amount), 0)
    return {
      revenue,
      fees,
      adBudget,
      collected,
      outstanding: revenue - collected,
      expenses: spent,
      net: fees - spent,
    }
  }, [periodInvoices, companyExpenses])

  function groupBy(list, keyOf, labelOf, valueOf) {
    const map = new Map()
    for (const row of list) {
      const key = keyOf(row)
      if (key === undefined || key === null || key === '') continue
      const current = map.get(key) ?? { label: labelOf(row), value: 0, count: 0 }
      current.value += valueOf(row)
      current.count += 1
      map.set(key, current)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }

  const byService = useMemo(() => {
    const map = new Map()
    for (const invoice of periodInvoices) {
      for (const item of invoice.items ?? []) {
        const key = item.name
        const current = map.get(key) ?? { label: key, value: 0, count: 0 }
        current.value += toNumber(item.total)
        current.count += toNumber(item.qty)
        map.set(key, current)
      }
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }, [periodInvoices])

  const byEmployee = useMemo(
    () =>
      groupBy(
        periodInvoices,
        (invoice) => invoice.employeeId,
        (invoice) => invoice.employeeName || '—',
        (invoice) => toNumber(invoice.total),
      ),
    [periodInvoices],
  )

  const byClient = useMemo(
    () =>
      groupBy(
        periodInvoices,
        (invoice) => invoice.clientId,
        (invoice) => clientMap.get(invoice.clientId)?.name ?? invoice.clientName ?? '—',
        (invoice) => toNumber(invoice.total),
      ),
    [periodInvoices, clientMap],
  )

  const byCategory = useMemo(
    () =>
      groupBy(
        periodExpenses,
        (expense) => expense.categoryId,
        (expense) => expense.categoryName || '—',
        (expense) => toNumber(expense.amount),
      ),
    [periodExpenses],
  )

  /* ميزانية الإعلانات لكل عميل مقابل ما أُنفق فعليًا منها */
  const adsByClient = useMemo(() => {
    const map = new Map()
    const ensure = (id, name) => map.get(id) ?? { id, label: name, budget: 0, spent: 0 }

    for (const invoice of periodInvoices) {
      const budget = toNumber(invoice.adBudgetTotal)
      if (budget <= 0 || !invoice.clientId) continue
      const entry = ensure(invoice.clientId, clientMap.get(invoice.clientId)?.name ?? invoice.clientName ?? '—')
      entry.budget += budget
      map.set(invoice.clientId, entry)
    }
    for (const expense of clientAdSpend) {
      const entry = ensure(expense.clientId, clientMap.get(expense.clientId)?.name ?? '—')
      entry.spent += toNumber(expense.amount)
      map.set(expense.clientId, entry)
    }

    return [...map.values()].sort((a, b) => b.budget - a.budget)
  }, [periodInvoices, clientAdSpend, clientMap])

  const clientStatsMap = useMemo(() => {
    const map = new Map()
    for (const invoice of invoices) {
      if (invoice.cancelled) continue
      const cid = invoice.clientId
      if (!cid) continue
      const cur = map.get(cid) || { totalInvoiced: 0, totalPaid: 0, balance: 0 }
      const total = toNumber(invoice.total)
      const paid = toNumber(invoice.paidAmount)
      cur.totalInvoiced += total
      cur.totalPaid += paid
      cur.balance += total - paid
      map.set(cid, cur)
    }
    return map
  }, [invoices])

  const enrichedClients = useMemo(() => {
    return clients.map((c) => {
      const stats = clientStatsMap.get(c.id)
      return {
        ...c,
        totalInvoiced: stats ? stats.totalInvoiced : (c.totalInvoiced || 0),
        totalPaid: stats ? stats.totalPaid : (c.totalPaid || 0),
        balance: stats ? stats.balance : (c.balance || 0),
      }
    })
  }, [clients, clientStatsMap])

  const debtors = useMemo(
    () => enrichedClients.filter((client) => toNumber(client.balance) > 0).sort((a, b) => b.balance - a.balance),
    [enrichedClients],
  )
  const creditors = useMemo(
    () => enrichedClients.filter((client) => toNumber(client.balance) < 0).sort((a, b) => a.balance - b.balance),
    [enrichedClients],
  )

  function exportCsv() {
    const rows = [[t('invoices.number'), t('common.date'), t('common.client'), t('common.employee'), t('invoices.total'), t('invoices.paid'), t('invoices.remaining'), t('common.status')]]
    for (const invoice of periodInvoices) {
      rows.push([
        invoice.number,
        invoice.date,
        clientMap.get(invoice.clientId)?.name ?? invoice.clientName ?? '',
        invoice.employeeName ?? '',
        toNumber(invoice.total),
        toNumber(invoice.paidAmount),
        remainingOf(invoice),
        t(`invoices.status.${statusOf(invoice)}`),
      ])
    }
    for (const expense of periodExpenses) {
      rows.push([t('expenses.title'), expense.date, expense.categoryName ?? '', expense.description ?? '', -toNumber(expense.amount), '', '', ''])
    }

    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n')

    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `iyora-report-${from}-${to}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')}>
        <Button variant="ghost" onClick={exportCsv}>
          {t('common.export')}
        </Button>
      </PageHeader>

      <div className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <Field label={t('common.from')} className="w-44">
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label={t('common.to')} className="w-44">
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
        <Button
          variant="ghost"
          onClick={() => {
            setFrom(monthStartISO())
            setTo(todayISO())
          }}
        >
          {t('common.reset')}
        </Button>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label={t('reports.revenue')}
          value={formatMoney(totals.revenue)}
          suffix={t('common.currency')}
          Icon={IconInvoices}
        />
        <StatCard
          label={t('reports.fees')}
          value={formatMoney(totals.fees)}
          suffix={t('common.currency')}
          tone="text-violet-600 bg-violet-50"
          Icon={IconTrendUp}
        />
        <StatCard
          label={t('reports.collected')}
          value={formatMoney(totals.collected)}
          suffix={t('common.currency')}
          tone="text-emerald-600 bg-emerald-50"
          Icon={IconTrendUp}
        />
        <StatCard
          label={t('reports.outstanding')}
          value={formatMoney(totals.outstanding)}
          suffix={t('common.currency')}
          tone="text-amber-600 bg-amber-50"
          Icon={IconReports}
        />
        <StatCard
          label={t('reports.expenses')}
          value={formatMoney(totals.expenses)}
          suffix={t('common.currency')}
          tone="text-rose-600 bg-rose-50"
          Icon={IconExpenses}
        />
        <StatCard
          label={t('reports.net')}
          value={formatMoney(totals.net)}
          suffix={t('common.currency')}
          tone="text-sky-600 bg-sky-50"
          Icon={IconTrendUp}
        />
      </div>

      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
              tab === item
                ? 'bg-brand-600 text-white shadow-sm'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t(`reports.${item}`)}
          </button>
        ))}
      </div>

      {tab === 'sales' && (
        <div className="space-y-5">
          <BreakdownTable title={t('reports.byService')} rows={byService} countLabel={t('common.qty')} />
          <BreakdownTable title={t('reports.byEmployee')} rows={byEmployee} countLabel={t('reports.count')} />
          <BreakdownTable title={t('reports.byClient')} rows={byClient} countLabel={t('reports.count')} />
        </div>
      )}

      {tab === 'receivables' && (
        <div className="space-y-5">
          <BalanceTable title={t('reports.receivables')} rows={debtors} tone="text-amber-600" />
          <BalanceTable title={t('reports.payables')} rows={creditors} tone="text-sky-600" />
        </div>
      )}

      {tab === 'ads' && <AdsTable rows={adsByClient} />}

      {tab === 'profitability' && (
        <ProfitabilityView invoices={periodInvoices} costs={jobCosts} clientMap={clientMap} />
      )}

      {tab === 'expenses' && (
        <BreakdownTable title={t('reports.byCategory')} rows={byCategory} countLabel={t('reports.count')} />
      )}

      {tab === 'profit' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr>
                  <Th>{t('invoices.number')}</Th>
                  <Th>{t('common.date')}</Th>
                  <Th>{t('common.client')}</Th>
                  <Th>{t('invoices.total')}</Th>
                  <Th>{t('invoices.paid')}</Th>
                  <Th>{t('common.status')}</Th>
                </tr>
              </thead>
              <tbody>
                {periodInvoices.length === 0 ? (
                  <tr>
                    <Td className="py-10 text-center text-slate-400" >
                      {t('reports.empty')}
                    </Td>
                  </tr>
                ) : (
                  periodInvoices.map((invoice) => {
                    const state = statusOf(invoice)
                    return (
                      <tr key={invoice.id}>
                        <Td>
                          <span className="num font-bold text-slate-800">{invoice.number}</span>
                        </Td>
                        <Td className="text-slate-600">{formatDate(invoice.date, locale)}</Td>
                        <Td className="text-slate-700">
                          {clientMap.get(invoice.clientId)?.name ?? invoice.clientName ?? '—'}
                        </Td>
                        <Td>
                          <span className="num font-semibold">{formatMoney(invoice.total)}</span>
                        </Td>
                        <Td>
                          <span className="num text-emerald-600">{formatMoney(invoice.paidAmount)}</span>
                        </Td>
                        <Td>
                          <Badge tone={statusTone(state)}>{t(`invoices.status.${state}`)}</Badge>
                        </Td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'payroll' && (
        <PayrollReportView periodInvoices={periodInvoices} jobCosts={jobCosts} from={from} to={to} />
      )}
    </div>
  )
}

function PayrollReportView({ periodInvoices, jobCosts, from, to }) {
  const { t, locale } = useI18n()
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: entries } = useCollection(COL.employeeEntries, 'date', 'desc')

  const employeePayrollRows = useMemo(() => {
    return employees.map((emp) => {
      const empEntries = entries.filter((e) => e.employeeId === emp.id && isWithin(e.date, from, to))
      const empCommissions = jobCosts.filter((c) => c.employeeId === emp.id && c.type === 'commission' && isWithin(c.date, from, to))
      const empJobPays = jobCosts.filter((c) => c.employeeId === emp.id && c.type !== 'commission' && isWithin(c.date, from, to))
      const empInvoices = periodInvoices.filter((inv) => inv.employeeId === emp.id && !inv.cancelled)

      const salesTotal = round2(empInvoices.reduce((sum, inv) => sum + invoiceFees(inv), 0))
      const tierCalc = calculateEmployeeTieredCommission(emp, salesTotal)

      let salary = 0
      let bonus = 0
      let raise = 0
      let deduction = 0
      let paid = 0

      for (const e of empEntries) {
        const amt = toNumber(e.amount)
        if (e.type === 'salary') salary += amt
        else if (e.type === 'bonus') bonus += amt
        else if (e.type === 'raise') raise += amt
        else if (e.type === 'deduction') deduction += amt

        if (e.paid) paid += (e.type === 'deduction' ? -amt : amt)
      }

      const commission = round2(empCommissions.reduce((sum, c) => sum + toNumber(c.amount), 0))
      const commissionPaid = round2(empCommissions.filter((c) => c.paid).reduce((sum, c) => sum + toNumber(c.amount), 0))

      const jobPay = round2(empJobPays.reduce((sum, c) => sum + toNumber(c.amount), 0))
      const jobPayPaid = round2(empJobPays.filter((c) => c.paid).reduce((sum, c) => sum + toNumber(c.amount), 0))

      const totalEntitlements = round2(salary + bonus + raise - deduction + commission + jobPay)
      const totalPaid = round2(paid + commissionPaid + jobPayPaid)
      const due = round2(totalEntitlements - totalPaid)

      return {
        id: emp.id,
        name: emp.name,
        role: emp.role || 'sales',
        baseSalary: emp.baseSalary,
        targetAmount: emp.targetAmount,
        commissionRate: emp.commissionRate,
        overTargetCommissionRate: emp.overTargetCommissionRate,
        overTargetEnabled: emp.overTargetCommissionEnabled,
        salesCount: empInvoices.length,
        salesTotal,
        tierCalc,
        salary,
        bonusTotal: bonus + raise,
        deduction,
        commission,
        jobPay,
        totalEntitlements,
        totalPaid,
        due,
      }
    })
  }, [employees, entries, jobCosts, periodInvoices, from, to])

  return (
    <div className="card overflow-hidden">
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div>
          <h3 className="font-bold text-slate-900 text-sm">تقرير المرتبات والعمولات الشامل للموظفين</h3>
          <p className="text-xs text-slate-500">حساب المستحقات والعمولات بالشرايح والخصومات والصافي عن الفترة من {formatDate(from, locale)} إلى {formatDate(to, locale)}</p>
        </div>
      </div>
      <TableWrap>
        <thead>
          <tr>
            <Th>الموظف</Th>
            <Th>المبيعات المحققة</Th>
            <Th>المرتب الأساسي</Th>
            <Th>عمولة التارجت</Th>
            <Th>عمولة ما فوق التارجت</Th>
            <Th>إجمالي العمولات</Th>
            <Th>بونص وزيادات</Th>
            <Th>خصومات وتأخيرات</Th>
            <Th>إجمالي المستحق</Th>
            <Th>المصروف له</Th>
            <Th>المتبقي المستحق</Th>
          </tr>
        </thead>
        <tbody>
          {employeePayrollRows.length === 0 ? (
            <tr>
              <Td colSpan={11} className="text-center py-8 text-slate-400">لا توجد بيانات موظفين</Td>
            </tr>
          ) : (
            employeePayrollRows.map((emp) => (
              <tr key={emp.id}>
                <Td>
                  <span className="font-bold text-slate-800">{emp.name}</span>
                  <span className="block text-xs text-slate-400">{emp.role}</span>
                </Td>
                <Td>
                  <span className="num font-semibold text-slate-700">{formatMoney(emp.salesTotal)}</span>
                  <span className="block text-xs text-slate-400">({emp.salesCount} فاتورة)</span>
                </Td>
                <Td><span className="num text-slate-700">{formatMoney(emp.baseSalary)}</span></Td>
                <Td><span className="num text-sky-700">{formatMoney(emp.tierCalc.baseCommission)}</span></Td>
                <Td><span className="num text-emerald-700">{formatMoney(emp.tierCalc.overCommission)}</span></Td>
                <Td><span className="num font-bold text-sky-800">{formatMoney(emp.commission)}</span></Td>
                <Td><span className="num text-emerald-600">{emp.bonusTotal ? formatMoney(emp.bonusTotal) : '—'}</span></Td>
                <Td><span className="num text-rose-600">{emp.deduction ? `−${formatMoney(emp.deduction)}` : '—'}</span></Td>
                <Td><span className="num font-extrabold text-slate-900">{formatMoney(emp.totalEntitlements)}</span></Td>
                <Td><span className="num font-semibold text-slate-700">{formatMoney(emp.totalPaid)}</span></Td>
                <Td>
                  <span className={`num font-bold ${emp.due > 0.01 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    {formatMoney(emp.due)}
                  </span>
                </Td>
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>
    </div>
  )
}

export function BreakdownTable({ title, rows, countLabel }) {
  const { t } = useI18n()
  const total = rows.reduce((sum, row) => sum + row.value, 0)

  return (
    <div>
      <h3 className="mb-2 text-sm font-bold text-slate-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.name')}</Th>
              <Th>{countLabel}</Th>
              <Th>{t('common.total')}</Th>
              <Th className="w-40">%</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const share = total > 0 ? Math.round((row.value / total) * 100) : 0
              return (
                <tr key={row.label}>
                  <Td className="font-semibold text-slate-800">{row.label}</Td>
                  <Td>
                    <span className="num text-slate-600">{row.count}</span>
                  </Td>
                  <Td>
                    <span className="num font-bold text-slate-800">{formatMoney(row.value)}</span>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-brand-500" style={{ width: `${share}%` }} />
                      </div>
                      <span className="num text-xs font-semibold text-slate-500">{share}%</span>
                    </div>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </TableWrap>
      )}
    </div>
  )
}

/** الربحية الحقيقية: الإيراد ناقص تكاليف الشغل المباشرة */
export function ProfitabilityView({ invoices, costs, clientMap }) {
  const { t } = useI18n()
  const [view, setView] = useState('client')
  const [basis, setBasis] = useState('actual')

  const rows = useMemo(() => {
    const expected = basis === 'expected'

    if (view === 'service') {
      return expected ? expectedProfitByService(invoices) : profitByService(invoices, costs)
    }
    if (view === 'invoice') {
      return invoices
        .map((invoice) => ({
          key: invoice.id,
          label: `${invoice.number} — ${invoice.clientName ?? ''}`,
          count: 1,
          ...(expected ? invoiceExpectedProfit(invoice) : invoiceProfit(invoice, costs)),
        }))
        .sort((a, b) => b.profit - a.profit)
    }

    const keyOf = (invoice) => invoice.clientId
    const labelOf = (invoice) => clientMap.get(invoice.clientId)?.name ?? invoice.clientName ?? '—'
    return expected
      ? expectedProfitBy(invoices, keyOf, labelOf)
      : profitBy(invoices, costs, keyOf, labelOf)
  }, [view, basis, invoices, costs, clientMap])

  const totals = rows.reduce(
    (sum, row) => ({ revenue: sum.revenue + row.revenue, cost: sum.cost + row.cost, profit: sum.profit + row.profit }),
    { revenue: 0, cost: 0, profit: 0 },
  )

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-900">{t('reports.profitability')}</h3>
        <div className="flex gap-2">
          {['client', 'service', 'invoice'].map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setView(item)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                view === item ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600'
              }`}
            >
              {t(`reports.by.${item}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex gap-2">
        {['actual', 'expected'].map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setBasis(item)}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              basis === item ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600'
            }`}
          >
            {t(`reports.basis.${item}`)}
          </button>
        ))}
      </div>

      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        {basis === 'expected' ? t('reports.expectedNote') : t('reports.profitabilityNote')}
      </p>

      {rows.length === 0 ? (
        <p className="card px-4 py-10 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.name')}</Th>
              <Th>{t('costs.revenue')}</Th>
              <Th>{t('costs.cost')}</Th>
              <Th>{t('costs.profit')}</Th>
              <Th>{t('costs.margin')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <Td className="font-semibold text-slate-800">{row.label}</Td>
                <Td>
                  <span className="num text-slate-700">{formatMoney(row.revenue)}</span>
                </Td>
                <Td>
                  <span className="num text-rose-600">{formatMoney(row.cost)}</span>
                </Td>
                <Td>
                  <span className={`num font-bold ${row.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {formatMoney(row.profit)}
                  </span>
                </Td>
                <Td>
                  <Badge tone={row.margin >= 40 ? 'green' : row.margin >= 15 ? 'amber' : 'red'}>{row.margin}%</Badge>
                </Td>
              </tr>
            ))}
            <tr className="bg-slate-50">
              <Td className="font-extrabold text-slate-900">{t('common.total')}</Td>
              <Td>
                <span className="num font-extrabold text-slate-900">{formatMoney(totals.revenue)}</span>
              </Td>
              <Td>
                <span className="num font-extrabold text-rose-600">{formatMoney(totals.cost)}</span>
              </Td>
              <Td>
                <span
                  className={`num font-extrabold ${totals.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}
                >
                  {formatMoney(totals.profit)}
                </span>
              </Td>
              <Td />
            </tr>
          </tbody>
        </TableWrap>
      )}
    </div>
  )
}

export function AdsTable({ rows }) {
  const { t } = useI18n()

  if (rows.length === 0) {
    return <p className="card px-4 py-10 text-center text-sm text-slate-400">{t('reports.empty')}</p>
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-bold text-slate-900">{t('reports.adsByClient')}</h3>
      <p className="mb-3 text-xs leading-relaxed text-slate-500">{t('reports.adsNote')}</p>

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('common.client')}</Th>
            <Th>{t('reports.adBudgetReceived')}</Th>
            <Th>{t('reports.adSpent')}</Th>
            <Th>{t('reports.adRemaining')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const remaining = row.budget - row.spent
            return (
              <tr key={row.id}>
                <Td className="font-semibold text-slate-800">{row.label}</Td>
                <Td>
                  <span className="num font-semibold text-amber-600">{formatMoney(row.budget)}</span>
                </Td>
                <Td>
                  <span className="num font-semibold text-rose-600">{formatMoney(row.spent)}</span>
                </Td>
                <Td>
                  <span className={`num font-bold ${remaining < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {formatMoney(remaining)}
                  </span>
                </Td>
              </tr>
            )
          })}
        </tbody>
      </TableWrap>
    </div>
  )
}

export function BalanceTable({ title, rows, tone }) {
  const { t } = useI18n()
  return (
    <div>
      <h3 className="mb-2 text-sm font-bold text-slate-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.client')}</Th>
              <Th>{t('common.phone')}</Th>
              <Th>{t('clients.totalInvoiced')}</Th>
              <Th>{t('clients.totalPaid')}</Th>
              <Th>{t('clients.balance')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((client) => (
              <tr key={client.id}>
                <Td className="font-semibold text-slate-800">{client.name}</Td>
                <Td>
                  <span className="num text-slate-600">{client.phone || '—'}</span>
                </Td>
                <Td>
                  <span className="num text-slate-700">{formatMoney(client.totalInvoiced)}</span>
                </Td>
                <Td>
                  <span className="num text-emerald-600">{formatMoney(client.totalPaid)}</span>
                </Td>
                <Td>
                  <span className={`num font-bold ${tone}`}>{formatMoney(Math.abs(client.balance))}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  )
}
