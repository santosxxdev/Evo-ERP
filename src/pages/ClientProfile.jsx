import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useAllPayments, useCollection, useLookup } from '../lib/db'
import { canSeeMoneyInternals } from '../lib/roles'
import { formatDate, formatMoney, toNumber } from '../lib/format'
import { isOverdue, remainingOf, statusOf, statusTone } from '../lib/invoice'
import { invoiceExpectedProfit, invoiceProfit, sumCosts } from '../lib/costing'
import { JOB_COSTS_COL } from './Vendors'
import ReceiptModal from '../components/ReceiptModal'
import {
  Badge,
  Button,
  EmptyState,
  Loading,
  PageHeader,
  StatCard,
  TableWrap,
  Td,
  Th,
} from '../components/ui'
import { IconClients, IconInvoices, IconTrendUp } from '../components/Icons'

import { JOURNAL_COL } from '../lib/journal'

const TABS = ['statement', 'invoices', 'profit', 'ads', 'info']

export default function ClientProfile() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { t, locale } = useI18n()
  const { role } = useAuth()

  const finance = canSeeMoneyInternals(role)

  const { rows: clients, loading } = useCollection(COL.clients, 'name', 'asc')
  const { rows: allInvoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: activityTypes } = useCollection(COL.activityTypes, 'name', 'asc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc', finance)
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc', finance)
  const { rows: payments } = useAllPayments()
  const { rows: allVouchers } = useCollection(JOURNAL_COL, 'date', 'desc')

  const [tab, setTab] = useState('statement')
  const [receiptOpen, setReceiptOpen] = useState(false)

  const employeeMap = useLookup(employees)
  const activityMap = useLookup(activityTypes)

  const client = clients.find((row) => row.id === id)
  const invoices = useMemo(
    () => allInvoices.filter((invoice) => invoice.clientId === id && !invoice.cancelled),
    [allInvoices, id],
  )
  const invoiceIds = useMemo(() => new Set(invoices.map((invoice) => invoice.id)), [invoices])

  const clientPayments = useMemo(
    () => payments.filter((payment) => invoiceIds.has(payment.invoiceId)),
    [payments, invoiceIds],
  )

  const clientVoucherLines = useMemo(() => {
    const result = []
    if (!client) return result

    for (const voucher of allVouchers) {
      for (const line of voucher.lines || []) {
        if (
          line.subLedgerId === id ||
          (line.subLedgerType === 'client' && line.subLedgerName && (line.subLedgerName === client.name || line.subLedgerName === client.businessName))
        ) {
          result.push({
            voucherId: voucher.id,
            number: voucher.number,
            type: voucher.type,
            description: voucher.description || (voucher.type === 'opening' ? 'رصيد افتتاحي' : 'قيد محاسبي'),
            date: voucher.date,
            debit: toNumber(line.debit),
            credit: toNumber(line.credit),
          })
        }
      }
    }
    return result
  }, [allVouchers, client, id])

  /* كشف حساب جارٍ: الرصيد الافتتاحي + الفواتير مدين + التحصيلات دائن + القيود */
  const statement = useMemo(() => {
    const numbers = new Map(invoices.map((invoice) => [invoice.id, invoice.number]))

    const rows = [
      ...clientVoucherLines.map((vLine, idx) => ({
        key: `vLine-${vLine.voucherId}-${idx}`,
        date: vLine.date,
        kind: vLine.type === 'opening' ? 'opening' : 'voucher',
        ref: vLine.number,
        voucherId: vLine.voucherId,
        note: vLine.description,
        debit: vLine.debit,
        credit: vLine.credit,
      })),
      ...invoices.map((invoice) => ({
        key: `inv-${invoice.id}`,
        date: invoice.date,
        kind: 'invoice',
        ref: invoice.number,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        note: (invoice.items ?? []).map((item) => item.name).join('، '),
        debit: toNumber(invoice.total),
        credit: 0,
      })),
      ...clientPayments.map((payment) => ({
        key: `pay-${payment.id}`,
        date: payment.date,
        kind: 'payment',
        ref: numbers.get(payment.invoiceId) ?? '',
        invoiceId: payment.invoiceId || null,
        invoiceNumber: numbers.get(payment.invoiceId) ?? '',
        paymentId: payment.id,
        note: payment.methodName || '',
        debit: 0,
        credit: toNumber(payment.amount),
      })),
    ].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))

    let running = 0
    return rows.map((row) => {
      running += row.debit - row.credit
      return { ...row, balance: running }
    })
  }, [invoices, clientPayments, clientVoucherLines])

  const totals = useMemo(() => {
    const invoiced = invoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0)
    const paid = invoices.reduce((sum, invoice) => sum + toNumber(invoice.paidAmount), 0)
    const voucherDebit = clientVoucherLines.reduce((sum, v) => sum + v.debit, 0)
    const voucherCredit = clientVoucherLines.reduce((sum, v) => sum + v.credit, 0)
    const voucherBalance = voucherDebit - voucherCredit

    const cost = sumCosts(jobCosts.filter((entry) => invoiceIds.has(entry.invoiceId)))
    const fees = invoices.reduce(
      (sum, invoice) => sum + toNumber(invoice.total) - toNumber(invoice.adBudgetTotal) - toNumber(invoice.taxAmount),
      0,
    )
    const adBudget = invoices.reduce((sum, invoice) => sum + toNumber(invoice.adBudgetTotal), 0)
    const adSpent = expenses
      .filter((expense) => expense.clientId === id)
      .reduce((sum, expense) => sum + toNumber(expense.amount), 0)

    return {
      invoiced,
      paid,
      voucherBalance,
      balance: voucherBalance + invoiced - paid,
      cost,
      fees,
      profit: fees - cost,
      adBudget,
      adSpent,
    }
  }, [invoices, jobCosts, invoiceIds, expenses, id, clientVoucherLines])

  if (loading) return <Loading />

  if (!client) {
    return (
      <div>
        <PageHeader title={t('clients.profile')} />
        <EmptyState
          title={t('clientProfile.notFound')}
          action={<Button onClick={() => navigate('/clients')}>{t('common.back')}</Button>}
        />
      </div>
    )
  }

  const visibleTabs = TABS.filter((item) => finance || (item !== 'profit' && item !== 'ads'))

  return (
    <div>
      <div className="no-print mb-4">
        <Link to="/clients" className="text-sm font-semibold text-brand-700 hover:underline">
          ← {t('nav.clients')}
        </Link>
      </div>

      <PageHeader title={client.name} subtitle={client.businessName || t('clients.profile')}>
        <div className="no-print flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => window.print()}>
            {t('common.print')}
          </Button>
          <Button variant="ghost" onClick={() => setReceiptOpen(true)}>
            {t('receipts.button')}
          </Button>
          <Button onClick={() => navigate('/invoices')}>+ {t('invoices.add')}</Button>
        </div>
      </PageHeader>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {client.activityTypeId && activityMap.get(client.activityTypeId) && (
          <Badge tone="brand">{activityMap.get(client.activityTypeId).name}</Badge>
        )}
        {client.phone && <span className="num text-sm font-semibold text-slate-600">{client.phone}</span>}
        {client.email && (
          <span className="text-sm text-slate-500" dir="ltr">
            {client.email}
          </span>
        )}
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('clients.totalInvoiced')}
          value={formatMoney(totals.invoiced)}
          suffix={t('common.currency')}
          Icon={IconInvoices}
        />
        <StatCard
          label={t('clients.totalPaid')}
          value={formatMoney(totals.paid)}
          suffix={t('common.currency')}
          tone="text-emerald-600 bg-emerald-50"
          Icon={IconTrendUp}
        />
        <StatCard
          label={`${t('clients.balance')}${
            Math.abs(totals.balance) > 0.01
              ? ` — ${t(totals.balance > 0 ? 'clientProfile.debtor' : 'clientProfile.creditor')}`
              : ''
          }`}
          value={formatMoney(Math.abs(totals.balance))}
          suffix={t('common.currency')}
          tone={totals.balance > 0 ? 'text-amber-600 bg-amber-50' : 'text-emerald-600 bg-emerald-50'}
          Icon={IconInvoices}
        />
        {finance ? (
          <StatCard
            label={t('costs.profit')}
            value={formatMoney(totals.profit)}
            suffix={t('common.currency')}
            tone={totals.profit >= 0 ? 'text-violet-600 bg-violet-50' : 'text-red-600 bg-red-50'}
            Icon={IconTrendUp}
          />
        ) : (
          <StatCard label={t('clients.invoices')} value={invoices.length} Icon={IconClients} />
        )}
      </div>

      <div className="no-print mb-5 flex gap-2 overflow-x-auto pb-1">
        {visibleTabs.map((item) => (
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
            {t(`clientProfile.tab.${item}`)}
          </button>
        ))}
      </div>

      {tab === 'statement' && (
        <Statement
          rows={statement}
          balance={totals.balance}
          compensations={expenses.filter(
            (expense) => expense.target?.kind === 'client' && expense.target.id === id,
          )}
          locale={locale}
        />
      )}
      {tab === 'invoices' && <InvoiceList invoices={invoices} locale={locale} />}
      {tab === 'profit' && finance && (
        <ProfitList invoices={invoices} costs={jobCosts} totals={totals} locale={locale} />
      )}
      {tab === 'ads' && finance && (
        <AdsPanel budget={totals.adBudget} spent={totals.adSpent} expenses={expenses.filter((e) => e.clientId === id)} locale={locale} />
      )}
      {tab === 'info' && <Info client={client} employeeMap={employeeMap} activityMap={activityMap} />}

      <ReceiptModal
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        clients={clients}
        invoices={allInvoices}
        methods={[]}
        presetClientId={id}
      />
    </div>
  )
}

function Statement({ rows, balance, compensations = [], locale }) {
  const { t } = useI18n()

  if (rows.length === 0 && compensations.length === 0) {
    return <EmptyState title={t('clients.noInvoices')} />
  }

  return (
    <div>
      {compensations.length > 0 && (
        <div className="mb-5">
          <h4 className="mb-2 text-sm font-bold text-slate-900">{t('clientProfile.compensations')}</h4>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                <Th>{t('common.description')}</Th>
                <Th>{t('common.amount')}</Th>
              </tr>
            </thead>
            <tbody>
              {compensations.map((expense) => (
                <tr key={expense.id}>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(expense.date, locale)}</Td>
                  <Td className="text-slate-700">{expense.description || expense.categoryName || '—'}</Td>
                  <Td>
                    <span className="num font-bold text-rose-600">{formatMoney(expense.amount)}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}
      <TableWrap>
        <thead>
          <tr>
            <Th>{t('common.date')}</Th>
            <Th>{t('acct.reference')}</Th>
            <Th>{t('common.description')}</Th>
            <Th>{t('clientProfile.charged')}</Th>
            <Th>{t('clientProfile.received')}</Th>
            <Th>{t('acct.balance')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
              <Td>
                <div className="inline-flex items-center gap-1.5 flex-wrap">
                  <Badge tone={row.kind === 'invoice' ? 'brand' : row.kind === 'opening' ? 'amber' : row.kind === 'payment' ? 'green' : 'slate'}>
                    {row.kind === 'invoice'
                      ? t('common.invoice')
                      : row.kind === 'opening'
                        ? 'رصيد افتتاحي'
                        : row.kind === 'payment'
                          ? t('acct.ref.payment')
                          : 'قيد محاسبي'}
                  </Badge>
                  {row.invoiceId ? (
                    <Link
                      to={`/invoices/${row.invoiceId}`}
                      className="num inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:text-brand-800 hover:underline dark:text-brand-400 group"
                      title="فتح صفحة الفاتورة"
                    >
                      <span>#{row.ref || row.invoiceNumber}</span>
                      <svg className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </Link>
                  ) : row.ref ? (
                    <span className="num text-xs font-bold text-slate-700">{row.ref}</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </div>
              </Td>
              <Td className="max-w-[280px] truncate text-slate-600">{row.note || '—'}</Td>
              <Td>
                {row.debit > 0 ? (
                  <span className="num font-bold text-slate-800">{formatMoney(row.debit)}</span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </Td>
              <Td>
                {row.credit > 0 ? (
                  <span className="num font-bold text-emerald-600">{formatMoney(row.credit)}</span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </Td>
              <Td>
                <span className={`num font-bold ${row.balance > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {formatMoney(row.balance)}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      <div className="mt-3 flex items-center justify-between rounded-2xl bg-slate-50 px-5 py-4">
        <span className="text-sm font-bold text-slate-700">
          {t('clientProfile.closingBalance')}
          {Math.abs(balance) > 0.01 && (
            <span className="ms-2">
              <Badge tone={balance > 0 ? 'amber' : 'sky'}>
                {t(balance > 0 ? 'clientProfile.debtor' : 'clientProfile.creditor')}
              </Badge>
            </span>
          )}
        </span>
        <span className={`num text-xl font-extrabold ${balance > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
          {formatMoney(Math.abs(balance))}
          <span className="ms-1 text-xs font-semibold text-slate-400">{t('common.currency')}</span>
        </span>
      </div>
    </div>
  )
}

function InvoiceList({ invoices, locale }) {
  const { t } = useI18n()
  const today = new Date().toISOString().slice(0, 10)

  if (invoices.length === 0) return <EmptyState title={t('clients.noInvoices')} />

  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>{t('invoices.number')}</Th>
          <Th>{t('common.date')}</Th>
          <Th>{t('invoices.total')}</Th>
          <Th>{t('invoices.paid')}</Th>
          <Th>{t('invoices.remaining')}</Th>
          <Th>{t('common.status')}</Th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((invoice) => {
          const state = statusOf(invoice)
          return (
            <tr key={invoice.id}>
              <Td>
                <Link
                  to={`/invoices/${invoice.id}`}
                  className="num font-bold text-brand-600 hover:text-brand-800 hover:underline inline-flex items-center gap-1 dark:text-brand-400 group"
                  title="فتح صفحة الفاتورة"
                >
                  <span>#{invoice.number}</span>
                  <svg className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </Link>
              </Td>
              <Td className="whitespace-nowrap text-slate-600">{formatDate(invoice.date, locale)}</Td>
              <Td>
                <span className="num text-slate-700">{formatMoney(invoice.total)}</span>
              </Td>
              <Td>
                <span className="num text-emerald-600">{formatMoney(invoice.paidAmount)}</span>
              </Td>
              <Td>
                <span className="num font-bold text-amber-600">{formatMoney(remainingOf(invoice))}</span>
              </Td>
              <Td>
                <Badge tone={statusTone(state)}>{t(`invoices.status.${state}`)}</Badge>
                {isOverdue(invoice, today) && (
                  <span className="ms-1.5">
                    <Badge tone="red">{t('invoices.overdue')}</Badge>
                  </span>
                )}
              </Td>
            </tr>
          )
        })}
      </tbody>
    </TableWrap>
  )
}

function ProfitList({ invoices, costs, totals, locale }) {
  const { t } = useI18n()
  const [basis, setBasis] = useState('actual')

  if (invoices.length === 0) return <EmptyState title={t('clients.noInvoices')} />

  const expected = basis === 'expected'
  const totalCost = expected
    ? invoices.reduce((sum, invoice) => sum + toNumber(invoice.expectedCost), 0)
    : totals.cost
  const totalProfit = totals.fees - totalCost

  return (
    <div>
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
        {expected ? t('reports.expectedNote') : t('reports.profitabilityNote')}
      </p>

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('invoices.number')}</Th>
            <Th>{t('common.date')}</Th>
            <Th>{t('costs.revenue')}</Th>
            <Th>{t('costs.cost')}</Th>
            <Th>{t('costs.profit')}</Th>
            <Th>{t('costs.margin')}</Th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => {
            const profit = expected ? invoiceExpectedProfit(invoice) : invoiceProfit(invoice, costs)
            return (
              <tr key={invoice.id}>
                <Td>
                  <Link
                    to={`/invoices/${invoice.id}`}
                    className="num font-bold text-brand-600 hover:text-brand-800 hover:underline inline-flex items-center gap-1 dark:text-brand-400 group"
                    title="فتح صفحة الفاتورة"
                  >
                    <span>#{invoice.number}</span>
                    <svg className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </Link>
                </Td>
                <Td className="whitespace-nowrap text-slate-600">{formatDate(invoice.date, locale)}</Td>
                <Td>
                  <span className="num text-slate-700">{formatMoney(profit.revenue)}</span>
                </Td>
                <Td>
                  <span className="num text-rose-600">{formatMoney(profit.cost)}</span>
                </Td>
                <Td>
                  <span className={`num font-bold ${profit.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {formatMoney(profit.profit)}
                  </span>
                </Td>
                <Td>
                  <Badge tone={profit.margin >= 40 ? 'green' : profit.margin >= 15 ? 'amber' : 'red'}>
                    {profit.margin}%
                  </Badge>
                </Td>
              </tr>
            )
          })}
          <tr className="bg-slate-50">
            <Td className="font-extrabold text-slate-900" />
            <Td className="font-extrabold text-slate-900">{t('common.total')}</Td>
            <Td>
              <span className="num font-extrabold text-slate-900">{formatMoney(totals.fees)}</span>
            </Td>
            <Td>
              <span className="num font-extrabold text-rose-600">{formatMoney(totalCost)}</span>
            </Td>
            <Td>
              <span className={`num font-extrabold ${totalProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {formatMoney(totalProfit)}
              </span>
            </Td>
            <Td />
          </tr>
        </tbody>
      </TableWrap>
    </div>
  )
}

function AdsPanel({ budget, spent, expenses, locale }) {
  const { t } = useI18n()
  const remaining = budget - spent

  return (
    <div>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('reports.adBudgetReceived')}
          value={formatMoney(budget)}
          suffix={t('common.currency')}
          tone="text-amber-600 bg-amber-50"
        />
        <StatCard
          label={t('reports.adSpent')}
          value={formatMoney(spent)}
          suffix={t('common.currency')}
          tone="text-rose-600 bg-rose-50"
        />
        <StatCard
          label={t('reports.adRemaining')}
          value={formatMoney(remaining)}
          suffix={t('common.currency')}
          tone={remaining >= 0 ? 'text-emerald-600 bg-emerald-50' : 'text-red-600 bg-red-50'}
        />
      </div>

      {expenses.length === 0 ? (
        <p className="card px-4 py-10 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.date')}</Th>
              <Th>{t('common.description')}</Th>
              <Th>{t('common.amount')}</Th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => (
              <tr key={expense.id}>
                <Td className="whitespace-nowrap text-slate-600">{formatDate(expense.date, locale)}</Td>
                <Td className="text-slate-700">{expense.description}</Td>
                <Td>
                  <span className="num font-bold text-rose-600">{formatMoney(expense.amount)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  )
}

function Info({ client, employeeMap, activityMap }) {
  const { t } = useI18n()

  const fields = [
    { label: t('clients.name'), value: client.name },
    { label: t('clients.businessName'), value: client.businessName },
    { label: t('clients.activityType'), value: activityMap.get(client.activityTypeId)?.name },
    { label: t('common.phone'), value: client.phone, ltr: true },
    { label: t('common.email'), value: client.email, ltr: true },
    { label: t('common.address'), value: client.address },
    { label: t('clients.mainEmployee'), value: employeeMap.get(client.employeeId)?.name },
    { label: t('clients.secondEmployee'), value: employeeMap.get(client.secondEmployeeId)?.name },
    { label: t('common.notes'), value: client.notes },
  ]

  return (
    <div className="card divide-y divide-slate-100">
      {fields.map((field) => (
        <div key={field.label} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <span className="text-sm font-semibold text-slate-500">{field.label}</span>
          <span className={`text-sm font-semibold text-slate-800 ${field.ltr ? 'num' : ''}`}>
            {field.value || '—'}
          </span>
        </div>
      ))}
    </div>
  )
}
