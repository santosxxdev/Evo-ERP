import { useEffect, useMemo, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useI18n } from '../i18n'
import {
  COL,
  createDoc,
  deleteDocById,
  updateDocById,
  useAllPayments,
  useCollection,
  useSettings,
} from '../lib/db'
import {
  ACCOUNTS_COL,
  ACCOUNT_TYPES,
  accountLabel,
  buildTree,
  flattenTree,
  getNormalBalance,
  accountsMissingRole,
  missingDefaults,
  nextChildCode,
  seedAccounts,
  seedMissingAccounts,
  cleanupDuplicateAccounts,
} from '../lib/accounts'
import { JOB_COSTS_COL, VENDORS_COL } from './Vendors'
import { JOURNAL_COL } from '../lib/journal'
import { ASSETS_COL, ASSET_USAGE_COL, MAINTENANCE_COL } from '../lib/assets'
import { accountBalances, accountMovements, buildJournal } from '../lib/ledger'
import { formatDate, formatMoney, isWithin, monthStartISO, round2, todayISO, toNumber } from '../lib/format'
import SearchableSelect from '../components/SearchableSelect'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  StatCard,
  Td,
  TableWrap,
  Th,
} from '../components/ui'
import {
  IconChevronDown,
  IconExport,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconImport,
  IconPencil,
  IconTrash,
} from '../components/Icons'
import PrintDocument from '../components/PrintDocument'
import ReportPrintHeader from '../components/ReportPrintHeader'

const VIEWS = ['tree', 'journal']

const TYPE_TONES = {
  asset: 'sky',
  liability: 'amber',
  equity: 'brand',
  revenue: 'green',
  expense: 'red',
}

const TYPE_BORDER = {
  asset: 'border-sky-400',
  liability: 'border-amber-400',
  equity: 'border-brand-400',
  revenue: 'border-emerald-400',
  expense: 'border-red-400',
}

export default function Accounting() {
  const { t, lang, locale } = useI18n()

  const { settings } = useSettings()
  const { rows: accounts, loading: loadingAccounts, error: errorAccounts } = useCollection(ACCOUNTS_COL, 'code', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: expenseCategories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const { rows: paymentMethods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const { rows: payments } = useAllPayments()
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: vendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: vouchers } = useCollection(JOURNAL_COL, 'date', 'desc')
  const { rows: assets } = useCollection(ASSETS_COL, 'name', 'asc')
  const { rows: maintenance } = useCollection(MAINTENANCE_COL, 'date', 'desc')
  const { rows: assetUsage } = useCollection(ASSET_USAGE_COL, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')

  useEffect(() => {
    console.log('[Accounting Diagnostic Logs]:', {
      accountsCount: accounts.length,
      loadingAccounts,
      errorAccounts,
      invoicesCount: invoices.length,
      expensesCount: expenses.length,
      paymentsCount: payments.length,
    })
  }, [accounts, loadingAccounts, errorAccounts, invoices, expenses, payments])

  const { view } = useParams()
  const isJournal = view === 'journal'
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayISO())
  const [seeding, setSeeding] = useState(false)
  const [jq, setJq] = useState('')

  const [showFullReportModal, setShowFullReportModal] = useState(false)

  /* أرقام الفواتير للدفعات، لتظهر في القيود */
  const enrichedPayments = useMemo(() => {
    const numbers = new Map(invoices.map((invoice) => [invoice.id, invoice.number]))
    return payments.map((payment) => ({ ...payment, invoiceNumber: numbers.get(payment.invoiceId) ?? '' }))
  }, [payments, invoices])

  const journal = useMemo(
    () =>
      buildJournal({
        invoices,
        payments: enrichedPayments,
        expenses,
        accounts,
        expenseCategories,
        paymentMethods,
        jobCosts,
        vendors,
        vouchers,
        assets,
        maintenance,
        assetUsage,
        settings,
      }),
    [invoices, enrichedPayments, expenses, accounts, expenseCategories, paymentMethods, jobCosts, vendors, vouchers, assets, maintenance, assetUsage, settings],
  )

  const periodJournal = useMemo(
    () => journal.filter((entry) => isWithin(entry.date, from, to)),
    [journal, from, to],
  )

  /* بحث في دفتر اليومية: المرجع، الوصف، أو اسم أي حساب داخل بنود القيد */
  const journalTerm = jq.trim().toLowerCase()
  const filteredJournal = useMemo(() => {
    if (!journalTerm) return periodJournal
    return periodJournal.filter((entry) =>
      [entry.ref, entry.description, t(`acct.ref.${entry.refType}`), ...entry.lines.map((line) => accountLabel(line.account, lang))]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(journalTerm),
    )
  }, [periodJournal, journalTerm, t, lang])

  const journalTotals = useMemo(() => {
    const debit = filteredJournal.reduce((sum, entry) => sum + entry.lines.reduce((s, l) => s + toNumber(l.debit), 0), 0)
    const credit = filteredJournal.reduce((sum, entry) => sum + entry.lines.reduce((s, l) => s + toNumber(l.credit), 0), 0)
    return { debit: round2(debit), credit: round2(credit), balanced: Math.abs(debit - credit) < 0.01 }
  }, [filteredJournal])

  const cleanAccounts = useMemo(
    () => buildCleanAccounts(accounts, clients, employees, vendors),
    [accounts, clients, employees, vendors],
  )

  const balances = useMemo(() => accountBalances(journal, cleanAccounts), [journal, cleanAccounts])

  /* حسابات ناقصة أو ينقصها دور — الاثنان يمنعان ترحيل القيود */
  const missing = useMemo(
    () => [...missingDefaults(accounts), ...accountsMissingRole(accounts)],
    [accounts],
  )

  async function handleSeed() {
    setSeeding(true)
    await seedAccounts()
    setSeeding(false)
  }

  /* يستكمل حسابات النظام التي أُضيفت بعد زرع الشجرة */
  async function handleRepair() {
    setSeeding(true)
    await seedMissingAccounts(accounts)
    setSeeding(false)
  }

  if (view && !VIEWS.includes(view)) return <Navigate to="/accounting/tree" replace />

  const pageTitle = isJournal ? t('acct.tab.journal') : t('acct.tab.tree')

  if (loadingAccounts && accounts.length === 0) return <Loading />

  if (accounts.length === 0) {
    return (
      <div>
        <PageHeader title={pageTitle} subtitle={t('acct.subtitle')} />
        <EmptyState
          title={t('acct.emptyTree')}
          message={t('acct.emptyTreeHint')}
          action={
            <Button onClick={handleSeed} disabled={seeding}>
              {seeding ? t('common.saving') : t('acct.seed')}
            </Button>
          }
        />
      </div>
    )
  }

  function handlePagePrint() {
    setShowFullReportModal(true)
  }

  return (
    <div>
      <PageHeader title={pageTitle} subtitle={t('acct.subtitle')}>
        <Button onClick={handlePagePrint}>
          <IconFileText className="h-4 w-4 me-1.5 shrink-0 inline" />
          {t('acct.printStatement')}
        </Button>
      </PageHeader>

      {missing.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div>
            <p className="text-sm font-bold text-amber-900">{t('acct.missingTitle', { count: missing.length })}</p>
            <p className="mt-1 text-xs leading-relaxed text-amber-800">{t('acct.missingHint')}</p>
          </div>
          <Button onClick={handleRepair} disabled={seeding}>
            {seeding ? t('common.saving') : t('acct.repair')}
          </Button>
        </div>
      )}

      {isJournal && (
        <>
          <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
            <Field label={t('common.from')} className="w-40">
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field label={t('common.to')} className="w-40">
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
            <div className="flex overflow-hidden rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => {
                  setFrom('')
                  setTo(todayISO())
                }}
                className="border-e border-slate-200 px-3.5 py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                {t('acct.allTime')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setFrom(monthStartISO())
                  setTo(todayISO())
                }}
                className="px-3.5 py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                {t('acct.thisMonth')}
              </button>
            </div>
            <div className="ms-auto min-w-[220px]">
              <SearchInput value={jq} onChange={setJq} placeholder={t('acct.searchEntry')} />
            </div>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label={t('acct.entriesCount')} value={filteredJournal.length} />
            <StatCard label={t('acct.debit')} value={formatMoney(journalTotals.debit)} suffix={t('common.currency')} />
            <StatCard label={t('acct.credit')} value={formatMoney(journalTotals.credit)} suffix={t('common.currency')} />
            <StatCard
              label={t('acct.balanced')}
              value={journalTotals.balanced ? t('acct.balancedYes') : t('acct.balancedNo')}
              tone={journalTotals.balanced ? 'text-emerald-600 bg-emerald-50' : 'text-red-600 bg-red-50'}
            />
          </div>
        </>
      )}

      {isJournal
        ? <JournalView entries={filteredJournal} lang={lang} locale={locale} />
        : <AccountTree accounts={accounts} cleanAccounts={cleanAccounts} clients={clients} employees={employees} vendors={vendors} balances={balances} journal={journal} settings={settings} lang={lang} locale={locale} />}

      <FullTreeReportModal
        open={showFullReportModal}
        onClose={() => setShowFullReportModal(false)}
        journal={journal}
        accounts={accounts}
        settings={settings}
        locale={locale}
        lang={lang}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  قائمة التدفقات النقدية                                              */
/* ------------------------------------------------------------------ */

export function CashFlowStatement({ flow, locale }) {
  const { t } = useI18n()

  const groups = [
    { key: 'operating', inn: flow.operatingIn, out: flow.operatingOut, net: flow.operating },
    { key: 'investing', inn: flow.investingIn, out: flow.investingOut, net: flow.investing },
    { key: 'financing', inn: flow.financingIn, out: flow.financingOut, net: flow.financing },
  ]

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        {groups.map((g) => (
          <StatCard
            key={g.key}
            label={t(`acct.cf.${g.key}`)}
            value={formatMoney(g.net)}
            suffix={t('common.currency')}
            tone={g.net >= 0 ? 'text-emerald-600 bg-emerald-50' : 'text-rose-600 bg-rose-50'}
          />
        ))}
      </div>

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('acct.cf.activity')}</Th>
            <Th>{t('treasury.in')}</Th>
            <Th>{t('treasury.out')}</Th>
            <Th>{t('acct.balance')}</Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key}>
              <Td className="font-semibold text-slate-800">{t(`acct.cf.${g.key}`)}</Td>
              <Td><span className="num text-emerald-600">{formatMoney(g.inn)}</span></Td>
              <Td><span className="num text-rose-600">{formatMoney(g.out)}</span></Td>
              <Td>
                <span className={`num font-bold ${g.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {formatMoney(g.net)}
                </span>
              </Td>
            </tr>
          ))}
          <tr className="bg-slate-50">
            <Td className="font-extrabold text-slate-900">{t('acct.cf.net')}</Td>
            <Td /><Td />
            <Td>
              <span className={`num font-extrabold ${flow.net >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {formatMoney(flow.net)}
              </span>
            </Td>
          </tr>
        </tbody>
      </TableWrap>

      {flow.rows.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-bold text-slate-900">{t('acct.cf.movements')}</h3>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                <Th>{t('acct.reference')}</Th>
                <Th>{t('common.description')}</Th>
                <Th>{t('common.amount')}</Th>
              </tr>
            </thead>
            <tbody>
              {flow.rows.map((row, index) => (
                <tr key={`${row.id}-${index}`}>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                  <Td>
                    <Badge tone="slate">{t(`acct.ref.${row.refType}`)}</Badge>
                    <span className="num ms-2 text-xs font-bold text-slate-700">{row.ref}</span>
                  </Td>
                  <Td className="text-slate-600">{row.description || '—'}</Td>
                  <Td>
                    <span className={`num font-bold ${row.delta >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {row.delta >= 0 ? '+' : '−'}{formatMoney(Math.abs(row.delta))}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  نموذج الإقرار الضريبي — ضريبة القيمة المضافة                         */
/* ------------------------------------------------------------------ */

export function TaxReturn({ invoices, taxAccount }) {
  const { t } = useI18n()

  const outputVat = invoices.reduce((sum, invoice) => sum + toNumber(invoice.taxAmount), 0)
  const taxable = invoices.reduce(
    (sum, invoice) => sum + toNumber(invoice.feesTotal ?? 0),
    0,
  )
  const payable = taxAccount ? taxAccount.balance : outputVat

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t('acct.tax.taxableSales')} value={formatMoney(taxable)} suffix={t('common.currency')} />
        <StatCard
          label={t('acct.tax.outputVat')}
          value={formatMoney(outputVat)}
          suffix={t('common.currency')}
          tone="text-violet-600 bg-violet-50"
        />
        <StatCard
          label={t('acct.tax.payable')}
          value={formatMoney(payable)}
          suffix={t('common.currency')}
          tone={payable > 0 ? 'text-rose-600 bg-rose-50' : 'text-emerald-600 bg-emerald-50'}
        />
      </div>

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('acct.tax.line')}</Th>
            <Th>{t('common.amount')}</Th>
          </tr>
        </thead>
        <tbody>
          <tr><Td className="text-slate-700">{t('acct.tax.taxableSales')}</Td><Td><span className="num">{formatMoney(taxable)}</span></Td></tr>
          <tr><Td className="text-slate-700">{t('acct.tax.outputVat')}</Td><Td><span className="num font-bold text-slate-800">{formatMoney(outputVat)}</span></Td></tr>
          <tr><Td className="text-slate-500">{t('acct.tax.inputVat')}</Td><Td><span className="num text-slate-400">—</span></Td></tr>
          <tr className="bg-slate-50">
            <Td className="font-extrabold text-slate-900">{t('acct.tax.balanceDue')}</Td>
            <Td><span className="num font-extrabold text-rose-600">{formatMoney(payable)}</span></Td>
          </tr>
        </tbody>
      </TableWrap>

      <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500">{t('acct.tax.note')}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  شجرة الحسابات                                                      */
/* ------------------------------------------------------------------ */

function AccountDetail({ account, balance, kids, lang }) {
  const { t } = useI18n()
  const rows = [
    { label: t('acct.accountNameEn'), value: account.nameEn || '—' },
    { label: t('common.type'), value: t(`acct.type.${account.type}`) },
    { label: t('acct.parent'), value: account.parentCode || t('acct.noParent') },
    { label: t('acct.childrenCount'), value: kids },
    { label: t('acct.systemRole'), value: account.role || '—' },
    { label: t('acct.debit'), value: formatMoney(balance?.debit ?? 0), num: true },
    { label: t('acct.credit'), value: formatMoney(balance?.credit ?? 0), num: true },
    { label: t('acct.balance'), value: formatMoney(balance?.balance ?? 0), num: true, strong: true },
  ]
  return (
    <div className="grid gap-x-8 gap-y-2 py-2 sm:grid-cols-2 lg:grid-cols-4">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3 text-xs">
          <span className="font-semibold text-slate-500">{row.label}</span>
          <span
            className={`${row.num ? 'num' : ''} ${row.strong ? 'font-extrabold text-slate-900' : 'font-semibold text-slate-700'}`}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  )
}

function downloadCSV(filename, headers, rows) {
  const escapeCell = (cell) => {
    if (cell === null || cell === undefined) return '""'
    const str = String(cell).replace(/"/g, '""')
    return `"${str}"`
  }

  const csvContent =
    '\uFEFF' +
    [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.setAttribute('href', url)
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

function exportAccountCSV(account, movements, t, locale, from = '', to = '') {
  const isGroup = account?.isGroup || movements.some((m) => m.subAccountCode)
  const headers = isGroup
    ? ['التاريخ', 'كود الحساب الفرعي', 'اسم الحساب الفرعي', 'المستند / المرجع', 'نوع الحركة', 'البيان / الوصف', 'مدين (SAR)', 'دائن (SAR)', 'الرصيد التراكمي (SAR)']
    : ['التاريخ', 'المستند / المرجع', 'نوع الحركة', 'البيان / الوصف', 'مدين (SAR)', 'دائن (SAR)', 'الرصيد التراكمي (SAR)']

  const totalDebit = round2(movements.reduce((s, m) => s + toNumber(m.debit), 0))
  const totalCredit = round2(movements.reduce((s, m) => s + toNumber(m.credit), 0))
  const finalBalance = movements.length > 0 ? movements.at(-1).balance : 0

  const rows = movements.map((m) => {
    const base = [
      formatDate(m.date, locale),
      m.ref || '—',
      t(`acct.ref.${m.refType}`) || m.refType || '—',
      m.description || '—',
      toNumber(m.debit),
      toNumber(m.credit),
      toNumber(m.balance),
    ]
    if (isGroup) {
      base.splice(1, 0, m.subAccountCode || '—', m.subAccountName || '—')
    }
    return base
  })

  const totalRow = isGroup
    ? ['المجموع الإجمالي', '—', '—', '—', '—', 'إجمالي الفترة', totalDebit, totalCredit, finalBalance]
    : ['المجموع الإجمالي', '—', '—', 'إجمالي الفترة', totalDebit, totalCredit, finalBalance]

  rows.push(totalRow)

  const code = account.code || 'account'
  downloadCSV(`كشف_حساب_${code}_${todayISO()}.csv`, headers, rows)
}

function exportTreeCSV(accounts, rolled, t, lang) {
  const headers = ['كود الحساب', 'اسم الحساب', 'النوع', 'الحساب الأب', 'مدين', 'دائن', 'الرصيد النهائي']
  const rows = accounts.map((account) => {
    const bal = rolled.get(account.id)
    return [
      account.code,
      accountLabel(account, lang),
      t(`acct.type.${account.type}`),
      account.parentCode || 'حساب رئيسي',
      bal ? bal.debit : 0,
      bal ? bal.credit : 0,
      bal ? bal.balance : 0,
    ]
  })
  downloadCSV(`شجرة_الحسابات_${todayISO()}.csv`, headers, rows)
}



function TreeNavNode({ node, expanded, toggle, selected, onSelect, onAddChild, lang }) {
  const isGroup = node.isGroup || (node.children && node.children.length > 0)
  const code = String(node.code)
  const isOpen = expanded.has(code)
  const isSelected = selected?.id === node.id

  const handleRowClick = () => {
    onSelect(node)
    if (isGroup) {
      if (!isOpen) {
        toggle(code)
      } else if (isSelected) {
        toggle(code)
      }
    }
  }

  return (
    <div className="group/node select-none text-xs">
      <div
        className={`flex items-center justify-between rounded-xl px-2.5 py-1.5 transition cursor-pointer ${
          isSelected
            ? 'bg-brand-600 text-white font-bold shadow-sm'
            : isGroup
            ? 'font-bold text-slate-800 hover:bg-slate-100'
            : 'text-slate-600 hover:bg-slate-50'
        }`}
        onClick={handleRowClick}
      >
        <div className="flex items-center gap-1.5 truncate min-w-0">
          {isGroup ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                toggle(code)
              }}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-md hover:bg-slate-200/60 text-slate-400 hover:text-slate-700 transition"
              title={isOpen ? 'طي القسم' : 'توسيع القسم'}
            >
              <svg
                className={`h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? 'rotate-90 text-brand-600 font-extrabold' : 'rtl:-rotate-180'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}

          {isGroup ? (
            <IconFolder className={`h-4 w-4 shrink-0 ${isSelected ? 'text-white' : isOpen ? 'text-brand-500' : 'text-amber-500'}`} />
          ) : (
            <IconFileText className={`h-4 w-4 shrink-0 ${isSelected ? 'text-white' : 'text-slate-400'}`} />
          )}
          <span className="truncate">{accountLabel(node, lang)}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ms-2">
          {isGroup && onAddChild && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onAddChild(node)
              }}
              title="إضافة حساب فرعي أو مجموعة بداخل هذا الحساب"
              className={`grid h-5 w-5 place-items-center rounded-md text-xs font-black transition ${
                isSelected
                  ? 'bg-white/20 text-white hover:bg-white/30'
                  : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-200/60'
              }`}
            >
              +
            </button>
          )}

          <span className={`num text-[11px] font-bold ${isSelected ? 'text-brand-100' : 'text-slate-400'}`}>
            {node.code}
          </span>
        </div>
      </div>

      {isGroup && isOpen && node.children && node.children.length > 0 && (
        <div className="mr-3 border-r-2 border-slate-200/80 pr-1 space-y-0.5 mt-0.5">
          {node.children.map((child) => (
            <TreeNavNode
              key={child.id}
              node={child}
              expanded={expanded}
              toggle={toggle}
              selected={selected}
              onSelect={onSelect}
              onAddChild={onAddChild}
              lang={lang}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function buildCleanAccounts(accounts = [], clients = [], employees = [], vendors = []) {
  const empMap = new Map((employees || []).map((e) => [e.id, e]))
  const map = new Map()
  for (const account of accounts) {
    const codeKey = String(account.code)
    if (codeKey === '11010201' || (account.name || '').includes('البنكي الرئيسي') || (account.name || '').includes('البنكى الرئيسى')) {
      continue
    }
    if (!map.has(codeKey)) {
      map.set(codeKey, account)
    } else {
      const existing = map.get(codeKey)
      if (!existing.role && account.role) {
        map.set(codeKey, account)
      }
    }
  }

  const baseList = Array.from(map.values())

  // 1 — إضافة شجرة العملاء وتحتهم الموظفين المسؤولين
  const recIdx = baseList.findIndex(
    (a) => String(a.code) === '110201' || String(a.code) === '112' || String(a.code).startsWith('110201') || a.role === 'receivable',
  )
  if (recIdx !== -1 && clients.length > 0) {
    baseList[recIdx] = { ...baseList[recIdx], isGroup: true }
    const recCode = String(baseList[recIdx].code)

    const parentClients = clients.filter((c) => c.isParent || (!c.parentId && clients.some((sub) => sub.parentId === c.id)))
    const standaloneClients = clients.filter((c) => !c.isParent && !c.parentId && !clients.some((sub) => sub.parentId === c.id))

    let pIndex = 1
    for (const pClient of parentClients) {
      const pCode = `${recCode}${String(pIndex).padStart(2, '0')}`
      pIndex += 1

      const childBranches = clients.filter((c) => c.parentId === pClient.id)

      baseList.push({
        id: `client-${pClient.id}`,
        code: pCode,
        name: `${pClient.name} (عميل رئيسي)`,
        nameEn: pClient.businessName || '',
        type: 'asset',
        isGroup: true,
        parentCode: recCode,
        clientId: pClient.id,
        isClientNode: true,
        isParentClient: true,
      })

      if (pClient.employeeId && empMap.get(pClient.employeeId)) {
        baseList.push({
          id: `client-emp-${pClient.id}-main`,
          code: `${pCode}91`,
          name: `👤 الموظف المسؤول: ${empMap.get(pClient.employeeId).name}`,
          type: 'asset',
          isGroup: false,
          parentCode: pCode,
          employeeId: pClient.employeeId,
        })
      }
      if (pClient.secondEmployeeId && empMap.get(pClient.secondEmployeeId)) {
        baseList.push({
          id: `client-emp-${pClient.id}-sec`,
          code: `${pCode}92`,
          name: `👤 الموظف المساعد: ${empMap.get(pClient.secondEmployeeId).name}`,
          type: 'asset',
          isGroup: false,
          parentCode: pCode,
          employeeId: pClient.secondEmployeeId,
        })
      }

      let bIndex = 1
      for (const bClient of childBranches) {
        const bCode = `${pCode}${String(bIndex).padStart(2, '0')}`
        bIndex += 1
        const bHasEmp = Boolean(bClient.employeeId || bClient.secondEmployeeId)

        baseList.push({
          id: `client-${bClient.id}`,
          code: bCode,
          name: `${bClient.name} (فرع)`,
          nameEn: bClient.businessName || '',
          type: 'asset',
          isGroup: bHasEmp,
          parentCode: pCode,
          clientId: bClient.id,
          isClientNode: true,
          isChildClient: true,
        })

        if (bClient.employeeId && empMap.get(bClient.employeeId)) {
          baseList.push({
            id: `client-emp-${bClient.id}-main`,
            code: `${bCode}01`,
            name: `👤 الموظف المسؤول: ${empMap.get(bClient.employeeId).name}`,
            type: 'asset',
            isGroup: false,
            parentCode: bCode,
            employeeId: bClient.employeeId,
          })
        }
        if (bClient.secondEmployeeId && empMap.get(bClient.secondEmployeeId)) {
          baseList.push({
            id: `client-emp-${bClient.id}-sec`,
            code: `${bCode}02`,
            name: `👤 الموظف المساعد: ${empMap.get(bClient.secondEmployeeId).name}`,
            type: 'asset',
            isGroup: false,
            parentCode: bCode,
            employeeId: bClient.secondEmployeeId,
          })
        }
      }
    }

    for (const sClient of standaloneClients) {
      const sCode = `${recCode}${String(pIndex).padStart(2, '0')}`
      pIndex += 1
      const sHasEmp = Boolean(sClient.employeeId || sClient.secondEmployeeId)

      baseList.push({
        id: `client-${sClient.id}`,
        code: sCode,
        name: sClient.name,
        nameEn: sClient.businessName || '',
        type: 'asset',
        isGroup: sHasEmp,
        parentCode: recCode,
        clientId: sClient.id,
        isClientNode: true,
      })

      if (sClient.employeeId && empMap.get(sClient.employeeId)) {
        baseList.push({
          id: `client-emp-${sClient.id}-main`,
          code: `${sCode}01`,
          name: `👤 الموظف المسؤول: ${empMap.get(sClient.employeeId).name}`,
          type: 'asset',
          isGroup: false,
          parentCode: sCode,
          employeeId: sClient.employeeId,
        })
      }
      if (sClient.secondEmployeeId && empMap.get(sClient.secondEmployeeId)) {
        baseList.push({
          id: `client-emp-${sClient.id}-sec`,
          code: `${sCode}02`,
          name: `👤 الموظف المساعد: ${empMap.get(sClient.secondEmployeeId).name}`,
          type: 'asset',
          isGroup: false,
          parentCode: sCode,
          employeeId: sClient.secondEmployeeId,
        })
      }
    }
  }

  // 2 — إضافة حسابات الموظفين تفصيليًا تحت مستحقات الموظفين (دائنون 210201)
  const empPayIdx = baseList.findIndex((a) => String(a.code) === '210201' || a.role === 'employeePayable')
  if (empPayIdx !== -1 && employees.length > 0) {
    baseList[empPayIdx] = { ...baseList[empPayIdx], isGroup: true }
    const empPayCode = String(baseList[empPayIdx].code)
    let eIndex = 1
    for (const emp of employees) {
      const eCode = `${empPayCode}${String(eIndex).padStart(2, '0')}`
      eIndex += 1
      baseList.push({
        id: `emp-payable-${emp.id}`,
        code: eCode,
        name: `👤 ${emp.name} (مستحقات موظف)`,
        type: 'liability',
        isGroup: false,
        parentCode: empPayCode,
        employeeId: emp.id,
      })
    }
  }

  // 3 — إضافة حسابات الموظفين تفصيليًا تحت عهد وسلف الموظفين (أصول 110203)
  const empAdvIdx = baseList.findIndex((a) => String(a.code) === '110203')
  if (empAdvIdx !== -1 && employees.length > 0) {
    baseList[empAdvIdx] = { ...baseList[empAdvIdx], isGroup: true }
    const empAdvCode = String(baseList[empAdvIdx].code)
    let eIndex = 1
    for (const emp of employees) {
      const eCode = `${empAdvCode}${String(eIndex).padStart(2, '0')}`
      eIndex += 1
      baseList.push({
        id: `emp-advance-${emp.id}`,
        code: eCode,
        name: `👤 ${emp.name} (عهدة/سلفة)`,
        type: 'asset',
        isGroup: false,
        parentCode: empAdvCode,
        employeeId: emp.id,
      })
    }
  }

  // 4 — إضافة حسابات الموردين تفصيليًا تحت الموردين (دائنون 211 أو 2101)
  let vendorIdx = baseList.findIndex(
    (a) =>
      String(a.code) === '211' ||
      String(a.code) === '2101' ||
      String(a.code) === '210101' ||
      String(a.code) === '21101' ||
      String(a.code).startsWith('211') ||
      String(a.code).startsWith('2101') ||
      (a.name || '').includes('الموردون') ||
      (a.name || '').includes('الموردين') ||
      a.role === 'vendorPayable',
  )
  if (vendors.length > 0) {
    if (vendorIdx === -1) {
      const autoVendorGroup = {
        id: 'group-vendor-211-auto',
        code: '211',
        name: 'الموردون والدائنون التجاريون',
        type: 'liability',
        isGroup: true,
        parentCode: '21',
        role: 'vendorPayable',
      }
      baseList.push(autoVendorGroup)
      vendorIdx = baseList.length - 1
    } else {
      baseList[vendorIdx] = { ...baseList[vendorIdx], isGroup: true }
    }

    const vendorCode = String(baseList[vendorIdx].code)
    let vIndex = 1
    for (const vendor of vendors) {
      const vCode = `${vendorCode}${String(vIndex).padStart(2, '0')}`
      vIndex += 1
      baseList.push({
        id: `vendor-${vendor.id}`,
        code: vCode,
        name: vendor.name,
        type: 'liability',
        isGroup: false,
        parentCode: vendorCode,
        vendorId: vendor.id,
        subLedgerType: 'vendor',
        subLedgerId: vendor.id,
        isVendorNode: true,
      })
    }
  }

  return baseList
}

function AccountTree({ accounts, cleanAccounts: cleanAccountsProp, clients = [], employees = [], vendors = [], balances = [], journal = [], settings = {}, lang, locale }) {
  const { t } = useI18n()

  /* استبعاد الحسابات المكررة وبناء شجرة العملاء والموظفين تراكيباً دقيقاً */
  const cleanAccounts = useMemo(
    () => cleanAccountsProp || buildCleanAccounts(accounts, clients, employees, vendors),
    [cleanAccountsProp, accounts, clients, employees, vendors],
  )

  /* تنظيف المستندات المكررة والحسابات المحذوفة تلقائياً من قواعد البيانات */
  useEffect(() => {
    for (const account of accounts) {
      if (String(account.code) === '11010201' || (account.name || '').includes('البنكي الرئيسي') || (account.name || '').includes('البنكى الرئيسى')) {
        deleteDocById(ACCOUNTS_COL, account.id).catch(() => {})
      }
    }
    if (accounts.length > cleanAccounts.length) {
      cleanupDuplicateAccounts(accounts)
    }
  }, [accounts, cleanAccounts.length])

  const treeNodes = useMemo(() => buildTree(cleanAccounts), [cleanAccounts])
  const nodes = useMemo(() => flattenTree(treeNodes), [treeNodes])
  const byCode = useMemo(
    () => new Map(cleanAccounts.map((account) => [String(account.code), account])),
    [cleanAccounts],
  )
  const balanceById = useMemo(
    () => new Map(balances.map((row) => [row.account.id, row])),
    [balances],
  )

  /* رصيد مجمّع لكل حساب (نفسه + كل فروعه) */
  const rolled = useMemo(() => {
    const map = new Map()
    const visitedNodes = new Set()
    const visit = (node) => {
      if (!node) return { debit: 0, credit: 0, balance: 0 }
      if (visitedNodes.has(node.id)) return map.get(node.id) || { debit: 0, credit: 0, balance: 0 }
      visitedNodes.add(node.id)

      const own = balanceById.get(node.id)
      let debit = own ? own.debit : 0
      let credit = own ? own.credit : 0
      for (const child of node.children ?? []) {
        const sub = visit(child)
        debit += sub.debit
        credit += sub.credit
      }
      const normal = getNormalBalance(node)
      const result = {
        debit: round2(debit),
        credit: round2(credit),
        balance: round2(normal === 'debit' ? debit - credit : credit - debit),
      }
      map.set(node.id, result)
      return result
    }
    treeNodes.forEach(visit)
    return map
  }, [treeNodes, balanceById])

  const childCount = useMemo(() => {
    const map = new Map()
    for (const account of cleanAccounts) {
      const key = String(account.parentCode ?? '')
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [cleanAccounts])

  const groupCategoryOptions = useMemo(() => {
    return cleanAccounts
      .filter((a) => a.isGroup)
      .sort((a, b) => String(a.code).localeCompare(String(b.code)))
      .map((a) => ({
        code: String(a.code),
        name: `${a.code} — ${accountLabel(a, lang)}`,
      }))
  }, [cleanAccounts, lang])

  function openCategory(groupCode) {
    if (!groupCode) return
    const codeStr = String(groupCode)
    const targetGroup = cleanAccounts.find((a) => String(a.code) === codeStr)
    if (!targetGroup) return

    const next = new Set()

    // Build chain of ancestors for targetGroup
    const chain = []
    let current = targetGroup
    const visited = new Set()
    while (current) {
      const code = String(current.code)
      if (visited.has(code)) break
      visited.add(code)
      chain.unshift(current)
      current = current.parentCode ? byCode.get(String(current.parentCode)) : null
    }

    // Expand ancestor chain
    for (const item of chain) {
      next.add(String(item.code))
    }

    // Expand immediate child groups under targetGroup
    for (const acc of cleanAccounts) {
      if (acc.isGroup && String(acc.parentCode) === codeStr) {
        next.add(String(acc.code))
      }
    }

    setExpanded(next)
  }

  const [expanded, setExpanded] = useState(() => new Set())

  /* تحديث الأقسام المفتوحة فور تحميل الحسابات — فتح الأقسام الرئيسية فقط أولاً */
  useEffect(() => {
    if (cleanAccounts.length > 0 && expanded.size === 0) {
      setExpanded(new Set(cleanAccounts.filter((a) => a.isGroup && !a.parentCode).map((a) => String(a.code))))
    }
  }, [cleanAccounts])

  const [selected, setSelected] = useState(null)
  const [statementAccount, setStatementAccount] = useState(null)
  const [showFullReport, setShowFullReport] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)

  const collapseSubtree = (setObj, code) => {
    const visited = new Set()
    const recurse = (c) => {
      const codeStr = String(c)
      if (visited.has(codeStr)) return
      visited.add(codeStr)
      setObj.delete(codeStr)
      for (const account of cleanAccounts) {
        if (String(account.parentCode ?? '') === codeStr) recurse(account.code)
      }
    }
    recurse(code)
  }

  function toggle(code) {
    setExpanded((current) => {
      const next = new Set(current)
      const codeStr = String(code)
      if (next.has(codeStr)) {
        collapseSubtree(next, codeStr)
      } else {
        // Accordion mode: Collapse sibling nodes sharing the same parentCode
        const targetAcc = cleanAccounts.find((a) => String(a.code) === codeStr)
        if (targetAcc) {
          const parentCode = targetAcc.parentCode ? String(targetAcc.parentCode) : null
          for (const acc of cleanAccounts) {
            const accCode = String(acc.code)
            const accParent = acc.parentCode ? String(acc.parentCode) : null
            if (accCode !== codeStr && accParent === parentCode) {
              collapseSubtree(next, accCode)
            }
          }
        }
        next.add(codeStr)
      }
      return next
    })
  }

  function isVisible(account) {
    let parent = account.parentCode
    const visited = new Set([String(account.code)])
    while (parent) {
      const parentStr = String(parent)
      if (visited.has(parentStr)) return false
      visited.add(parentStr)
      if (!expanded.has(parentStr)) return false
      parent = byCode.get(parentStr)?.parentCode ?? null
    }
    return true
  }

  async function save(values) {
    const cleanCode = String(values.code ?? '').trim().toLowerCase()
    const cleanName = String(values.name ?? '').trim().toLowerCase()
    const codeDup = cleanAccounts.some(
      (a) => a.id !== editing?.id && String(a.code).trim().toLowerCase() === cleanCode
    )
    const nameDup = cleanAccounts.some(
      (a) => a.id !== editing?.id && String(a.name).trim().toLowerCase() === cleanName
    )
    if (codeDup || nameDup) return

    setBusy(true)
    if (editing?.id) await updateDocById(ACCOUNTS_COL, editing.id, values)
    else await createDoc(ACCOUNTS_COL, { ...values, archived: false })
    setBusy(false)
    setEditing(null)
  }

  async function remove() {
    setBusy(true)
    await deleteDocById(ACCOUNTS_COL, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  const term = q.trim().toLowerCase()

  const visible = useMemo(() => {
    let list = term
      ? nodes.filter((account) => {
          const matchSelf =
            String(account.code).includes(term) ||
            accountLabel(account, lang).toLowerCase().includes(term) ||
            (account.nameEn ?? '').toLowerCase().includes(term)
          if (matchSelf) return true
          if (account.parentCode) {
            const parentAcc = byCode.get(String(account.parentCode))
            if (parentAcc) {
              return (
                String(parentAcc.code).includes(term) ||
                accountLabel(parentAcc, lang).toLowerCase().includes(term) ||
                (parentAcc.nameEn ?? '').toLowerCase().includes(term)
              )
            }
          }
          return false
        })
      : nodes.filter(isVisible)
    if (selected && !term) {
      const selCode = String(selected.code)
      list = list.filter((a) => String(a.code) === selCode || String(a.parentCode) === selCode || a.id === selected.id)
    }
    return list
  }, [term, nodes, isVisible, selected, lang, byCode])

  const pageSize = 15
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedItems = useMemo(
    () => visible.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [visible, currentPage, pageSize],
  )

  function getLevelBadge(account) {
    if (account.depth === 0) {
      return (
        <span className="inline-flex items-center rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-extrabold text-sky-700">
          رئيسي
        </span>
      )
    }
    if (account.isGroup) {
      return (
        <span className="inline-flex items-center rounded-md border border-purple-200 bg-purple-50 px-2 py-0.5 text-xs font-bold text-purple-700">
          مجموعة
        </span>
      )
    }
    return (
      <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
        حساب
      </span>
    )
  }

  const rootBalances = useMemo(() => {
    const getBal = (code) => {
      const acc = cleanAccounts.find((a) => String(a.code) === code)
      if (!acc) return 0
      return rolled.get(acc.id)?.balance || 0
    }
    return {
      assets: getBal('1'),
      liabilities: getBal('2'),
      equity: getBal('3'),
      revenue: getBal('4'),
      expenses: getBal('5'),
    }
  }, [cleanAccounts, rolled])

  return (
    <div className="space-y-4">
      {/* البطاقات الخمس للمؤشرات المحاسبية */}
      <div className="card p-5">

        {/* بطاقات المؤشرات المحاسبية الخمسة (KPI Cards) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5 pt-1">
          {/* أصول */}
          <div className="rounded-2xl border-2 border-sky-400 bg-white p-4 shadow-xs transition hover:shadow-md flex flex-col justify-between">
            <span className="text-xs font-extrabold text-slate-500">أصول</span>
            <span className="text-lg font-black text-slate-900 num mt-2">
              {formatMoney(rootBalances.assets)} <span className="text-xs font-bold text-slate-400">ج.م</span>
            </span>
          </div>

          {/* خصوم */}
          <div className="rounded-2xl border-2 border-amber-400 bg-white p-4 shadow-xs transition hover:shadow-md flex flex-col justify-between">
            <span className="text-xs font-extrabold text-slate-500">خصوم</span>
            <span className="text-lg font-black text-slate-900 num mt-2">
              {formatMoney(rootBalances.liabilities)} <span className="text-xs font-bold text-slate-400">ج.م</span>
            </span>
          </div>

          {/* حقوق ملكية */}
          <div className="rounded-2xl border-2 border-purple-400 bg-white p-4 shadow-xs transition hover:shadow-md flex flex-col justify-between">
            <span className="text-xs font-extrabold text-slate-500">حقوق ملكية</span>
            <span className="text-lg font-black text-slate-900 num mt-2">
              {formatMoney(rootBalances.equity)} <span className="text-xs font-bold text-slate-400">ج.م</span>
            </span>
          </div>

          {/* إيرادات */}
          <div className="rounded-2xl border-2 border-emerald-400 bg-white p-4 shadow-xs transition hover:shadow-md flex flex-col justify-between">
            <span className="text-xs font-extrabold text-slate-500">إيرادات</span>
            <span className="text-lg font-black text-slate-900 num mt-2">
              {formatMoney(rootBalances.revenue)} <span className="text-xs font-bold text-slate-400">ج.م</span>
            </span>
          </div>

          {/* مصروفات */}
          <div className="rounded-2xl border-2 border-rose-400 bg-white p-4 shadow-xs transition hover:shadow-md flex flex-col justify-between">
            <span className="text-xs font-extrabold text-slate-500">مصروفات</span>
            <span className="text-lg font-black text-slate-900 num mt-2">
              {formatMoney(rootBalances.expenses)} <span className="text-xs font-bold text-slate-400">ج.م</span>
            </span>
          </div>
        </div>
      </div>

      {/* شريط البحث والأدوات الحالية */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600 shadow-xs">
              <IconFolder className="h-5 w-5 shrink-0" />
            </div>
            <div>
              <h2 className="text-sm font-extrabold text-slate-900">دليل الحسابات التفصيلي</h2>
              <p className="text-xs font-semibold text-slate-400">إدارة وتصنيف شجرة دليل الحسابات المحاسبية</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="min-w-[240px]">
              <SearchInput value={q} onChange={(val) => { setQ(val); setPage(1); }} placeholder="ابحث بالاسم أو الكود..." />
            </div>

            <Button variant="ghost" onClick={() => exportTreeCSV(cleanAccounts, rolled, t, lang)}>
              <IconExport className="h-4 w-4 me-1.5 shrink-0 inline" /> تصدير
            </Button>
            <Button variant="ghost" onClick={() => setShowImportModal(true)}>
              <IconImport className="h-4 w-4 me-1.5 shrink-0 inline" /> استيراد / استرداد
            </Button>
            <Button onClick={() => setEditing({})}>
              + حساب جديد
            </Button>
          </div>
        </div>
      </div>

      {/* التخطيط المقسم: شجرة الحسابات الجانبية + جدول الحسابات */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-5 items-start">
        {/* اللوحة الجانبية: شجرة الحسابات التفاعلية */}
        <div className="card p-4 space-y-3 xl:col-span-1">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <IconFolderOpen className="h-4 w-4 text-brand-600 shrink-0" />
              <h3 className="text-sm font-extrabold text-slate-900">شجرة الحسابات</h3>
            </div>
            <div className="flex items-center gap-2">
              <select
                value=""
                onChange={(e) => {
                  const code = e.target.value
                  if (code) openCategory(code)
                }}
                className="h-8 max-w-[150px] rounded-xl border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-700 shadow-xs focus:border-brand-500 focus:outline-none transition cursor-pointer truncate"
              >
                <option value="">📂 فتح قسم...</option>
                {groupCategoryOptions.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                title={expanded.size > 0 ? 'إغلاق كل الأقسام' : 'فتح وتوسيع كافة الأقسام'}
                onClick={() => {
                  if (expanded.size > 0) {
                    setExpanded(new Set())
                  } else {
                    setExpanded(new Set(cleanAccounts.filter((a) => a.isGroup || (childCount.get(String(a.code)) ?? 0) > 0).map((a) => String(a.code))))
                  }
                }}
                className={`grid h-8 w-8 place-items-center rounded-xl border text-xs transition shadow-xs cursor-pointer shrink-0 ${
                  expanded.size > 0
                    ? 'bg-rose-50 border-rose-200/80 text-rose-600 hover:bg-rose-100'
                    : 'bg-emerald-50 border-emerald-200/80 text-emerald-700 hover:bg-emerald-100'
                }`}
              >
                <svg
                  className={`h-4 w-4 transition-transform duration-300 ${expanded.size > 0 ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.5"
                    d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
                  />
                </svg>
              </button>
            </div>
          </div>

          {selected && (
            <div className="flex items-center justify-between rounded-xl bg-brand-50 px-3 py-2 text-xs font-bold text-brand-700 border border-brand-200/60">
              <div className="flex items-center gap-1.5 truncate">
                <span>تصفية بحساب:</span>
                <span className="truncate text-brand-900">{selected.code} - {accountLabel(selected, lang)}</span>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg px-2 py-0.5 text-xs font-bold text-brand-700 hover:bg-brand-100 shrink-0"
                title="إزالة التصفية وعرض الكل"
              >
                إظهار الكل ✕
              </button>
            </div>
          )}

          <div className="max-h-[600px] overflow-y-auto pr-1 space-y-0.5 scrollbar-thin">
            {treeNodes.map((node) => (
              <TreeNavNode
                key={node.id}
                node={node}
                expanded={expanded}
                toggle={toggle}
                selected={selected}
                onSelect={(item) => { setSelected(item); setPage(1); }}
                onAddChild={(item) => setEditing({ presetParentCode: item.code })}
                lang={lang}
              />
            ))}
          </div>
        </div>

        {/* الجدول الرئيسي لعرض بيانات وأرصدة الحسابات */}
        <div className="space-y-4 xl:col-span-3">
          {visible.length === 0 ? (
            <p className="card px-4 py-12 text-center text-sm text-slate-400">{t('reports.empty')}</p>
          ) : (
            <div className="card overflow-hidden">
              <TableWrap>
                <thead>
                  <tr>
                    <Th>الكود</Th>
                    <Th>اسم الحساب</Th>
                    <Th>المستوى</Th>
                    <Th>مدين</Th>
                    <Th>دائن</Th>
                    <Th>الرصيد</Th>
                    <Th>الحالة</Th>
                    <Th className="w-px text-center">الإجراءات</Th>
                  </tr>
                </thead>
                <tbody>
                  {pagedItems.map((account) => {
                    const bal = rolled.get(account.id)
                    const ownBal = balanceById.get(account.id)
                    const code = String(account.code)
                    const kids = childCount.get(code) ?? 0
                    const open = term ? true : expanded.has(code)
                    const isSelected = selected?.id === account.id
                    const balanceValue = bal ? bal.balance : 0
                    const debitValue = bal ? bal.debit : (ownBal?.debit ?? 0)
                    const creditValue = bal ? bal.credit : (ownBal?.credit ?? 0)

                    return (
                      <tr
                        key={account.id}
                        className={`transition ${account.isGroup ? 'bg-slate-50/60 font-semibold' : 'hover:bg-slate-50/80'} ${
                          isSelected ? 'bg-brand-50/50' : ''
                        }`}
                      >
                        <Td>
                          <span className="num font-extrabold text-slate-800">{account.code}</span>
                        </Td>

                        <Td>
                          <div className="flex items-center gap-2" style={{ paddingInlineStart: `${account.depth * 14}px` }}>
                            {kids > 0 ? (
                              <button
                                type="button"
                                onClick={() => toggle(code)}
                                className="grid h-5 w-5 shrink-0 place-items-center text-slate-400 hover:text-slate-700"
                              >
                                <IconChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90 rtl:rotate-90'}`} />
                              </button>
                            ) : (
                              <span className="w-5 shrink-0" />
                            )}
                            {account.isGroup ? (
                              <IconFolder className="h-4 w-4 text-amber-500 shrink-0 inline" />
                            ) : (
                              <IconFileText className="h-4 w-4 text-slate-400 shrink-0 inline" />
                            )}
                            <span className={`truncate ${account.isGroup ? 'font-extrabold text-slate-900' : 'font-semibold text-slate-700'}`}>
                              {accountLabel(account, lang)}
                            </span>
                            {account.isGroup && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditing({ presetParentCode: account.code })
                                }}
                                title="إضافة حساب فرعي أو مجموعة بداخل هذا الحساب"
                                className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-extrabold text-emerald-700 hover:bg-emerald-600 hover:text-white transition border border-emerald-200/60 ms-1 shrink-0"
                              >
                                + إضافة فرعي
                              </button>
                            )}
                          </div>
                        </Td>

                        <Td>{getLevelBadge(account)}</Td>

                        <Td>
                          <span className="num text-slate-600">{debitValue > 0 ? formatMoney(debitValue) : '0.00'}</span>
                        </Td>

                        <Td>
                          <span className="num text-slate-600">{creditValue > 0 ? formatMoney(creditValue) : '0.00'}</span>
                        </Td>

                        <Td>
                          <span className={`num font-bold ${balanceValue < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                            {formatMoney(balanceValue)}
                          </span>
                        </Td>

                        <Td>
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            نشط
                          </span>
                        </Td>

                        <Td>
                          <div className="flex items-center justify-end gap-1">
                            {account.isGroup && (
                              <button
                                type="button"
                                onClick={() => setEditing({ presetParentCode: account.code })}
                                title="إضافة فرعي / مجموعة بالداخل"
                                className="rounded-lg p-1.5 text-emerald-600 transition hover:bg-emerald-50 font-extrabold"
                              >
                                <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" />
                                </svg>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setStatementAccount(account)}
                              title={t('acct.viewStatement')}
                              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                            >
                              <IconFileText className="h-4 w-4 shrink-0" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing(account)}
                              title={t('common.edit')}
                              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                            >
                              <IconPencil className="h-4 w-4 shrink-0" />
                            </button>
                            {!account.role && (
                              <button
                                type="button"
                                onClick={() => setRemoving(account)}
                                title={t('common.delete')}
                                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                              >
                                <IconTrash className="h-4 w-4 shrink-0" />
                              </button>
                            )}
                          </div>
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </TableWrap>

              {/* شريط التنقل وتعدد الصفحات Pagination */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/50 px-4 py-3 text-xs font-semibold text-slate-500">
                <div>
                  عرض {(currentPage - 1) * pageSize + 1} - {Math.min(currentPage * pageSize, visible.length)} من {visible.length} حساب
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                  >
                    ‹
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPage(p)}
                      className={`grid h-7 min-w-[28px] place-items-center rounded-lg border px-2 text-xs font-bold transition ${
                        currentPage === p
                          ? 'border-brand-600 bg-brand-600 text-white shadow-xs'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                  >
                    ›
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <AccountForm
        open={Boolean(editing)}
        row={editing}
        accounts={accounts}
        lang={lang}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={save}
      />

      <AccountStatementModal
        open={Boolean(statementAccount)}
        account={statementAccount}
        accounts={accounts}
        journal={journal}
        settings={settings}
        locale={locale}
        onClose={() => setStatementAccount(null)}
      />

      <FullTreeReportModal
        open={showFullReport}
        onClose={() => setShowFullReport(false)}
        journal={journal}
        accounts={cleanAccounts}
        settings={settings}
        locale={locale}
        lang={lang}
      />

      <AccountImportModal
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        cleanAccounts={cleanAccounts}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={t('common.deleteTitle')}
        message={t('common.deleteMsg', { name: removing?.name ?? '' })}
      />
    </div>
  )
}

function AccountForm({ open, row, accounts, lang, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const key = row?.id ? row.id : row?.presetParentCode ? `preset-${row.presetParentCode}` : 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    const initialParentCode = row?.presetParentCode || row?.parentCode || ''
    const parentAccount = accounts.find((a) => String(a.code) === String(initialParentCode))
    const autoCode = initialParentCode ? nextChildCode(accounts, initialParentCode) : (row?.code ?? '')
    const inheritedType = parentAccount?.type || row?.type || 'expense'

    setForm({
      code: autoCode,
      name: row?.name ?? '',
      nameEn: row?.nameEn ?? '',
      type: inheritedType,
      parentCode: initialParentCode,
      isGroup: Boolean(row?.isGroup),
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  /* اختيار الأب يولّد الكود تلقائيًا (لحساب جديد) ويورّث نوع الأب */
  function pickParent(parentCode) {
    setForm((current) => {
      const parent = accounts.find((account) => String(account.code) === String(parentCode))
      const next = { ...current, parentCode }
      if (!row?.id) {
        next.code = parentCode ? nextChildCode(accounts, parentCode) : ''
        if (parent?.type) next.type = parent.type
      }
      return next
    })
  }

  const cleanCode = String(form.code ?? '').trim().toLowerCase()
  const cleanName = String(form.name ?? '').trim().toLowerCase()

  const codeDup = Boolean(
    cleanCode &&
      accounts.some(
        (a) => a.id !== row?.id && String(a.code).trim().toLowerCase() === cleanCode
      )
  )
  const nameDup = Boolean(
    cleanName &&
      accounts.some(
        (a) => a.id !== row?.id && String(a.name).trim().toLowerCase() === cleanName
      )
  )

  const invalid = !form.code?.trim() || !form.name?.trim() || codeDup || nameDup

  function submit() {
    setTouched(true)
    if (invalid) return
    onSave({
      code: form.code.trim(),
      name: form.name.trim(),
      nameEn: form.nameEn?.trim() ?? '',
      type: form.type,
      parentCode: form.parentCode || null,
      isGroup: Boolean(form.isGroup),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={row?.id ? t('acct.editAccount') : t('acct.addAccount')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy || (touched && invalid)}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('acct.code')}
            hint={!row?.id ? t('acct.codeAutoHint') : undefined}
            error={
              touched && !form.code?.trim()
                ? t('common.required')
                : codeDup
                ? t('acct.err.codeExists')
                : null
            }
          >
            <Input numeric value={form.code ?? ''} onChange={(event) => set('code', event.target.value)} />
          </Field>

          <Field label={t('common.type')}>
            <Select value={form.type} onChange={(event) => set('type', event.target.value)}>
              {['asset', 'liability', 'equity', 'revenue', 'expense'].map((type) => (
                <option key={type} value={type}>
                  {t(`acct.type.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label={t('acct.accountName')}
          error={
            touched && !form.name?.trim()
              ? t('common.required')
              : nameDup
              ? t('acct.err.nameExists')
              : null
          }
        >
          <Input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} />
        </Field>

        <Field label={`${t('acct.accountNameEn')} (${t('common.optional')})`}>
          <Input dir="ltr" value={form.nameEn ?? ''} onChange={(event) => set('nameEn', event.target.value)} />
        </Field>

        <Field label={t('acct.parent')}>
          <Select value={form.parentCode ?? ''} onChange={(event) => pickParent(event.target.value)}>
            <option value="">{t('acct.noParent')}</option>
            {accounts
              .filter((account) => account.isGroup && account.code !== form.code)
              .map((account) => (
                <option key={account.id} value={account.code}>
                  {account.code} — {accountLabel(account, lang)}
                </option>
              ))}
          </Select>
        </Field>

        <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
          <input
            type="checkbox"
            checked={Boolean(form.isGroup)}
            onChange={(event) => set('isGroup', event.target.checked)}
            className="h-4 w-4 accent-brand-600"
          />
          <span className="text-sm font-semibold text-slate-700">{t('acct.isGroup')}</span>
        </label>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/*  دفتر اليومية                                                       */
/* ------------------------------------------------------------------ */

export function JournalView({ entries, lang, locale }) {
  const { t } = useI18n()

  if (entries.length === 0) {
    return <p className="card px-4 py-12 text-center text-sm text-slate-400">{t('reports.empty')}</p>
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <div key={entry.id} className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="brand">{t(`acct.ref.${entry.refType}`)}</Badge>
              <span className="num text-sm font-bold text-slate-800">{entry.ref}</span>
              <span className="text-xs text-slate-500">{entry.description}</span>
            </div>
            <span className="text-xs font-semibold text-slate-500">{formatDate(entry.date, locale)}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr>
                  <Th>{t('acct.account')}</Th>
                  <Th>{t('acct.debit')}</Th>
                  <Th>{t('acct.credit')}</Th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((item, index) => (
                  <tr key={index}>
                    <Td>
                      <span className="num me-2 text-xs font-bold text-slate-400">{item.code}</span>
                      <span className="text-slate-700">{accountLabel(item.account, lang)}</span>
                    </Td>
                    <Td>
                      {item.debit > 0 ? (
                        <span className="num font-bold text-slate-800">{formatMoney(item.debit)}</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </Td>
                    <Td>
                      {item.credit > 0 ? (
                        <span className="num font-bold text-slate-800">{formatMoney(item.credit)}</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  دفتر الأستاذ                                                       */
/* ------------------------------------------------------------------ */

export function LedgerView({ journal, accounts, lang, locale }) {
  const { t } = useI18n()
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')

  const rows = useMemo(() => accountMovements(journal, accountId, accounts), [journal, accountId, accounts])
  const account = accounts.find((item) => item.id === accountId)

  const options = useMemo(
    () =>
      accounts.map((item) => ({
        id: item.id,
        name: `${item.code} — ${accountLabel(item, lang)}`,
        code: item.code,
        isGroup: item.isGroup,
        icon: item.isGroup ? '📁' : '📄',
        badge: item.isGroup ? 'حساب رئيسي' : 'حساب فرعي',
      })),
    [accounts, lang],
  )

  return (
    <div>
      <div className="card mb-4 p-4">
        <Field label={t('acct.account')} className="max-w-xl">
          <SearchableSelect
            options={options}
            value={accountId}
            placeholder={t('acct.account')}
            searchPlaceholder="ابحث باسم الحساب أو الكود..."
            onChange={(val) => setAccountId(val)}
          />
        </Field>
      </div>

      {account && (
        <div
          className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 transition ${
            account.isGroup
              ? 'border-purple-200 bg-purple-50/70 text-purple-950'
              : 'border-emerald-200 bg-emerald-50/70 text-emerald-950'
          }`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl ${
                account.isGroup ? 'bg-purple-500/10 text-purple-700' : 'bg-emerald-500/10 text-emerald-700'
              }`}
            >
              {account.isGroup ? '📁' : '📄'}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`num text-xs font-bold ${
                    account.isGroup ? 'text-purple-800' : 'text-emerald-800'
                  }`}
                >
                  {account.code}
                </span>
                <h4 className="text-sm font-bold">{accountLabel(account, lang)}</h4>
                <span
                  className={`rounded-md border px-2 py-0.5 text-xs font-extrabold ${
                    account.isGroup
                      ? 'border-purple-300 bg-purple-100 text-purple-800'
                      : 'border-emerald-300 bg-emerald-100 text-emerald-800'
                  }`}
                >
                  {account.isGroup ? 'حساب رئيسي (تجميعي)' : 'حساب فرعي (تفصيلي)'}
                </span>
              </div>
              <p
                className={`mt-0.5 text-xs ${
                  account.isGroup ? 'text-purple-700' : 'text-emerald-700'
                }`}
              >
                {account.isGroup
                  ? 'يعرض كشف الحساب الإجمالي والتجميعي لكافة الحسابات الفرعية التابعة له.'
                  : 'كشف حساب تفصيلي يوضح الحركات المباشرة المسجلة على هذا الحساب.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="card px-4 py-12 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.date')}</Th>
              <Th>{t('acct.reference')}</Th>
              {account?.isGroup && <Th>الحساب الفرعي</Th>}
              <Th>{t('common.description')}</Th>
              <Th>{t('acct.debit')}</Th>
              <Th>{t('acct.credit')}</Th>
              <Th>{t('acct.balance')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.entryId}-${index}`}>
                <Td className="text-slate-600">{formatDate(row.date, locale)}</Td>
                <Td>
                  <Badge tone="slate">{t(`acct.ref.${row.refType}`)}</Badge>
                  <span className="num ms-2 text-xs font-bold text-slate-700">{row.ref}</span>
                </Td>
                {account?.isGroup && (
                  <Td>
                    <span className="inline-flex items-center gap-1 rounded-md border border-purple-200 bg-purple-50 px-2 py-1 text-xs font-semibold text-purple-800">
                      <span className="num font-bold">{row.subAccountCode}</span>
                      <span>—</span>
                      <span>{row.subAccountName}</span>
                    </span>
                  </Td>
                )}
                <Td className="text-slate-600">{row.description || '—'}</Td>
                <Td>
                  {row.debit > 0 ? <span className="num">{formatMoney(row.debit)}</span> : <span className="text-slate-300">—</span>}
                </Td>
                <Td>
                  {row.credit > 0 ? <span className="num">{formatMoney(row.credit)}</span> : <span className="text-slate-300">—</span>}
                </Td>
                <Td>
                  <span className="num font-bold text-slate-900">{formatMoney(row.balance)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {account && rows.length > 0 && (
        <p className="mt-3 text-sm font-semibold text-slate-600">
          {t('acct.closingBalance')}:{' '}
          <span className="num font-extrabold text-slate-900">{formatMoney(rows.at(-1).balance)}</span>{' '}
          <span className="text-xs text-slate-400">{t('common.currency')}</span>
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  ميزان المراجعة                                                     */
/* ------------------------------------------------------------------ */

const TB_LEVELS = [1, 2, 3, 4, 5]

export function TrialBalance({ balances, lang }) {
  const { t } = useI18n()
  const [level, setLevel] = useState(5)
  const [showZeroBalances, setShowZeroBalances] = useState(true)

  const depthByCode = useMemo(() => {
    const map = new Map()
    const walk = (nodes) => {
      for (const node of nodes) {
        map.set(String(node.code), node.depth)
        walk(node.children ?? [])
      }
    }
    walk(buildTree(balances.map((row) => row.account)))
    return map
  }, [balances])

  const accByCode = useMemo(
    () => new Map(balances.map((row) => [String(row.account.code), row.account])),
    [balances],
  )

  const rows = useMemo(() => {
    const buckets = new Map()
    for (const row of balances) {
      if (row.account.isGroup) continue
      if (!showZeroBalances && row.debit === 0 && row.credit === 0) continue

      /* رُدّ رصيد كل حساب تفصيلي إلى جدّه عند المستوى المطلوب */
      let acc = row.account
      let guard = 0
      while ((depthByCode.get(String(acc.code)) ?? 0) > level - 1 && acc.parentCode && guard < 15) {
        acc = accByCode.get(String(acc.parentCode)) ?? acc
        guard += 1
      }

      const bucket = buckets.get(acc.id) ?? { account: acc, debit: 0, credit: 0 }
      bucket.debit += row.debit
      bucket.credit += row.credit
      buckets.set(acc.id, bucket)
    }

    return [...buckets.values()]
      .map((bucket) => {
        const normal = getNormalBalance(bucket.account)
        const raw = bucket.debit - bucket.credit
        return {
          ...bucket,
          debit: round2(bucket.debit),
          credit: round2(bucket.credit),
          balance: round2(normal === 'debit' ? raw : -raw),
        }
      })
      .sort((a, b) => String(a.account.code).localeCompare(String(b.account.code)))
  }, [balances, level, depthByCode, accByCode, showZeroBalances])

  const totalDebit = rows.reduce((sum, row) => sum + row.debit, 0)
  const totalCredit = rows.reduce((sum, row) => sum + row.credit, 0)
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">{t('acct.level')}</span>
          {TB_LEVELS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setLevel(item)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                level === item ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600'
              }`}
            >
              {item}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-200 cursor-pointer bg-slate-50 dark:bg-slate-800/80 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 select-none">
          <input
            type="checkbox"
            checked={showZeroBalances}
            onChange={(e) => setShowZeroBalances(e.target.checked)}
            className="h-4 w-4 accent-brand-600 rounded"
          />
          <span>عرض جميع الحسابات المعرفة (بما فيها الحسابات الصفرية)</span>
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="card px-4 py-12 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      ) : (
      <TableWrap>
        <thead>
          <tr>
            <Th>{t('acct.code')}</Th>
            <Th>{t('acct.account')}</Th>
            <Th>{t('acct.debit')}</Th>
            <Th>{t('acct.credit')}</Th>
            <Th>{t('acct.balance')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.account.id}>
              <Td>
                <span className="num font-bold text-slate-500">{row.account.code}</span>
              </Td>
              <Td className="font-semibold text-slate-800">{accountLabel(row.account, lang)}</Td>
              <Td>
                <span className="num text-slate-700">{formatMoney(row.debit)}</span>
              </Td>
              <Td>
                <span className="num text-slate-700">{formatMoney(row.credit)}</span>
              </Td>
              <Td>
                <span className="num font-bold text-slate-900">{formatMoney(row.balance)}</span>
              </Td>
            </tr>
          ))}
          <tr className="bg-slate-50">
            <Td />
            <Td className="font-extrabold text-slate-900">{t('common.total')}</Td>
            <Td>
              <span className="num font-extrabold text-slate-900">{formatMoney(totalDebit)}</span>
            </Td>
            <Td>
              <span className="num font-extrabold text-slate-900">{formatMoney(totalCredit)}</span>
            </Td>
            <Td />
          </tr>
        </tbody>
      </TableWrap>
      )}

      <p
        className={`mt-3 rounded-xl px-4 py-3 text-sm font-bold ${
          balanced ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
        }`}
      >
        {balanced ? t('acct.balanced') : t('acct.notBalanced')}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  قائمة الدخل                                                        */
/* ------------------------------------------------------------------ */

export function IncomeStatement({ balances, lang, revenue, expenses, profit }) {
  const { t } = useI18n()

  const revenueRows = balances.filter((row) => row.account.type === 'revenue' && !row.account.isGroup && row.balance !== 0)
  const expenseRows = balances.filter((row) => row.account.type === 'expense' && !row.account.isGroup && row.balance !== 0)

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t('acct.totalRevenue')} value={formatMoney(revenue)} suffix={t('common.currency')} />
        <StatCard
          label={t('acct.totalExpenses')}
          value={formatMoney(expenses)}
          suffix={t('common.currency')}
          tone="text-rose-600 bg-rose-50"
        />
        <StatCard
          label={t('acct.netProfit')}
          value={formatMoney(profit)}
          suffix={t('common.currency')}
          tone={profit >= 0 ? 'text-emerald-600 bg-emerald-50' : 'text-red-600 bg-red-50'}
        />
      </div>

      <StatementSection title={t('acct.type.revenue')} rows={revenueRows} lang={lang} total={revenue} />
      <StatementSection title={t('acct.type.expense')} rows={expenseRows} lang={lang} total={expenses} />

      <div className="card flex items-center justify-between px-5 py-4">
        <span className="text-sm font-extrabold text-slate-900">{t('acct.netProfit')}</span>
        <span className={`num text-xl font-extrabold ${profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
          {formatMoney(profit)}
          <span className="ms-1 text-xs font-semibold text-slate-400">{t('common.currency')}</span>
        </span>
      </div>
    </div>
  )
}

function StatementSection({ title, rows, lang, total }) {
  const { t } = useI18n()

  if (rows.length === 0) {
    return (
      <div>
        <h3 className="mb-2 text-sm font-bold text-slate-900">{title}</h3>
        <p className="card px-4 py-6 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      </div>
    )
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-bold text-slate-900">{title}</h3>
      <TableWrap>
        <thead>
          <tr>
            <Th>{t('acct.account')}</Th>
            <Th>{t('common.amount')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.account.id}>
              <Td>
                <span className="num me-2 text-xs font-bold text-slate-400">{row.account.code}</span>
                <span className="text-slate-700">{accountLabel(row.account, lang)}</span>
              </Td>
              <Td>
                <span className="num font-bold text-slate-800">{formatMoney(row.balance)}</span>
              </Td>
            </tr>
          ))}
          <tr className="bg-slate-50">
            <Td className="font-extrabold text-slate-900">{t('common.total')}</Td>
            <Td>
              <span className="num font-extrabold text-slate-900">{formatMoney(total)}</span>
            </Td>
          </tr>
        </tbody>
      </TableWrap>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  الميزانية العمومية                                                 */
/* ------------------------------------------------------------------ */

export function BalanceSheet({ balances, lang, profit }) {
  const { t } = useI18n()

  const assets = balances.filter((row) => row.account.type === 'asset' && !row.account.isGroup && row.balance !== 0)
  const liabilities = balances.filter(
    (row) => row.account.type === 'liability' && !row.account.isGroup && row.balance !== 0,
  )
  const equity = balances.filter((row) => row.account.type === 'equity' && !row.account.isGroup && row.balance !== 0)

  const assetsTotal = assets.reduce((sum, row) => sum + row.balance, 0)
  const liabilitiesTotal = liabilities.reduce((sum, row) => sum + row.balance, 0)
  const equityTotal = equity.reduce((sum, row) => sum + row.balance, 0) + profit
  const rightSide = liabilitiesTotal + equityTotal
  const balanced = Math.abs(assetsTotal - rightSide) < 0.01

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <StatementSection title={t('acct.type.asset')} rows={assets} lang={lang} total={assetsTotal} />

        <div className="space-y-5">
          <StatementSection title={t('acct.type.liability')} rows={liabilities} lang={lang} total={liabilitiesTotal} />

          <div>
            <h3 className="mb-2 text-sm font-bold text-slate-900">{t('acct.type.equity')}</h3>
            <TableWrap>
              <thead>
                <tr>
                  <Th>{t('acct.account')}</Th>
                  <Th>{t('common.amount')}</Th>
                </tr>
              </thead>
              <tbody>
                {equity.map((row) => (
                  <tr key={row.account.id}>
                    <Td>
                      <span className="num me-2 text-xs font-bold text-slate-400">{row.account.code}</span>
                      <span className="text-slate-700">{accountLabel(row.account, lang)}</span>
                    </Td>
                    <Td>
                      <span className="num font-bold text-slate-800">{formatMoney(row.balance)}</span>
                    </Td>
                  </tr>
                ))}
                <tr>
                  <Td className="text-slate-700">{t('acct.currentProfit')}</Td>
                  <Td>
                    <span className={`num font-bold ${profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {formatMoney(profit)}
                    </span>
                  </Td>
                </tr>
                <tr className="bg-slate-50">
                  <Td className="font-extrabold text-slate-900">{t('common.total')}</Td>
                  <Td>
                    <span className="num font-extrabold text-slate-900">{formatMoney(equityTotal)}</span>
                  </Td>
                </tr>
              </tbody>
            </TableWrap>
          </div>
        </div>
      </div>

      <div
        className={`card flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
          balanced ? '' : 'border-red-200 bg-red-50'
        }`}
      >
        <span className="text-sm font-bold text-slate-700">
          {t('acct.type.asset')}:{' '}
          <span className="num font-extrabold text-slate-900">{formatMoney(assetsTotal)}</span>
        </span>
        <span className="text-sm font-bold text-slate-700">
          {t('acct.liabilitiesPlusEquity')}:{' '}
          <span className="num font-extrabold text-slate-900">{formatMoney(rightSide)}</span>
        </span>
        <span className={`text-sm font-extrabold ${balanced ? 'text-emerald-600' : 'text-red-600'}`}>
          {balanced ? t('acct.balanced') : t('acct.notBalanced')}
        </span>
      </div>
    </div>
  )
}

function FullTreeReportModal({ open, onClose, journal = [], accounts = [], settings = {}, locale, lang }) {
  const { t } = useI18n()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayISO())
  const [q, setQ] = useState('')

  if (!open) return null

  const filteredJournal = journal.filter((entry) => {
    if (!isWithin(entry.date, from, to)) return false
    if (!q.trim()) return true
    const term = q.trim().toLowerCase()
    return (
      entry.ref?.toLowerCase().includes(term) ||
      entry.description?.toLowerCase().includes(term) ||
      entry.lines.some(
        (l) =>
          String(l.code).includes(term) ||
          accountLabel(l.account, lang).toLowerCase().includes(term),
      )
    )
  })

  // Flat list of movements across all journal entries
  const allLines = filteredJournal.flatMap((entry) =>
    entry.lines.map((line) => ({
      date: entry.date,
      ref: entry.ref,
      refType: entry.refType,
      description: entry.description,
      code: line.code,
      accountName: accountLabel(line.account, lang),
      debit: toNumber(line.debit),
      credit: toNumber(line.credit),
    })),
  )

  const totalDebit = round2(allLines.reduce((s, l) => s + l.debit, 0))
  const totalCredit = round2(allLines.reduce((s, l) => s + l.credit, 0))

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="تقرير المعاملات والحركات المحاسبية الشامل لشجرة الحسابات"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button onClick={() => window.print()}>
            <IconFileText className="h-4 w-4 me-1.5 shrink-0 inline" /> طباعة / تصدير PDF
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* التصفية والبحث */}
        <div className="flex flex-wrap items-end justify-between gap-3.5 rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('common.from')} className="w-36">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('common.to')} className="w-36">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="فترة التصفية">
              <div className="flex overflow-hidden rounded-xl border border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => { setFrom(''); setTo(todayISO()); }}
                  className={`border-e border-slate-200 px-3.5 py-2 text-xs font-bold transition ${
                    !from ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  الكل
                </button>
                <button
                  type="button"
                  onClick={() => { setFrom(monthStartISO()); setTo(todayISO()); }}
                  className={`px-3.5 py-2 text-xs font-bold transition ${
                    from === monthStartISO() ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  هذا الشهر
                </button>
              </div>
            </Field>
          </div>

          <Field label="بحث في المعاملات" className="w-64 sm:w-72">
            <SearchInput value={q} onChange={(val) => setQ(val)} placeholder="ابحث بالحساب، المرجع، البيان..." />
          </Field>
        </div>

        {/* الإحصائيات */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard label="إجمالي القيود والمعاملات" value={filteredJournal.length} />
          <StatCard label="إجمالي حركة المدين" value={formatMoney(totalDebit)} suffix="ج.م" tone="text-slate-900" />
          <StatCard label="إجمالي حركة الدائن" value={formatMoney(totalCredit)} suffix="ج.م" tone="text-slate-900" />
        </div>

        {/* الجدول المعروض في الشاشة */}
        {allLines.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">لا توجد معاملات جارية في الفترة المحددة</p>
        ) : (
          <div className="max-h-[450px] overflow-y-auto rounded-xl border border-slate-200">
            <TableWrap>
              <thead>
                <tr>
                  <Th>التاريخ</Th>
                  <Th>رقم المرجع / القيد</Th>
                  <Th>الحساب</Th>
                  <Th>البيان / المعاملة</Th>
                  <Th>مدين</Th>
                  <Th>دائن</Th>
                </tr>
              </thead>
              <tbody>
                {allLines.map((row, idx) => (
                  <tr key={idx} className="transition hover:bg-slate-50/70">
                    <Td className="whitespace-nowrap text-slate-600 font-medium">{formatDate(row.date, locale)}</Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <Badge tone="slate">{t(`acct.ref.${row.refType}`) || row.refType}</Badge>
                        <span className="num text-xs font-bold text-slate-800">{row.ref}</span>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span className="num shrink-0 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-extrabold text-brand-600 border border-brand-100/80">
                          {row.code}
                        </span>
                        <span className="font-semibold text-slate-800">{row.accountName}</span>
                      </div>
                    </Td>
                    <Td className="text-slate-600">{row.description || '—'}</Td>
                    <Td><span className="num font-bold text-slate-900">{row.debit > 0 ? formatMoney(row.debit) : '—'}</span></Td>
                    <Td><span className="num font-bold text-slate-900">{row.credit > 0 ? formatMoney(row.credit) : '—'}</span></Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        )}

        {/* مستند الطباعة والتصدير كـ PDF المخصص كلياً والمعزول عن الشاشة */}
        <PrintDocument>
          <div className="space-y-4 p-4">
            <ReportPrintHeader
              title="تقرير المعاملات والحركات المحاسبية الشامل لشجرة الحسابات"
              subtitle="كشف حركات شامل لكافة الفواتير والدفعات والمصروفات"
              from={from}
              to={to}
            />

            <div className="mb-4 grid grid-cols-3 gap-2 border border-slate-300 p-3 text-center">
              <div>
                <p className="text-[10px] text-slate-500">إجمالي القيود</p>
                <p className="num text-sm font-bold text-slate-900">{filteredJournal.length}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">إجمالي مدين</p>
                <p className="num text-sm font-bold text-slate-900">{formatMoney(totalDebit)} ج.م</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">إجمالي دائن</p>
                <p className="num text-sm font-bold text-slate-900">{formatMoney(totalCredit)} ج.م</p>
              </div>
            </div>

            <table className="w-full text-xs border border-slate-300">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300">
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">المرجع</th>
                  <th className="p-2 text-right">الحساب</th>
                  <th className="p-2 text-right">البيان</th>
                  <th className="p-2 text-right">مدين</th>
                  <th className="p-2 text-right">دائن</th>
                </tr>
              </thead>
              <tbody>
                {allLines.map((row, idx) => (
                  <tr key={idx} className="border-b border-slate-200">
                    <td className="p-2">{formatDate(row.date, locale)}</td>
                    <td className="p-2 font-bold">{row.ref}</td>
                    <td className="p-2 font-semibold">{row.code} - {row.accountName}</td>
                    <td className="p-2">{row.description || '—'}</td>
                    <td className="p-2 font-bold">{row.debit > 0 ? formatMoney(row.debit) : '0.00'}</td>
                    <td className="p-2 font-bold">{row.credit > 0 ? formatMoney(row.credit) : '0.00'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PrintDocument>
      </div>
    </Modal>
  )
}

function AccountStatementModal({ open, account, accounts = [], journal, settings = {}, locale, onClose }) {
  const { t, lang } = useI18n()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayISO())

  if (!open || !account) return null

  const allMovements = accountMovements(journal, account.id, accounts)
  const periodMovements = allMovements.filter((m) => isWithin(m.date, from, to))

  const totalDebit = round2(periodMovements.reduce((s, m) => s + toNumber(m.debit), 0))
  const totalCredit = round2(periodMovements.reduce((s, m) => s + toNumber(m.credit), 0))
  const normal = getNormalBalance(account)
  const netRaw = totalDebit - totalCredit
  const finalBalance = normal === 'debit' ? netRaw : -netRaw

  function handlePrint() {
    window.print()
  }

  const titleText = `${t('acct.statementTitle')} — ${account.code} - ${accountLabel(account, lang)}`

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={titleText}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => exportAccountCSV(account, periodMovements, t, locale, from, to)}
            >
              {t('acct.exportAccountCSV')}
            </Button>
            <Button onClick={handlePrint}>
              طباعة كشف الحساب
            </Button>
          </div>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* تصفية بالتواريخ */}
        <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
          <Field label={t('common.from')} className="w-36">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('common.to')} className="w-36">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="flex overflow-hidden rounded-xl border border-slate-200 bg-white">
            <button
              type="button"
              onClick={() => {
                setFrom('')
                setTo(todayISO())
              }}
              className="border-e border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              {t('acct.allTime')}
            </button>
            <button
              type="button"
              onClick={() => {
                setFrom(monthStartISO())
                setTo(todayISO())
              }}
              className="px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              {t('acct.thisMonth')}
            </button>
          </div>
        </div>

        {/* كروت الإحصائيات */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t('acct.movementsCount')} value={periodMovements.length} />
          <StatCard label={t('acct.debit')} value={formatMoney(totalDebit)} suffix={t('common.currency')} />
          <StatCard label={t('acct.credit')} value={formatMoney(totalCredit)} suffix={t('common.currency')} />
          <StatCard
            label={t('acct.balance')}
            value={formatMoney(finalBalance)}
            suffix={t('common.currency')}
            tone={finalBalance < 0 ? 'text-rose-600 bg-rose-50' : 'text-slate-900 bg-slate-100'}
          />
        </div>

        {/* جدول الحركات للشاشة */}
        {periodMovements.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">{t('acct.noMovements')}</p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                {account.isGroup && <Th>الحساب الفرعي</Th>}
                <Th>{t('acct.reference')}</Th>
                <Th>{t('common.description')}</Th>
                <Th>{t('acct.debit')}</Th>
                <Th>{t('acct.credit')}</Th>
                <Th>{t('acct.balance')}</Th>
              </tr>
            </thead>
            <tbody>
              {periodMovements.map((row, idx) => (
                <tr key={`${row.entryId}-${idx}`}>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                  {account.isGroup && (
                    <Td>
                      <span className="num text-xs font-semibold text-brand-700">
                        {row.subAccountCode} - {row.subAccountName}
                      </span>
                    </Td>
                  )}
                  <Td>
                    <Badge tone="slate">{t(`acct.ref.${row.refType}`) || row.refType}</Badge>
                    <span className="num ms-2 text-xs font-bold text-slate-700">{row.ref}</span>
                  </Td>
                  <Td className="text-slate-700">{row.description || '—'}</Td>
                  <Td>
                    <span className="num font-semibold text-slate-800">
                      {row.debit > 0 ? formatMoney(row.debit) : '—'}
                    </span>
                  </Td>
                  <Td>
                    <span className="num font-semibold text-slate-800">
                      {row.credit > 0 ? formatMoney(row.credit) : '—'}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={`num font-bold ${
                        row.balance < 0 ? 'text-rose-600' : 'text-slate-900'
                      }`}
                    >
                      {formatMoney(row.balance)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}

        {/* منطقة المستند القابل للطباعة النظيفة وتصدير PDF */}
        <PrintDocument>
          <div className="space-y-4 p-4">
            <ReportPrintHeader
              title={titleText}
              subtitle={account.isGroup ? 'كشف حساب تفصيلي شامل لكافة الحركات الفرعية' : ''}
              from={from}
              to={to}
            />

            {/* ملخص الإحصائيات في الطباعة */}
            <div className="mb-4 grid grid-cols-4 gap-2 border border-slate-300 p-3 text-center">
              <div>
                <p className="text-[10px] text-slate-500">{t('acct.movementsCount')}</p>
                <p className="num text-sm font-bold text-slate-900">{periodMovements.length}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">{t('acct.debit')}</p>
                <p className="num text-sm font-bold text-slate-900">{formatMoney(totalDebit)} {t('common.currency')}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">{t('acct.credit')}</p>
                <p className="num text-sm font-bold text-slate-900">{formatMoney(totalCredit)} {t('common.currency')}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">{t('acct.balance')}</p>
                <p className="num text-sm font-bold text-slate-900">{formatMoney(finalBalance)} {t('common.currency')}</p>
              </div>
            </div>

            {periodMovements.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">{t('acct.noMovements')}</p>
            ) : (
              <TableWrap>
                <thead>
                  <tr>
                    <Th>{t('common.date')}</Th>
                    {account.isGroup && <Th>الحساب الفرعي</Th>}
                    <Th>{t('acct.reference')}</Th>
                    <Th>{t('common.description')}</Th>
                    <Th>{t('acct.debit')}</Th>
                    <Th>{t('acct.credit')}</Th>
                    <Th>{t('acct.balance')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {periodMovements.map((row, idx) => (
                    <tr key={`print-${row.entryId}-${idx}`}>
                      <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                      {account.isGroup && (
                        <Td>
                          <span className="num text-xs font-semibold text-slate-900">
                            {row.subAccountCode} - {row.subAccountName}
                          </span>
                        </Td>
                      )}
                      <Td>
                        <span className="num text-xs font-bold text-slate-700">{row.ref || '—'}</span>
                      </Td>
                      <Td className="text-slate-700">{row.description || '—'}</Td>
                      <Td>
                        <span className="num font-semibold text-slate-800">
                          {row.debit > 0 ? formatMoney(row.debit) : '—'}
                        </span>
                      </Td>
                      <Td>
                        <span className="num font-semibold text-slate-800">
                          {row.credit > 0 ? formatMoney(row.credit) : '—'}
                        </span>
                      </Td>
                      <Td>
                        <span
                          className={`num font-bold ${
                            row.balance < 0 ? 'text-rose-600' : 'text-slate-900'
                          }`}
                        >
                          {formatMoney(row.balance)}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </div>
        </PrintDocument>
      </div>
    </Modal>
  )
}

function parseCSVAccounts(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return []
  const firstLine = lines[0]
  const sep = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ','
  const headers = lines[0].split(sep).map((h) => h.trim().replace(/^["']|["']$/g, '').toLowerCase())

  const codeIdx = headers.findIndex((h) => h.includes('code') || h.includes('كود') || h.includes('الكود'))
  const nameIdx = headers.findIndex((h) => h.includes('name') || h.includes('اسم') || h.includes('الاسم'))
  const typeIdx = headers.findIndex((h) => h.includes('type') || h.includes('نوع') || h.includes('النوع'))
  const parentIdx = headers.findIndex((h) => h.includes('parent') || h.includes('أب') || h.includes('الأب'))

  const items = []
  const startRow = codeIdx !== -1 || nameIdx !== -1 ? 1 : 0

  for (let i = startRow; i < lines.length; i += 1) {
    const cols = lines[i].split(sep).map((c) => c.trim().replace(/^["']|["']$/g, ''))
    if (cols.length === 0 || !cols.some(Boolean)) continue

    const code = codeIdx !== -1 ? cols[codeIdx] : cols[0]
    const name = nameIdx !== -1 ? cols[nameIdx] : cols[1]
    const typeVal = typeIdx !== -1 ? cols[typeIdx] : cols[2] || 'expense'
    const parentCode = parentIdx !== -1 ? cols[parentIdx] : cols[3] || ''

    if (code && name) {
      items.push({
        code: String(code).trim(),
        name: String(name).trim(),
        type: ['asset', 'liability', 'equity', 'revenue', 'expense'].includes(typeVal?.toLowerCase()) ? typeVal.toLowerCase() : 'expense',
        parentCode: parentCode ? String(parentCode).trim() : null,
      })
    }
  }
  return items
}

function AccountImportModal({ open, onClose, cleanAccounts = [] }) {
  const [activeTab, setActiveTab] = useState('csv')
  const [fileData, setFileData] = useState([])
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [successMsg, setSuccessMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!open) {
      setFileData([])
      setFileName('')
      setSuccessMsg('')
      setErrorMsg('')
      setBusy(false)
    }
  }, [open])

  if (!open) return null

  function handleFileUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setErrorMsg('')
    setSuccessMsg('')

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const text = event.target?.result || ''
        const parsed = parseCSVAccounts(text)
        if (parsed.length === 0) {
          setErrorMsg('لم يتم العثور على أسطر حسابات صالحة في الملف.')
          setFileData([])
        } else {
          setFileData(parsed)
        }
      } catch (err) {
        setErrorMsg('حدث خطأ أثناء قراءة الملف. يرجى التأكد من اختيار ملف CSV صالح.')
      }
    }
    reader.readAsText(file, 'UTF-8')
  }

  async function handleImportCSV() {
    if (fileData.length === 0) return
    setBusy(true)
    setErrorMsg('')
    try {
      const existingByCode = new Map(cleanAccounts.map((a) => [String(a.code), a]))
      let createdCount = 0
      let updatedCount = 0

      for (const item of fileData) {
        const existing = existingByCode.get(String(item.code))
        const payload = {
          code: item.code,
          name: item.name,
          type: item.type || 'expense',
          isGroup: Boolean(item.isGroup),
          parentCode: item.parentCode || null,
          archived: false,
        }
        if (existing?.id) {
          await updateDocById(ACCOUNTS_COL, existing.id, payload)
          updatedCount += 1
        } else {
          await createDoc(ACCOUNTS_COL, payload)
          createdCount += 1
        }
      }

      setSuccessMsg(`تم استيراد الحسابات بنجاح! (${createdCount} حساب جديد، ${updatedCount} حساب تم تحديثه)`)
    } catch (err) {
      setErrorMsg('حدث خطأ أثناء حفظ الحسابات في قاعدة البيانات.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRestoreDefaults() {
    setBusy(true)
    setErrorMsg('')
    try {
      const restoredCount = await seedMissingAccounts(cleanAccounts)
      setSuccessMsg(
        restoredCount > 0
          ? `تم استرداد واكتمال ${restoredCount} حساب افتراضي بالنظام بنجاح!`
          : 'جميع حسابات النظام الافتراضية مكتملة وموجودة بالفعل!',
      )
    } catch (err) {
      setErrorMsg('حدث خطأ أثناء استرداد الحسابات الافتراضية.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="استيراد واسترداد شجرة الحسابات"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {activeTab === 'csv' && fileData.length > 0 && (
            <Button onClick={handleImportCSV} disabled={busy}>
              {busy ? 'جاري الاستيراد...' : `تأكيد استيراد ${fileData.length} حساب`}
            </Button>
          )}
          {activeTab === 'defaults' && (
            <Button onClick={handleRestoreDefaults} disabled={busy}>
              {busy ? 'جاري الاسترداد...' : 'استرداد الحسابات الافتراضية'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* التبويبات */}
        <div className="flex border-b border-slate-200">
          <button
            type="button"
            onClick={() => setActiveTab('csv')}
            className={`border-b-2 px-4 py-2.5 text-xs font-bold transition ${
              activeTab === 'csv'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            📥 استيراد من ملف CSV / Excel
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('defaults')}
            className={`border-b-2 px-4 py-2.5 text-xs font-bold transition ${
              activeTab === 'defaults'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            🔄 استرداد الحسابات الافتراضية
          </button>
        </div>

        {successMsg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-bold text-emerald-800">
            {successMsg}
          </div>
        )}

        {errorMsg && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-800">
            {errorMsg}
          </div>
        )}

        {activeTab === 'csv' && (
          <div className="space-y-4">
            <div className="rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center hover:border-brand-300 bg-slate-50/50">
              <IconImport className="mx-auto h-8 w-8 text-slate-400 mb-2" />
              <p className="text-xs font-bold text-slate-700 mb-1">اختر ملف CSV يحتوي على الحسابات المراد استيرادها</p>
              <p className="text-[11px] text-slate-400 mb-3">الأعمدة المطلوبة: الكود، الاسم، النوع (asset/liability/equity/revenue/expense)، كود الأب</p>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700">
                <span>{fileName ? `الملف المحدد: ${fileName}` : 'رفع ملف CSV'}</span>
                <input type="file" accept=".csv,.txt" className="hidden" onChange={handleFileUpload} />
              </label>
            </div>

            {fileData.length > 0 && (
              <div>
                <p className="text-xs font-bold text-slate-700 mb-2">معاينة الحسابات في الملف ({fileData.length} حساب):</p>
                <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200">
                  <TableWrap>
                    <thead>
                      <tr>
                        <Th>الكود</Th>
                        <Th>اسم الحساب</Th>
                        <Th>النوع</Th>
                        <Th>الكود الأب</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {fileData.map((row, idx) => (
                        <tr key={idx}>
                          <Td className="font-bold">{row.code}</Td>
                          <Td>{row.name}</Td>
                          <Td>{row.type}</Td>
                          <Td>{row.parentCode || '—'}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableWrap>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'defaults' && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5 space-y-3">
            <h4 className="text-sm font-extrabold text-slate-900">استرداد واكتمال حسابات النظام الافتراضية</h4>
            <p className="text-xs leading-relaxed text-slate-600">
              يقوم هذا الخيار بفحص شجرة الحسابات واسترداد أي حسابات نظام أساسية ناقصة مع ربط الأدوار الوظيفية المحاسبية دون حذف أو تعديل أي من حساباتك الخاصة الحالية.
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}
