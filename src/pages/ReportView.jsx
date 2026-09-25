import { useMemo, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useI18n } from '../i18n'
import { COL, useCollection, useLookup } from '../lib/db'
import { useAccountingData, periodStatements } from '../lib/useAccounting'
import { byRole } from '../lib/accounts'
import { cashFlow } from '../lib/ledger'
import { formatDate, formatMoney, isWithin, monthStartISO, round2, todayISO, toNumber } from '../lib/format'
import { isClientFunded, remainingOf, statusOf, statusTone } from '../lib/invoice'
import { invoiceFees } from '../lib/costing'
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
import {
  BalanceSheet,
  CashFlowStatement,
  IncomeStatement,
  LedgerView,
  TaxReturn,
  TrialBalance,
} from './Accounting'
import { AdsTable, BalanceTable, BreakdownTable, ProfitabilityView } from './Reports'

import PrintDocument from '../components/PrintDocument'
import ReportPrintHeader from '../components/ReportPrintHeader'

/* id في الرابط ← مفتاح العنوان + نوع البيانات المطلوبة */
const REPORTS = {
  'trial-balance': { titleKey: 'nav.rep.trial', kind: 'finance' },
  'general-ledger': { titleKey: 'nav.rep.ledger', kind: 'finance' },
  'income-statement': { titleKey: 'nav.rep.income', kind: 'finance' },
  'balance-sheet': { titleKey: 'nav.rep.balance', kind: 'finance' },
  'cash-flow': { titleKey: 'nav.rep.cashflow', kind: 'finance' },
  'tax-return': { titleKey: 'nav.rep.tax', kind: 'finance' },
  'expenses-detail': { titleKey: 'nav.rep.expensesDetail', kind: 'expenses' },
  'revenue-detail': { titleKey: 'nav.rep.revenueDetail', kind: 'sales' },
  'sales-report': { titleKey: 'nav.rep.salesReport', kind: 'sales' },
  'invoice-profit': { titleKey: 'nav.rep.invoiceProfit', kind: 'sales' },
  'invoices-report': { titleKey: 'nav.rep.invoicesReport', kind: 'sales' },
  'ad-budget': { titleKey: 'nav.rep.ads', kind: 'ads' },
  receivables: { titleKey: 'nav.rep.receivables', kind: 'clients' },
}

export default function ReportView() {
  const { id } = useParams()
  const { t } = useI18n()
  const meta = REPORTS[id]

  const [from, setFrom] = useState(monthStartISO())
  const [to, setTo] = useState(todayISO())

  if (!meta) return <Navigate to="/reports/sales-report" replace />

  function handlePrint() {
    window.print()
  }

  const reportTitle = t(meta.titleKey)

  return (
    <div>
      <PageHeader title={reportTitle} subtitle={t('reports.subtitle')}>
        <Button onClick={handlePrint}>
          {t('acct.printStatement')} / PDF
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
        {meta.kind === 'finance' && (
          <Button
            variant="ghost"
            onClick={() => {
              setFrom('')
              setTo(todayISO())
            }}
          >
            {t('acct.allTime')}
          </Button>
        )}
      </div>

      {meta.kind === 'finance' && <FinanceReport id={id} from={from} to={to} />}
      {meta.kind === 'expenses' && <ExpensesDetailReport from={from} to={to} />}
      {meta.kind === 'sales' && <SalesReport id={id} from={from} to={to} />}
      {meta.kind === 'ads' && <AdBudgetReport from={from} to={to} />}
      {meta.kind === 'clients' && <ReceivablesReport />}

      {/* منطقة المستند المخصص للطباعة النظيفة وتصدير PDF */}
      <PrintDocument>
        <div className="space-y-4 p-4">
          <ReportPrintHeader title={reportTitle} subtitle={t('reports.subtitle')} from={from} to={to} />
          {meta.kind === 'finance' && <FinanceReport id={id} from={from} to={to} />}
          {meta.kind === 'expenses' && <ExpensesDetailReport from={from} to={to} />}
          {meta.kind === 'sales' && <SalesReport id={id} from={from} to={to} />}
          {meta.kind === 'ads' && <AdBudgetReport from={from} to={to} />}
          {meta.kind === 'clients' && <ReceivablesReport />}
        </div>
      </PrintDocument>
    </div>
  )
}

/* ================================================================ */
/*  ميزانية الإعلانات لكل عميل                                          */
/* ================================================================ */

function AdBudgetReport({ from, to }) {
  const { rows: invoices, loading } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: categories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const clientMap = useLookup(clients)
  const categoryMap = useLookup(categories)

  const rows = useMemo(() => {
    const map = new Map()
    const ensure = (cid, name) => map.get(cid) ?? { id: cid, label: name, budget: 0, spent: 0 }

    for (const invoice of invoices) {
      if (!isWithin(invoice.date, from, to) || invoice.cancelled) continue
      const budget = toNumber(invoice.adBudgetTotal)
      if (budget <= 0 || !invoice.clientId) continue
      const entry = ensure(invoice.clientId, clientMap.get(invoice.clientId)?.name ?? invoice.clientName ?? '—')
      entry.budget += budget
      map.set(invoice.clientId, entry)
    }
    for (const expense of expenses) {
      if (!isWithin(expense.date, from, to)) continue
      if (!isClientFunded(expense, categoryMap)) continue
      const entry = ensure(expense.clientId, clientMap.get(expense.clientId)?.name ?? '—')
      entry.spent += toNumber(expense.amount)
      map.set(expense.clientId, entry)
    }
    return [...map.values()].sort((a, b) => b.budget - a.budget)
  }, [invoices, expenses, from, to, clientMap, categoryMap])

  if (loading) return <Loading />

  return <AdsTable rows={rows} />
}

/* ================================================================ */
/*  المدين والدائن — أعمار الأرصدة                                      */
/* ================================================================ */

function ReceivablesReport() {
  const { t } = useI18n()
  const { rows: clients, loading } = useCollection(COL.clients, 'name', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')

  /* الرصيد يُحسب لحظيًا من فواتير العميل غير الملغاة — لا يعتمد على
     الرقم المخزَّن على كارت العميل حتى لو لم تُعَد حسبته بعد */
  const rows = useMemo(() => {
    const map = new Map()
    for (const invoice of invoices) {
      if (invoice.cancelled || !invoice.clientId) continue
      const entry = map.get(invoice.clientId) ?? {
        id: invoice.clientId,
        name: clients.find((c) => c.id === invoice.clientId)?.name ?? invoice.clientName ?? '—',
        phone: clients.find((c) => c.id === invoice.clientId)?.phone ?? '',
        totalInvoiced: 0,
        totalPaid: 0,
      }
      entry.totalInvoiced += toNumber(invoice.total)
      entry.totalPaid += toNumber(invoice.paidAmount)
      map.set(invoice.clientId, entry)
    }
    return [...map.values()].map((entry) => ({ ...entry, balance: round2(entry.totalInvoiced - entry.totalPaid) }))
  }, [invoices, clients])

  const debtors = rows.filter((r) => r.balance > 0.01).sort((a, b) => b.balance - a.balance)
  const creditors = rows.filter((r) => r.balance < -0.01).sort((a, b) => a.balance - b.balance)

  const totalDue = round2(debtors.reduce((sum, r) => sum + r.balance, 0))
  const totalCredit = round2(creditors.reduce((sum, r) => sum + Math.abs(r.balance), 0))

  if (loading) return <Loading />

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label={t('reports.receivables')} value={formatMoney(totalDue)} suffix={t('common.currency')} tone="text-amber-600 bg-amber-50" />
        <StatCard label={t('reports.payables')} value={formatMoney(totalCredit)} suffix={t('common.currency')} tone="text-sky-600 bg-sky-50" />
      </div>
      <BalanceTable title={t('reports.receivables')} rows={debtors} tone="text-amber-600" />
      <BalanceTable title={t('reports.payables')} rows={creditors} tone="text-sky-600" />
    </div>
  )
}

/* ================================================================ */
/*  التقارير المالية — تُبنى من دفتر اليومية المشتق                     */
/* ================================================================ */

function FinanceReport({ id, from, to }) {
  const { t, lang, locale } = useI18n()
  const { accounts, invoices, journal, loading } = useAccountingData()

  const stmt = useMemo(
    () => periodStatements(journal, accounts, from, to),
    [journal, accounts, from, to],
  )

  if (loading) return <Loading />
  if (accounts.length === 0) {
    return <p className="card px-4 py-12 text-center text-sm text-slate-400">{t('acct.emptyTree')}</p>
  }

  if (id === 'trial-balance') return <TrialBalance balances={stmt.balances} lang={lang} />
  if (id === 'general-ledger') {
    return <LedgerView journal={stmt.periodJournal} accounts={accounts} lang={lang} locale={locale} invoices={invoices} />
  }
  if (id === 'income-statement') {
    return (
      <IncomeStatement
        balances={stmt.balances}
        lang={lang}
        revenue={stmt.revenue}
        expenses={stmt.expenses}
        profit={stmt.profit}
      />
    )
  }
  if (id === 'balance-sheet') {
    return <BalanceSheet balances={stmt.balances} lang={lang} profit={stmt.profit} />
  }
  if (id === 'cash-flow') {
    return <CashFlowStatement flow={cashFlow(stmt.periodJournal, accounts)} locale={locale} />
  }
  if (id === 'tax-return') {
    const taxAcc = byRole(accounts, 'tax')
    return (
      <TaxReturn
        invoices={invoices.filter((invoice) => isWithin(invoice.date, from, to) && !invoice.cancelled)}
        taxAccount={taxAcc ? stmt.balances.find((row) => row.account.id === taxAcc.id) ?? null : null}
      />
    )
  }
  return null
}

/* ================================================================ */
/*  تقرير مفصّل المصروفات                                               */
/* ================================================================ */

function ExpensesDetailReport({ from, to }) {
  const { t, locale } = useI18n()
  const { rows: expenses, loading } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: categories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const categoryMap = useLookup(categories)

  const rows = useMemo(
    () =>
      expenses
        .filter((expense) => isWithin(expense.date, from, to))
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [expenses, from, to],
  )

  const byCategory = useMemo(() => {
    const map = new Map()
    for (const expense of rows) {
      const key = expense.categoryId || expense.categoryName || '—'
      const label = categoryMap.get(expense.categoryId)?.name ?? expense.categoryName ?? '—'
      const entry = map.get(key) ?? { label, value: 0, count: 0 }
      entry.value += toNumber(expense.amount)
      entry.count += 1
      map.set(key, entry)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }, [rows, categoryMap])

  const total = rows.reduce((sum, expense) => sum + toNumber(expense.amount), 0)

  if (loading) return <Loading />

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label={t('expenses.totalFiltered')} value={formatMoney(total)} suffix={t('common.currency')} tone="text-rose-600 bg-rose-50" />
        <StatCard label={t('reports.count')} value={rows.length} />
      </div>

      <BreakdownTable title={t('reports.byCategory')} rows={byCategory} countLabel={t('reports.count')} />

      <div>
        <h3 className="mb-2 text-sm font-bold text-slate-900">{t('reports.expenses')}</h3>
        {rows.length === 0 ? (
          <p className="card px-4 py-10 text-center text-sm text-slate-400">{t('reports.empty')}</p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                <Th>{t('expenses.category')}</Th>
                <Th>{t('expenses.reason')}</Th>
                <Th>{t('expenses.target')}</Th>
                <Th>{t('common.amount')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((expense) => (
                <tr key={expense.id}>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(expense.date, locale)}</Td>
                  <Td>
                    <Badge tone="brand">{categoryMap.get(expense.categoryId)?.name ?? expense.categoryName ?? '—'}</Badge>
                  </Td>
                  <Td className="text-slate-700">{expense.description || '—'}</Td>
                  <Td className="text-slate-600">{expense.target?.name || expense.paidBy || '—'}</Td>
                  <Td>
                    <span className="num font-bold text-rose-600">{formatMoney(expense.amount)}</span>
                  </Td>
                </tr>
              ))}
              <tr className="bg-slate-50">
                <Td colSpan={4} className="font-extrabold text-slate-900">{t('common.total')}</Td>
                <Td>
                  <span className="num font-extrabold text-rose-600">{formatMoney(total)}</span>
                </Td>
              </tr>
            </tbody>
          </TableWrap>
        )}
      </div>
    </div>
  )
}

/* ================================================================ */
/*  تقارير المبيعات                                                     */
/* ================================================================ */

function SalesReport({ id, from, to }) {
  const { t, locale } = useI18n()
  const { rows: invoices, loading } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: jobCosts } = useCollection('jobCosts', 'date', 'desc')
  const clientMap = useLookup(clients)

  const periodInvoices = useMemo(
    () => invoices.filter((invoice) => isWithin(invoice.date, from, to) && !invoice.cancelled),
    [invoices, from, to],
  )

  if (loading) return <Loading />

  /* تقرير المبيعات + تقرير مفصّل الإيرادات: نفس التبويب — تفصيل حسب الخدمة والموظف والعميل */
  if (id === 'sales-report' || id === 'revenue-detail') {
    return <SalesBreakdown invoices={periodInvoices} clientMap={clientMap} />
  }

  /* تقرير أرباح الفواتير */
  if (id === 'invoice-profit') {
    return <ProfitabilityView invoices={periodInvoices} costs={jobCosts} clientMap={clientMap} />
  }

  /* تقرير الفواتير */
  return <InvoicesReport invoices={periodInvoices} clientMap={clientMap} locale={locale} />
}

function SalesBreakdown({ invoices, clientMap }) {
  const { t } = useI18n()

  const byService = useMemo(() => {
    const map = new Map()
    for (const invoice of invoices) {
      for (const item of invoice.items ?? []) {
        if (item.isAdBudget) continue
        const key = item.name || '—'
        const entry = map.get(key) ?? { label: key, value: 0, count: 0 }
        entry.value += toNumber(item.total)
        entry.count += toNumber(item.qty)
        map.set(key, entry)
      }
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }, [invoices])

  const group = (keyOf, labelOf) => {
    const map = new Map()
    for (const invoice of invoices) {
      const key = keyOf(invoice)
      if (!key) continue
      const entry = map.get(key) ?? { label: labelOf(invoice), value: 0, count: 0 }
      entry.value += invoiceFees(invoice)
      entry.count += 1
      map.set(key, entry)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }

  const byEmployee = useMemo(
    () => group((i) => i.employeeId, (i) => i.employeeName || '—'),
    [invoices],
  )
  const byClient = useMemo(
    () => group((i) => i.clientId, (i) => clientMap.get(i.clientId)?.name ?? i.clientName ?? '—'),
    [invoices, clientMap],
  )

  const revenue = invoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0)
  const fees = invoices.reduce((sum, invoice) => sum + invoiceFees(invoice), 0)

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t('reports.revenue')} value={formatMoney(revenue)} suffix={t('common.currency')} />
        <StatCard label={t('reports.fees')} value={formatMoney(fees)} suffix={t('common.currency')} tone="text-violet-600 bg-violet-50" />
        <StatCard label={t('reports.count')} value={invoices.length} />
      </div>
      <BreakdownTable title={t('reports.byService')} rows={byService} countLabel={t('common.qty')} />
      <BreakdownTable title={t('reports.byEmployee')} rows={byEmployee} countLabel={t('reports.count')} />
      <BreakdownTable title={t('reports.byClient')} rows={byClient} countLabel={t('reports.count')} />
    </div>
  )
}

function InvoicesReport({ invoices, clientMap, locale }) {
  const { t } = useI18n()

  const rows = [...invoices].sort((a, b) => String(b.date).localeCompare(String(a.date)))
  const total = rows.reduce((sum, invoice) => sum + toNumber(invoice.total), 0)
  const paid = rows.reduce((sum, invoice) => sum + toNumber(invoice.paidAmount), 0)

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t('reports.revenue')} value={formatMoney(total)} suffix={t('common.currency')} />
        <StatCard label={t('reports.collected')} value={formatMoney(paid)} suffix={t('common.currency')} tone="text-emerald-600 bg-emerald-50" />
        <StatCard label={t('reports.outstanding')} value={formatMoney(total - paid)} suffix={t('common.currency')} tone="text-amber-600 bg-amber-50" />
      </div>

      {rows.length === 0 ? (
        <p className="card px-4 py-10 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('invoices.number')}</Th>
              <Th>{t('common.date')}</Th>
              <Th>{t('common.client')}</Th>
              <Th>{t('common.employee')}</Th>
              <Th>{t('invoices.total')}</Th>
              <Th>{t('invoices.paid')}</Th>
              <Th>{t('invoices.remaining')}</Th>
              <Th>{t('common.status')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((invoice) => {
              const state = statusOf(invoice)
              return (
                <tr key={invoice.id}>
                  <Td><span className="num font-bold text-slate-800">{invoice.number}</span></Td>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(invoice.date, locale)}</Td>
                  <Td className="text-slate-700">{clientMap.get(invoice.clientId)?.name ?? invoice.clientName ?? '—'}</Td>
                  <Td className="text-slate-600">{invoice.employeeName || '—'}</Td>
                  <Td><span className="num font-semibold text-slate-800">{formatMoney(invoice.total)}</span></Td>
                  <Td><span className="num text-emerald-600">{formatMoney(invoice.paidAmount)}</span></Td>
                  <Td><span className="num text-amber-600">{formatMoney(remainingOf(invoice))}</span></Td>
                  <Td><Badge tone={statusTone(state)}>{t(`invoices.status.${state}`)}</Badge></Td>
                </tr>
              )
            })}
            <tr className="bg-slate-50">
              <Td colSpan={4} className="font-extrabold text-slate-900">{t('common.total')}</Td>
              <Td><span className="num font-extrabold text-slate-900">{formatMoney(total)}</span></Td>
              <Td><span className="num font-extrabold text-emerald-600">{formatMoney(paid)}</span></Td>
              <Td><span className="num font-extrabold text-amber-600">{formatMoney(total - paid)}</span></Td>
              <Td />
            </tr>
          </tbody>
        </TableWrap>
      )}
    </div>
  )
}
