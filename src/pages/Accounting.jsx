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
  buildCleanAccounts,
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
import { accountBalances, accountMovements, buildJournal, getMovementDocUrl } from '../lib/ledger'
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
  IconCheck,
  IconChevronDown,
  IconExport,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconGrid,
  IconImport,
  IconLayers,
  IconList,
  IconPencil,
  IconPlus,
  IconScale,
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
  const { rows: purchaseInvoices } = useCollection('purchaseInvoices', 'date', 'desc')
  const { rows: vendorPayments } = useCollection('vendorPayments', 'date', 'desc')
  const { rows: accountingTransactions } = useCollection(COL.accountingTransactions, 'transactionDate', 'desc')

  useEffect(() => {
    console.log('[Accounting Diagnostic Logs]:', {
      accountsCount: accounts.length,
      loadingAccounts,
      errorAccounts,
      invoicesCount: invoices.length,
      expensesCount: expenses.length,
      paymentsCount: payments.length,
      purchaseInvoicesCount: purchaseInvoices.length,
      accountingTransactionsCount: accountingTransactions.length,
    })
  }, [accounts, loadingAccounts, errorAccounts, invoices, expenses, payments, purchaseInvoices, accountingTransactions])

  const { view } = useParams()
  const isJournal = view === 'journal'
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayISO())
  const [seeding, setSeeding] = useState(false)
  const [jq, setJq] = useState('')

  const [showFullReportModal, setShowFullReportModal] = useState(false)

  /* أرقام الفواتير وأسماء العملاء للدفعات، لتظهر في القيود وكشوف الحساب */
  const enrichedPayments = useMemo(() => {
    const invoiceMap = new Map(invoices.map((invoice) => [invoice.id, invoice]))
    return payments.map((payment) => {
      const inv = invoiceMap.get(payment.invoiceId)
      return {
        ...payment,
        invoiceNumber: payment.invoiceNumber || inv?.number || '',
        clientName: payment.clientName || inv?.clientName || '',
      }
    })
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
        accountingTransactions,
        clients,
        purchaseInvoices,
        vendorPayments,
        settings,
      }),
    [
      invoices,
      enrichedPayments,
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
      accountingTransactions,
      clients,
      purchaseInvoices,
      vendorPayments,
      settings,
    ],
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
      [entry.ref, entry.description, formatRefType(entry.refType, t), ...entry.lines.map((line) => accountLabel(line.account, lang))]
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
        : (
          <AccountTree
            accounts={accounts}
            cleanAccounts={cleanAccounts}
            clients={clients}
            employees={employees}
            vendors={vendors}
            balances={balances}
            journal={journal}
            settings={settings}
            invoices={invoices}
            lang={lang}
            locale={locale}
          />
        )}

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
                    <Badge tone="slate">{formatRefType(row.refType, t)}</Badge>
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

export function formatRefType(refType, t) {
  if (!refType) return '—'
  const key = `acct.ref.${refType}`
  const translated = typeof t === 'function' ? t(key) : key
  if (translated && !translated.startsWith('acct.ref.')) return translated

  const map = {
    purchaseInvoice: 'فاتورة مشتريات',
    vendorPayment: 'سداد مورد',
    vendorAdvance: 'دفعة مقدمة لمورد',
    purchaseReturn: 'مردودات مشتريات',
    vendorAdvanceApp: 'تسوية دفعة مقدمة',
    invoice: 'فاتورة',
    payment: 'تحصيل',
    expense: 'مصروف',
    cost: 'تكلفة شغل',
    jobCosts: 'تكلفة أمر عمل',
    creditNote: 'إشعار خصم',
    manual: 'قيد يدوي',
    employee_salary: 'راتب موظف',
    employee_advance_recovery: 'استرداد سلفة',
    payrollRun: 'مسير رواتب',
    invoice_item_cost: 'تكلفة بند فاتورة',
    asset: 'شراء أصل/معدة',
    depreciation: 'إهلاك',
    maintenance: 'صيانة',
  }
  return map[refType] || refType
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
    ? ['التاريخ', 'كود الحساب الفرعي', 'اسم الحساب الفرعي', 'نوع المستند', 'رقم المستند / الفاتورة', 'العميل / الطرف المعني', 'البيان / الوصف', 'مدين (SAR)', 'دائن (SAR)', 'الرصيد التراكمي (SAR)']
    : ['التاريخ', 'نوع المستند', 'رقم المستند / الفاتورة', 'العميل / الطرف المعني', 'البيان / الوصف', 'مدين (SAR)', 'دائن (SAR)', 'الرصيد التراكمي (SAR)']

  const totalDebit = round2(movements.reduce((s, m) => s + toNumber(m.debit), 0))
  const totalCredit = round2(movements.reduce((s, m) => s + toNumber(m.credit), 0))
  const finalBalance = movements.length > 0 ? movements.at(-1).balance : 0

  const rows = movements.map((m) => {
    const docNum = m.invoiceNumber || m.ref || '—'
    const party = m.clientName || m.vendorName || m.partyName || m.subLedgerName || '—'
    const base = [
      formatDate(m.date, locale),
      formatRefType(m.refType, t),
      docNum,
      party,
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
    ? ['المجموع الإجمالي', '—', '—', '—', '—', '—', 'إجمالي الفترة', totalDebit, totalCredit, finalBalance]
    : ['المجموع الإجمالي', '—', '—', '—', 'إجمالي الفترة', totalDebit, totalCredit, finalBalance]

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



export const DaftraFolderIcon = ({ className = 'w-7 h-7 sm:w-8 sm:h-8' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.5 21a3 3 0 0 0 3-3v-9a3 3 0 0 0-3-3h-5.379a.75.75 0 0 1-.53-.22L11.47 3.66A2.25 2.25 0 0 0 9.879 3H4.5A3 3 0 0 0 1.5 6v12a3 3 0 0 0 3 3h15Z" />
  </svg>
)

export const DaftraDocIcon = ({ className = 'w-6 h-6' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 13.5h6m-6 3h4" />
  </svg>
)

function DaftraTreeItem({
  node,
  expanded,
  toggle,
  currentParentCode,
  onNavigate,
  lang,
  rolled,
  childCount,
  level = 1,
}) {
  const code = String(node.code)
  const isGroup = node.isGroup || (node.children && node.children.length > 0)
  const isOpen = expanded.has(code)
  const isCurrent = currentParentCode === code

  return (
    <div className="select-none text-xs">
      <div
        onClick={() => onNavigate(node)}
        className={`flex items-center gap-1.5 py-1.5 px-2 rounded-lg cursor-pointer transition ${
          isCurrent
            ? 'bg-sky-100 dark:bg-sky-950/80 text-sky-800 dark:text-sky-200 font-bold'
            : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/60'
        }`}
        style={{ paddingInlineStart: `${(level - 1) * 14 + 8}px` }}
      >
        {isGroup ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              toggle(code)
            }}
            className="w-4 h-4 shrink-0 grid place-items-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <svg
              className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-90 text-sky-600' : 'rtl:-rotate-180'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {isGroup ? (
          <svg className="w-4 h-4 shrink-0 text-sky-600 dark:text-sky-400" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.5 21a3 3 0 0 0 3-3v-9a3 3 0 0 0-3-3h-5.379a.75.75 0 0 1-.53-.22L11.47 3.66A2.25 2.25 0 0 0 9.879 3H4.5A3 3 0 0 0 1.5 6v12a3 3 0 0 0 3 3h15Z" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          </svg>
        )}

        <span className={`truncate ${level === 1 ? 'font-bold text-slate-900 dark:text-white' : ''}`}>
          {accountLabel(node, lang)}
        </span>
      </div>

      {isGroup && isOpen && node.children && node.children.length > 0 && (
        <div className="relative border-r border-slate-200/80 dark:border-slate-800/80 mr-3.5">
          {node.children.map((child) => (
            <DaftraTreeItem
              key={child.id}
              node={child}
              expanded={expanded}
              toggle={toggle}
              currentParentCode={currentParentCode}
              onNavigate={onNavigate}
              lang={lang}
              rolled={rolled}
              childCount={childCount}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DaftraAccountRow({
  account,
  onDrillDown,
  onOpenStatement,
  onAddChild,
  onEdit,
  onDelete,
  openMenuId,
  setOpenMenuId,
  lang,
  rolled,
  balanceById,
  childCount,
}) {
  const code = String(account.code)
  const isGroup = account.isGroup || (childCount?.get(code) ?? 0) > 0
  const bal = rolled.get(account.id)
  const ownBal = balanceById.get(account.id)
  const balanceValue = bal ? bal.balance : (ownBal?.balance ?? 0)
  const normalBal = getNormalBalance(account)
  const isOpenMenu = openMenuId === account.id

  const handleClick = () => {
    if (isGroup) {
      onDrillDown(account)
    } else {
      onOpenStatement(account)
    }
  }

  return (
    <div
      onClick={handleClick}
      className="flex items-center justify-between py-4 px-4 sm:px-6 border-b border-slate-200/80 dark:border-slate-800 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition group cursor-pointer select-none"
    >
      {/* Right Side (in RTL): Big Blue Folder Icon + Title & #Code */}
      <div className="flex items-center gap-4 min-w-0 flex-1">
        {isGroup ? (
          <div className="w-10 h-10 sm:w-11 sm:h-11 shrink-0 grid place-items-center rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 group-hover:scale-105 transition">
            <DaftraFolderIcon />
          </div>
        ) : (
          <div className="w-10 h-10 sm:w-11 sm:h-11 shrink-0 grid place-items-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 group-hover:scale-105 transition">
            <DaftraDocIcon />
          </div>
        )}

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-base sm:text-lg font-bold text-slate-800 dark:text-white group-hover:text-sky-600 dark:group-hover:text-sky-400 transition truncate">
              {accountLabel(account, lang)}
            </h4>
            {account.isClientNode && (
              <span className="px-1.5 py-0.2 rounded bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300 text-[10px] font-bold border border-teal-200 dark:border-teal-800">
                عميل
              </span>
            )}
            {account.isVendorNode && (
              <span className="px-1.5 py-0.2 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 text-[10px] font-bold border border-amber-200 dark:border-amber-800">
                مورد
              </span>
            )}
            {account.id?.startsWith('emp-') && (
              <span className="px-1.5 py-0.2 rounded bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 text-[10px] font-bold border border-purple-200 dark:border-purple-800">
                موظف
              </span>
            )}
          </div>
          <p className="text-xs font-mono font-medium text-slate-400 dark:text-slate-500 mt-0.5">
            #{account.code}
          </p>
        </div>
      </div>

      {/* Middle: Big Balance + Nature (مدين/دائن) */}
      <div className="text-center px-4 sm:px-8 shrink-0">
        <div className="text-lg sm:text-xl font-bold font-mono text-slate-800 dark:text-slate-100 tabular-nums">
          {formatMoney(balanceValue)}
        </div>
        <div className="text-xs font-medium text-slate-400 dark:text-slate-500 mt-0.5">
          {normalBal === 'debit' ? 'مدين' : 'دائن'}
        </div>
      </div>

      {/* Left Side: Square Action Button [▼] with Popup Menu */}
      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setOpenMenuId(isOpenMenu ? null : account.id)}
          className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 grid place-items-center transition border border-slate-200/60 dark:border-slate-700 shadow-2xs"
          title="خيارات الحساب"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 16l-6-6h12l-6 6z" />
          </svg>
        </button>

        {isOpenMenu && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setOpenMenuId(null)}
            />
            <div className="absolute left-0 mt-1 w-48 rounded-xl bg-white dark:bg-slate-800 shadow-xl border border-slate-200 dark:border-slate-700 py-1.5 z-50 text-xs font-bold text-slate-700 dark:text-slate-200 animate-in fade-in zoom-in-95">
              {isGroup && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null)
                    onAddChild(account)
                  }}
                  className="w-full text-start px-3.5 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-2 text-emerald-600 dark:text-emerald-400"
                >
                  <IconPlus className="w-3.5 h-3.5" />
                  <span>إضافة حساب فرعي</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setOpenMenuId(null)
                  onOpenStatement(account)
                }}
                className="w-full text-start px-3.5 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <IconFileText className="w-3.5 h-3.5 text-slate-400" />
                <span>عرض كشف الحساب</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenMenuId(null)
                  onEdit(account)
                }}
                className="w-full text-start px-3.5 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <IconPencil className="w-3.5 h-3.5 text-slate-400" />
                <span>تعديل الحساب</span>
              </button>
              {!account.role && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null)
                    onDelete(account)
                  }}
                  className="w-full text-start px-3.5 py-2 hover:bg-red-50 dark:hover:bg-red-950/50 flex items-center gap-2 text-red-600 dark:text-red-400 border-t border-slate-100 dark:border-slate-700 mt-1"
                >
                  <IconTrash className="w-3.5 h-3.5" />
                  <span>حذف الحساب</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export { buildCleanAccounts } from '../lib/accounts'

function AccountTree({ accounts, cleanAccounts: cleanAccountsProp, clients = [], employees = [], vendors = [], balances = [], journal = [], settings = {}, invoices = [], lang, locale }) {
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
  const [currentParentCode, setCurrentParentCode] = useState(null)
  const [openActionMenuId, setOpenActionMenuId] = useState(null)
  const [treeSearch, setTreeSearch] = useState('')
  const [viewMode, setViewMode] = useState('daftra') // 'daftra' | 'table'
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
        next.add(codeStr)
      }
      return next
    })
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
  const treeTerm = treeSearch.trim().toLowerCase()

  const filteredTreeNodes = useMemo(() => {
    if (!treeTerm) return treeNodes
    const filterRec = (list) => {
      const res = []
      for (const node of list) {
        const matchSelf =
          String(node.code).includes(treeTerm) ||
          accountLabel(node, lang).toLowerCase().includes(treeTerm) ||
          (node.nameEn ?? '').toLowerCase().includes(treeTerm)
        const sub = node.children ? filterRec(node.children) : []
        if (matchSelf || sub.length > 0) {
          res.push({ ...node, children: sub.length > 0 ? sub : node.children })
        }
      }
      return res
    }
    return filterRec(treeNodes)
  }, [treeNodes, treeTerm, lang])

  const breadcrumbs = useMemo(() => {
    const list = [{ code: null, name: 'دليل الحسابات' }]
    if (!currentParentCode) return list
    const chain = []
    let curr = byCode.get(String(currentParentCode))
    const visited = new Set()
    while (curr) {
      const c = String(curr.code)
      if (visited.has(c)) break
      visited.add(c)
      chain.unshift({ code: c, name: accountLabel(curr, lang) })
      curr = curr.parentCode ? byCode.get(String(curr.parentCode)) : null
    }
    return [...list, ...chain]
  }, [currentParentCode, byCode, lang])

  const daftraItems = useMemo(() => {
    if (term) {
      return nodes.filter(
        (a) =>
          String(a.code).includes(term) ||
          accountLabel(a, lang).toLowerCase().includes(term) ||
          (a.nameEn ?? '').toLowerCase().includes(term),
      )
    }
    if (!currentParentCode) {
      return cleanAccounts
        .filter((a) => !a.parentCode || String(a.code).length === 1 || a.level === 1)
        .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }))
    }
    return cleanAccounts
      .filter((a) => String(a.parentCode) === String(currentParentCode))
      .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }))
  }, [term, currentParentCode, cleanAccounts, nodes, lang])

  const rootBalances = useMemo(() => {
    const getBal = (code) => {
      const acc = cleanAccounts.find((a) => String(a.code) === String(code) && (!a.parentCode || a.parentCode === null)) ||
        cleanAccounts.find((a) => String(a.code) === String(code))
      if (!acc) return 0
      return rolled.get(acc.id)?.balance || 0
    }
    return {
      assets: getBal('1'),
      liabilities: getBal('2'),
      equity: getBal('3'),
      revenue: getBal('4') + getBal('7'),
      expenses: getBal('5') + getBal('6') + getBal('8'),
    }
  }, [cleanAccounts, rolled])

  const trialBalanceEq = useMemo(() => {
    const assets = rootBalances.assets
    const liabilities = rootBalances.liabilities
    const equity = rootBalances.equity
    const revenue = rootBalances.revenue
    const expenses = rootBalances.expenses

    const debitSide = round2(assets + expenses)
    const creditSide = round2(liabilities + equity + revenue)
    const diff = round2(Math.abs(debitSide - creditSide))
    const isBalanced = diff < 0.05

    return {
      assets,
      liabilities,
      equity,
      revenue,
      expenses,
      debitSide,
      creditSide,
      diff,
      isBalanced,
    }
  }, [rootBalances])

  // Pagination for full table mode
  const pageSize = 15
  const tableItems = useMemo(() => {
    if (term) {
      return nodes.filter(
        (a) =>
          String(a.code).includes(term) ||
          accountLabel(a, lang).toLowerCase().includes(term) ||
          (a.nameEn ?? '').toLowerCase().includes(term),
      )
    }
    return nodes
  }, [nodes, term, lang])

  const totalPages = Math.max(1, Math.ceil(tableItems.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedItems = useMemo(
    () => tableItems.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [tableItems, currentPage, pageSize],
  )

  function getLevelBadge(account) {
    if (account.isClientNode) {
      return (
        <span className="inline-flex items-center rounded-md border border-teal-300 bg-teal-50 dark:bg-teal-950/40 dark:border-teal-800 px-2 py-0.5 text-xs font-black text-teal-700 dark:text-teal-300 shadow-2xs">
          عميل
        </span>
      )
    }
    if (account.isVendorNode) {
      return (
        <span className="inline-flex items-center rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 px-2 py-0.5 text-xs font-black text-amber-700 dark:text-amber-300 shadow-2xs">
          مورد
        </span>
      )
    }
    if (account.id?.startsWith('emp-payable-')) {
      return (
        <span className="inline-flex items-center rounded-md border border-rose-300 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800 px-2 py-0.5 text-xs font-black text-rose-700 dark:text-rose-300 shadow-2xs">
          مستحقات موظف
        </span>
      )
    }
    if (account.id?.startsWith('emp-advance-')) {
      return (
        <span className="inline-flex items-center rounded-md border border-sky-300 bg-sky-50 dark:bg-sky-950/40 dark:border-sky-800 px-2 py-0.5 text-xs font-black text-sky-700 dark:text-sky-300 shadow-2xs">
          سلفة موظف
        </span>
      )
    }

    const lvl = account.level || (account.depth !== undefined ? account.depth + 1 : (account.code ? String(account.code).split('-').length : 1))
    switch (lvl) {
      case 1:
        return (
          <span className="inline-flex items-center rounded-md border border-sky-300 bg-sky-50 dark:bg-sky-950/50 dark:border-sky-800 px-2 py-0.5 text-xs font-black text-sky-700 dark:text-sky-300 shadow-2xs">
            م1 رئيسي
          </span>
        )
      case 2:
        return (
          <span className="inline-flex items-center rounded-md border border-indigo-300 bg-indigo-50 dark:bg-indigo-950/50 dark:border-indigo-800 px-2 py-0.5 text-xs font-bold text-indigo-700 dark:text-indigo-300 shadow-2xs">
            م2 مجموعة
          </span>
        )
      case 3:
        return (
          <span className="inline-flex items-center rounded-md border border-purple-300 bg-purple-50 dark:bg-purple-950/50 dark:border-purple-800 px-2 py-0.5 text-xs font-bold text-purple-700 dark:text-purple-300 shadow-2xs">
            م3 عام
          </span>
        )
      case 4:
        return (
          <span className="inline-flex items-center rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/50 dark:border-amber-800 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300 shadow-2xs">
            م4 فرعي
          </span>
        )
      case 5:
        return (
          <span className="inline-flex items-center rounded-md border border-teal-300 bg-teal-50 dark:bg-teal-950/50 dark:border-teal-800 px-2 py-0.5 text-xs font-semibold text-teal-700 dark:text-teal-300 shadow-2xs">
            م5 تفصيلي
          </span>
        )
      case 6:
      default:
        return (
          <span className="inline-flex items-center rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 dark:border-emerald-800 px-2 py-0.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 shadow-2xs">
            م6 تحليلي
          </span>
        )
    }
  }

  return (
    <div className="space-y-4">
      {/* Top Header Controls Bar */}
      <div className="card p-4 flex flex-wrap items-center justify-between gap-4 border border-slate-200/90 dark:border-slate-800 shadow-xs bg-white dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 shadow-xs">
            <IconFolder className="h-5 w-5 shrink-0" />
          </div>
          <div>
            <h2 className="text-base font-black text-slate-900 dark:text-white">دليل الحسابات</h2>
            <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400 font-semibold">
              <span>إجمالي الحسابات: {cleanAccounts.length}</span>
              <span>•</span>
              <span className={trialBalanceEq.isBalanced ? 'text-emerald-600 font-bold' : 'text-amber-600 font-bold'}>
                {trialBalanceEq.isBalanced ? '✓ ميزان المراجعة متزن' : '⚠️ بحاجة لتسوية'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="min-w-[220px]">
            <SearchInput
              value={q}
              onChange={(val) => {
                setQ(val)
                setPage(1)
              }}
              placeholder="ابحث بالاسم أو الكود..."
            />
          </div>

          {/* View Toggle */}
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl border border-slate-200/80 dark:border-slate-700 text-xs font-bold">
            <button
              type="button"
              onClick={() => setViewMode('daftra')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition ${
                viewMode === 'daftra'
                  ? 'bg-white dark:bg-slate-700 text-sky-600 dark:text-white shadow-xs font-extrabold'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900'
              }`}
            >
              <IconGrid className="h-4 w-4" />
              <span>بطاقات دفترة</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition ${
                viewMode === 'table'
                  ? 'bg-white dark:bg-slate-700 text-sky-600 dark:text-white shadow-xs font-extrabold'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900'
              }`}
            >
              <IconList className="h-4 w-4" />
              <span>الجدول التفصيلي</span>
            </button>
          </div>

          <Button variant="ghost" onClick={() => exportTreeCSV(cleanAccounts, rolled, t, lang)}>
            <IconExport className="h-4 w-4 me-1.5 shrink-0 inline" /> تصدير CSV
          </Button>

          <Button variant="ghost" onClick={() => setShowImportModal(true)}>
            <IconImport className="h-4 w-4 me-1.5 shrink-0 inline" /> استيراد
          </Button>

          <Button onClick={() => setEditing({ presetParentCode: currentParentCode || undefined })}>
            <IconPlus className="h-4 w-4 me-1 shrink-0 inline" /> + أضف حساب
          </Button>
        </div>
      </div>

      {/* Main View: Daftra Split Card (Tree on Right, Cards on Left) */}
      {viewMode === 'daftra' ? (
        <div className="card overflow-hidden border border-slate-200/90 dark:border-slate-800 shadow-xs bg-white dark:bg-slate-900">
          <div className="flex flex-col lg:flex-row items-stretch">
            {/* Right Column (in RTL): The Tree Explorer Pane */}
            <div className="w-full lg:w-80 xl:w-96 border-b lg:border-b-0 lg:border-e border-slate-200/90 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/40 p-4 shrink-0 flex flex-col">
              {/* Search in tree */}
              <div className="mb-3">
                <div className="relative">
                  <input
                    type="text"
                    value={treeSearch}
                    onChange={(e) => setTreeSearch(e.target.value)}
                    placeholder="بحث في الشجرة..."
                    className="w-full h-8.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-8 text-xs font-semibold text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none transition"
                  />
                  <div className="absolute right-2.5 top-2 text-slate-400">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </div>
                  {treeSearch && (
                    <button
                      type="button"
                      onClick={() => setTreeSearch('')}
                      className="absolute left-2.5 top-2 text-slate-400 hover:text-slate-600 text-xs font-bold"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Tree Nodes List */}
              <div className="max-h-[680px] overflow-y-auto space-y-0.5 scrollbar-thin flex-1 pe-1">
                {filteredTreeNodes.map((node) => (
                  <DaftraTreeItem
                    key={node.id}
                    node={node}
                    expanded={expanded}
                    toggle={toggle}
                    currentParentCode={currentParentCode}
                    onNavigate={(acc) => {
                      if (acc.isGroup || (childCount.get(String(acc.code)) ?? 0) > 0) {
                        setCurrentParentCode(String(acc.code))
                        setExpanded((prev) => new Set([...prev, String(acc.code)]))
                      } else {
                        setStatementAccount(acc)
                      }
                    }}
                    lang={lang}
                    rolled={rolled}
                    childCount={childCount}
                    level={1}
                  />
                ))}
              </div>
            </div>

            {/* Left Column (in RTL): The Accounts Cards List (Main Pane) */}
            <div className="flex-1 p-5 sm:p-7 flex flex-col justify-between min-w-0">
              <div>
                {/* Breadcrumbs Header */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 dark:border-slate-800 pb-4 mb-2">
                  <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 font-semibold flex-wrap">
                    {breadcrumbs.map((crumb, idx) => {
                      const isLast = idx === breadcrumbs.length - 1
                      return (
                        <div key={idx} className="flex items-center gap-2">
                          {idx > 0 && <span className="text-slate-300 dark:text-slate-600 font-bold">›</span>}
                          <button
                            type="button"
                            disabled={isLast}
                            onClick={() => setCurrentParentCode(crumb.code)}
                            className={`transition ${
                              isLast
                                ? 'text-slate-900 dark:text-white font-bold cursor-default'
                                : 'text-sky-600 dark:text-sky-400 hover:underline cursor-pointer'
                            }`}
                          >
                            {crumb.name}
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  {currentParentCode && (
                    <button
                      type="button"
                      onClick={() => {
                        const parent = byCode.get(String(currentParentCode))
                        setCurrentParentCode(parent?.parentCode ? String(parent.parentCode) : null)
                      }}
                      className="text-xs font-bold text-sky-600 hover:text-sky-700 dark:text-sky-400 flex items-center gap-1 transition"
                    >
                      <span>‹ الرجوع للمستوى السابق</span>
                    </button>
                  )}
                </div>

                {/* Account Rows List */}
                {daftraItems.length === 0 ? (
                  <div className="text-center py-16 px-4 space-y-3">
                    <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 grid place-items-center mx-auto">
                      <IconFolder className="w-6 h-6" />
                    </div>
                    <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                      {q ? 'لا توجد نتائج مطابقة لبحثك' : 'لا توجد حسابات فرعية مسجلة بداخل هذا الحساب'}
                    </p>
                    <Button
                      size="sm"
                      onClick={() => setEditing({ presetParentCode: currentParentCode || undefined })}
                      className="text-xs font-bold"
                    >
                      + أضف حساب فرعي الآن
                    </Button>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {daftraItems.map((account) => (
                      <DaftraAccountRow
                        key={account.id}
                        account={account}
                        onDrillDown={(acc) => {
                          setCurrentParentCode(String(acc.code))
                          setExpanded((prev) => new Set([...prev, String(acc.code)]))
                        }}
                        onOpenStatement={(acc) => setStatementAccount(acc)}
                        onAddChild={(acc) => setEditing({ presetParentCode: acc.code })}
                        onEdit={(acc) => setEditing(acc)}
                        onDelete={(acc) => setRemoving(acc)}
                        openMenuId={openActionMenuId}
                        setOpenMenuId={setOpenActionMenuId}
                        lang={lang}
                        rolled={rolled}
                        balanceById={balanceById}
                        childCount={childCount}
                      />
                    ))}
                  </div>
                )}

                {/* Bottom "+ أضف حساب" Button */}
                <div className="pt-5 px-4 sm:px-6">
                  <button
                    type="button"
                    onClick={() => setEditing({ presetParentCode: currentParentCode || undefined })}
                    className="inline-flex items-center gap-2 text-sm font-bold text-sky-600 hover:text-sky-700 dark:text-sky-400 transition"
                  >
                    <div className="w-5 h-5 rounded bg-sky-100 dark:bg-sky-950/80 text-sky-600 dark:text-sky-400 grid place-items-center text-xs font-black">
                      +
                    </div>
                    <span>أضف حساب</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Full Data Table Mode */
        <div className="card overflow-hidden border border-slate-200/90 dark:border-slate-800 shadow-xs">
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-28">الكود</Th>
                <Th>اسم الحساب</Th>
                <Th className="w-20">الطبيعة</Th>
                <Th className="w-20">نوع القيد</Th>
                <Th className="text-end w-32">مدين</Th>
                <Th className="text-end w-32">دائن</Th>
                <Th className="text-end w-36">الرصيد</Th>
                <Th className="w-24 text-center">الإجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {pagedItems.map((account) => {
                const bal = rolled.get(account.id)
                const ownBal = balanceById.get(account.id)
                const balanceValue = bal ? bal.balance : 0
                const debitValue = bal ? bal.debit : (ownBal?.debit ?? 0)
                const creditValue = bal ? bal.credit : (ownBal?.credit ?? 0)
                const normalBal = getNormalBalance(account)

                return (
                  <tr
                    key={account.id}
                    className={`transition group/row ${
                      account.isGroup
                        ? 'bg-slate-50/70 dark:bg-slate-800/40 font-semibold'
                        : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <Td>
                      <span className="num font-mono font-bold text-slate-800 dark:text-slate-200 text-xs">
                        {account.code}
                      </span>
                    </Td>

                    <Td>
                      <div
                        className="flex items-center gap-2"
                        style={{ paddingInlineStart: `${Math.min(account.depth || 0, 5) * 14}px` }}
                      >
                        {account.isGroup ? (
                          <DaftraFolderIcon className="w-5 h-5 text-sky-600 shrink-0 inline" />
                        ) : (
                          <DaftraDocIcon className="w-4 h-4 text-slate-400 shrink-0 inline" />
                        )}
                        <span className={`truncate ${account.isGroup ? 'font-bold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}>
                          {accountLabel(account, lang)}
                        </span>
                      </div>
                    </Td>

                    <Td>
                      <Badge tone={normalBal === 'debit' ? 'sky' : 'amber'}>
                        {normalBal === 'debit' ? 'مدين' : 'دائن'}
                      </Badge>
                    </Td>

                    <Td>
                      {account.isGroup ? (
                        <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/40 dark:border-blue-800 px-2 py-0.5 text-[11px] font-bold text-blue-700 dark:text-blue-300">
                          رئيسي
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 dark:bg-slate-800 dark:border-slate-700 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                          فرعي
                        </span>
                      )}
                    </Td>

                    <Td className="text-end">
                      <span className="num font-mono text-xs text-slate-600 dark:text-slate-300">
                        {debitValue > 0 ? formatMoney(debitValue) : '0.00'}
                      </span>
                    </Td>

                    <Td className="text-end">
                      <span className="num font-mono text-xs text-slate-600 dark:text-slate-300">
                        {creditValue > 0 ? formatMoney(creditValue) : '0.00'}
                      </span>
                    </Td>

                    <Td className="text-end">
                      <span className={`num font-mono font-bold text-xs ${
                        balanceValue < 0
                          ? 'text-red-600 dark:text-red-400'
                          : balanceValue > 0
                          ? 'text-slate-900 dark:text-white'
                          : 'text-slate-400 dark:text-slate-500'
                      }`}>
                        {formatMoney(balanceValue)}
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
                            <IconPlus className="h-4 w-4 shrink-0" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setStatementAccount(account)}
                          title={t('acct.viewStatement')}
                          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-700"
                        >
                          <IconFileText className="h-4 w-4 shrink-0" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(account)}
                          title={t('common.edit')}
                          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                        >
                          <IconPencil className="h-4 w-4 shrink-0" />
                        </button>
                        {!account.role && (
                          <button
                            type="button"
                            onClick={() => setRemoving(account)}
                            title={t('common.delete')}
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/50"
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

          {/* Table Pagination */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 px-4 py-3 text-xs font-semibold text-slate-500">
            <div>
              عرض {(currentPage - 1) * pageSize + 1} - {Math.min(currentPage * pageSize, tableItems.length)} من {tableItems.length} حساب
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-200 transition hover:bg-slate-50 disabled:opacity-40"
              >
                ‹
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).slice(Math.max(0, currentPage - 3), Math.min(totalPages, currentPage + 2)).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  className={`grid h-7 min-w-[28px] place-items-center rounded-lg border px-2 text-xs font-bold transition ${
                    currentPage === p
                      ? 'border-brand-600 bg-brand-600 text-white shadow-xs'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-200 transition hover:bg-slate-50 disabled:opacity-40"
              >
                ›
              </button>
            </div>
          </div>
        </div>
      )}

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
        accounts={cleanAccounts}
        journal={journal}
        settings={settings}
        locale={locale}
        invoices={invoices}
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

        <div className="space-y-1.5">
          <label className="block text-xs font-bold text-slate-700 dark:text-slate-200">
            {t('acct.accountClassification')}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => set('isGroup', false)}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-right transition-all cursor-pointer ${
                !form.isGroup
                  ? 'border-blue-500 bg-blue-50/80 text-blue-900 shadow-sm ring-1 ring-blue-500 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-100'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              <div
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  !form.isGroup ? 'border-blue-600 bg-blue-600' : 'border-slate-400 dark:border-slate-500'
                }`}
              >
                {!form.isGroup && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
              </div>
              <div>
                <div className="text-sm font-bold text-slate-900 dark:text-white">
                  {t('acct.subAccount')}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {t('acct.subAccountDesc')}
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => set('isGroup', true)}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-right transition-all cursor-pointer ${
                form.isGroup
                  ? 'border-blue-500 bg-blue-50/80 text-blue-900 shadow-sm ring-1 ring-blue-500 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-100'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              <div
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  form.isGroup ? 'border-blue-600 bg-blue-600' : 'border-slate-400 dark:border-slate-500'
                }`}
              >
                {form.isGroup && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
              </div>
              <div>
                <div className="text-sm font-bold text-slate-900 dark:text-white">
                  {t('acct.mainAccount')}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {t('acct.mainAccountDesc')}
                </div>
              </div>
            </button>
          </div>
        </div>
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
              <Badge tone="brand">{formatRefType(entry.refType, t)}</Badge>
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

export function LedgerView({ journal, accounts, lang, locale, invoices = [] }) {
  const { t } = useI18n()
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [categoryFilter, setCategoryFilter] = useState('all') // 'all' | 'accounts' | 'employee' | 'client' | 'vendor'
  const [filterSubId, setFilterSubId] = useState('all')
  const [showSubBalances, setShowSubBalances] = useState(false)

  const handleAccountChange = (val) => {
    setAccountId(val)
    setFilterSubId('all')
  }

  const account = accounts.find((item) => item.id === accountId)

  const options = useMemo(
    () =>
      accounts.map((item) => {
        let badge = item.isGroup ? 'حساب رئيسي' : 'حساب فرعي'
        let category = item.category || 'account'
        if (item.isEmployeeFullNode) {
          badge = '👤 كشف موظف شامل'
          category = 'employee'
        } else if (item.isEmployeeNode) {
          badge = item.badge || '👤 أستاذ مساعد موظف'
          category = 'employee'
        } else if (item.isClientNode) {
          badge = item.badge || '👥 أستاذ مساعد عميل'
          category = 'client'
        } else if (item.isVendorNode) {
          badge = item.badge || '🚚 أستاذ مساعد مورد'
          category = 'vendor'
        }
        return {
          id: item.id,
          name: `${item.code} — ${accountLabel(item, lang)}`,
          code: item.code,
          isGroup: item.isGroup,
          category,
          badge,
        }
      }),
    [accounts, lang],
  )

  const filteredOptions = useMemo(() => {
    if (categoryFilter === 'all') return options
    if (categoryFilter === 'accounts') return options.filter((o) => o.category === 'account')
    return options.filter((o) => o.category === categoryFilter)
  }, [options, categoryFilter])

  const rowsWithoutSubFilter = useMemo(
    () => accountMovements(journal, accountId, accounts, null),
    [journal, accountId, accounts],
  )

  const rows = useMemo(
    () => accountMovements(journal, accountId, accounts, filterSubId),
    [journal, accountId, accounts, filterSubId],
  )

  // قائمة الأطراف الفرعية التابعة لحساب الأستاذ المختار (سواء كان حساباً رئيسياً أو حساب التزامات/أصول أطراف)
  const subParties = useMemo(() => {
    if (!account) return []
    const isPartyGroup =
      account.isGroup ||
      account.role?.includes('Payable') ||
      account.role?.includes('Advance') ||
      account.role?.includes('receivable') ||
      String(account.code).startsWith('1-01-03') ||
      String(account.code).startsWith('2-01-01') ||
      String(account.code).startsWith('2-01-03') ||
      String(account.code).startsWith('1-01-06-02')

    if (!isPartyGroup) return []

    const map = new Map()
    for (const r of rowsWithoutSubFilter) {
      const partyId = r.subLedgerId || r.partyName
      const partyName = r.partyName || r.clientName || r.vendorName || r.employeeName || (r.subLedgerType ? r.subLedgerName : '')
      if (partyId && partyName) {
        const cleanId = String(partyId).replace(/^(client|vendor|emp-payable|emp-advance|emp-full)-/, '')
        if (!map.has(cleanId)) {
          map.set(cleanId, {
            id: partyId,
            cleanId,
            name: partyName,
            type: r.subLedgerType,
            debit: 0,
            credit: 0,
            count: 0,
          })
        }
        const item = map.get(cleanId)
        item.debit = round2(item.debit + toNumber(r.debit))
        item.credit = round2(item.credit + toNumber(r.credit))
        item.count += 1
      }
    }

    const normal = getNormalBalance(account)
    return [...map.values()]
      .map((p) => ({
        ...p,
        balance: round2(normal === 'credit' ? p.credit - p.debit : p.debit - p.credit),
      }))
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
  }, [account, rowsWithoutSubFilter])

  const stats = useMemo(() => {
    const totalDebit = round2(rows.reduce((sum, r) => sum + toNumber(r.debit), 0))
    const totalCredit = round2(rows.reduce((sum, r) => sum + toNumber(r.credit), 0))
    const closingBalance = rows.length > 0 ? rows.at(-1).balance : 0
    return {
      totalDebit,
      totalCredit,
      closingBalance,
      count: rows.length,
    }
  }, [rows])

  return (
    <div>
      <div className="card mb-4 p-4">
        {/* تصنيفات سريعة لاختيار نوع الحساب */}
        <div className="mb-3 flex flex-wrap items-center gap-1.5 border-b border-slate-100 pb-3 dark:border-slate-800">
          <span className="text-xs font-bold text-slate-500 me-2">تصنيف الحسابات:</span>
          {[
            { id: 'all', label: 'الكل' },
            { id: 'accounts', label: '🏛️ الدليل المحاسبي' },
            { id: 'employee', label: '👤 حسابات الموظفين' },
            { id: 'client', label: '👥 حسابات العملاء' },
            { id: 'vendor', label: '🚚 حسابات الموردين' },
          ].map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategoryFilter(cat.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                categoryFilter === cat.id
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <Field label={t('acct.account')} className="max-w-xl">
          <SearchableSelect
            options={filteredOptions}
            value={accountId}
            placeholder={t('acct.account')}
            searchPlaceholder="ابحث باسم الحساب، الموظف، العميل أو الكود..."
            onChange={handleAccountChange}
          />
        </Field>
      </div>

      {account && (
        <div
          className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 transition ${
            account.isEmployeeFullNode || account.isEmployeeNode
              ? 'border-indigo-200 bg-indigo-50/70 text-indigo-950 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200'
              : account.isClientNode
              ? 'border-teal-200 bg-teal-50/70 text-teal-950 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200'
              : account.isVendorNode
              ? 'border-amber-200 bg-amber-50/70 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
              : account.isGroup
              ? 'border-purple-200 bg-purple-50/70 text-purple-950 dark:border-purple-800 dark:bg-purple-950/40 dark:text-purple-200'
              : 'border-emerald-200 bg-emerald-50/70 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
          }`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl ${
                account.isEmployeeFullNode || account.isEmployeeNode
                  ? 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400'
                  : account.isClientNode
                  ? 'bg-teal-500/10 text-teal-700 dark:text-teal-400'
                  : account.isVendorNode
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : account.isGroup
                  ? 'bg-purple-500/10 text-purple-700 dark:text-purple-400'
                  : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {account.isGroup ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                )}
              </svg>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="num text-xs font-bold opacity-80">
                  {account.code}
                </span>
                <h4 className="text-sm font-bold">{accountLabel(account, lang)}</h4>
                <span className="rounded-md border px-2 py-0.5 text-xs font-extrabold bg-white/70 border-current/20">
                  {account.badge || (account.isGroup ? 'حساب رئيسي' : 'حساب فرعي')}
                </span>
              </div>
              <p className="mt-0.5 text-xs opacity-75">
                {account.isEmployeeFullNode
                  ? 'كشف حساب موظف شامل يوضح كافة الحركات المالية المسجلة للموظف (مستحقات، رواتب، سلف، بدلات واستردادات).'
                  : account.isEmployeeNode
                  ? 'أستاذ مساعد تفصيلي لحساب الموظف يوضح حركة المستحقات أو السلف الخاصة به بدقة.'
                  : account.isClientNode
                  ? 'أستاذ مساعد تفصيلي لحساب العميل يوضح كافة الفواتير والتحصيلات والتسويات.'
                  : account.isVendorNode
                  ? 'أستاذ مساعد تفصيلي لحساب المورد يوضح فواتير المشتريات والمدفوعات والمستحقات.'
                  : account.isGroup
                  ? 'يعرض كشف الحساب الإجمالي لكافة الحسابات الفرعية التابعة له مع إمكانية التصفية بالأطراف.'
                  : 'كشف حساب تفصيلي يوضح الحركات المباشرة المسجلة على هذا الحساب.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* شريط تصفية بالأطراف الفرعية وملخص الأرصدة المساعدة (عند وجود أطراف متعددة) */}
      {subParties.length > 0 && (
        <div className="card mb-4 p-4 border border-indigo-100 bg-indigo-50/20 dark:border-indigo-900 dark:bg-indigo-950/20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                تصفية بحسب الطرف / الحساب الفرعي:
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setFilterSubId('all')}
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                    filterSubId === 'all'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                  }`}
                >
                  الكل ({subParties.length})
                </button>
                {subParties.slice(0, 6).map((p) => (
                  <button
                    key={p.cleanId}
                    type="button"
                    onClick={() => setFilterSubId(p.cleanId)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                      filterSubId === p.cleanId || filterSubId === p.id
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
                {subParties.length > 6 && (
                  <select
                    value={filterSubId}
                    onChange={(e) => setFilterSubId(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200"
                  >
                    <option value="all">المزيد من الأطراف ({subParties.length})...</option>
                    {subParties.map((p) => (
                      <option key={p.cleanId} value={p.cleanId}>
                        {p.name} ({formatMoney(p.balance)})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowSubBalances((v) => !v)}
              className="text-xs"
            >
              {showSubBalances ? 'إخفاء ملخص الأرصدة الفرعية' : 'عرض ملخص أرصدة الأستاذ المساعد'}
            </Button>
          </div>

          {showSubBalances && (
            <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 dark:bg-slate-800 dark:border-slate-700 text-slate-500">
                    <th className="p-2 text-start">الطرف / الحساب الفرعي</th>
                    <th className="p-2 text-center">النوع</th>
                    <th className="p-2 text-end">إجمالي المدين</th>
                    <th className="p-2 text-end">إجمالي الدائن</th>
                    <th className="p-2 text-end">الرصيد الصافي</th>
                    <th className="p-2 text-center">الإجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {subParties.map((p) => {
                    const directSubAcc = accounts.find(
                      (a) =>
                        a.id === p.id ||
                        a.employeeId === p.cleanId ||
                        a.clientId === p.cleanId ||
                        a.vendorId === p.cleanId,
                    )
                    return (
                      <tr key={p.cleanId} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                        <td className="p-2 font-bold text-slate-800 dark:text-slate-200">{p.name}</td>
                        <td className="p-2 text-center">
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                            {p.type === 'employee' ? 'موظف' : p.type === 'client' ? 'عميل' : p.type === 'vendor' ? 'مورد' : 'طرف'}
                          </span>
                        </td>
                        <td className="p-2 text-end num text-slate-700 dark:text-slate-300">{formatMoney(p.debit)}</td>
                        <td className="p-2 text-end num text-slate-700 dark:text-slate-300">{formatMoney(p.credit)}</td>
                        <td className="p-2 text-end">
                          <span className={`num font-bold ${p.balance > 0 ? 'text-emerald-600' : p.balance < 0 ? 'text-rose-600' : 'text-slate-500'}`}>
                            {formatMoney(p.balance)}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          {directSubAcc ? (
                            <button
                              type="button"
                              onClick={() => {
                                setAccountId(directSubAcc.id)
                                setFilterSubId('all')
                              }}
                              className="font-bold text-brand-600 hover:text-brand-800 hover:underline dark:text-brand-400"
                            >
                              فتح كشف الحساب
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setFilterSubId(p.cleanId)}
                              className="font-bold text-slate-600 hover:text-brand-600 hover:underline dark:text-slate-400"
                            >
                              تصفية الحركات
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ملخص إحصائيات الحساب الحالي */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="عدد العمليات" value={stats.count} />
        <StatCard label="إجمالي المدين" value={formatMoney(stats.totalDebit)} suffix={t('common.currency')} />
        <StatCard label="إجمالي الدائن" value={formatMoney(stats.totalCredit)} suffix={t('common.currency')} />
        <StatCard
          label={t('acct.closingBalance')}
          value={formatMoney(stats.closingBalance)}
          suffix={t('common.currency')}
          tone={
            stats.closingBalance > 0
              ? 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300'
              : stats.closingBalance < 0
              ? 'text-rose-700 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-300'
              : 'text-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-300'
          }
        />
      </div>

      {rows.length === 0 ? (
        <p className="card px-4 py-12 text-center text-sm text-slate-400">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.date')}</Th>
              <Th>{t('acct.reference')}</Th>
              <Th>رقم العملية / الفاتورة</Th>
              <Th>الطرف / الحساب الفرعي</Th>
              {account?.isGroup && <Th>الحساب التابع</Th>}
              <Th>{t('common.description')}</Th>
              <Th>{t('acct.debit')}</Th>
              <Th>{t('acct.credit')}</Th>
              <Th>{t('acct.balance')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const party = row.employeeName || row.clientName || row.vendorName || row.partyName || (row.subLedgerType ? row.subLedgerName : '')
              const docNum = row.invoiceNumber || row.ref
              return (
                <tr key={`${row.entryId}-${index}`}>
                  <Td className="text-slate-600 whitespace-nowrap">{formatDate(row.date, locale)}</Td>
                  <Td>
                    <Badge tone="slate">{formatRefType(row.refType, t)}</Badge>
                  </Td>
                  <Td>
                    {docNum ? (
                      <div className="flex flex-col gap-0.5">
                        {(() => {
                          const targetUrl = getMovementDocUrl(row, invoices)
                          return targetUrl ? (
                            <a
                              href={targetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-xs font-bold text-brand-600 hover:text-brand-800 hover:underline dark:text-brand-400 group"
                              title="فتح تفاصيل المستند في نافذة جديدة"
                            >
                              <span>#{docNum}</span>
                              <svg className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </a>
                          ) : (
                            <span className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200">
                              #{docNum}
                            </span>
                          )
                        })()}
                        {row.invoiceNumber && row.ref && row.ref !== row.invoiceNumber && (
                          <div className="text-[10px] text-slate-500 font-medium">
                            <span>فاتورة: </span>
                            {(() => {
                              const invUrl = row.invoiceId ? `/invoices/${row.invoiceId}` : getMovementDocUrl({ invoiceNumber: row.invoiceNumber }, invoices)
                              return invUrl ? (
                                <a
                                  href={invUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-mono font-bold text-slate-600 hover:text-brand-600 hover:underline dark:text-slate-400"
                                >
                                  #{row.invoiceNumber}
                                </a>
                              ) : (
                                <span className="font-mono font-bold">#{row.invoiceNumber}</span>
                              )
                            })()}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </Td>
                  <Td>
                    {party ? (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          row.subLedgerType === 'employee' || Boolean(row.employeeName)
                            ? 'bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800'
                            : row.clientName || row.subLedgerType === 'client'
                            ? 'bg-teal-50 text-teal-700 border border-teal-200 dark:bg-teal-950/60 dark:text-teal-300 dark:border-teal-800'
                            : row.vendorName || row.subLedgerType === 'vendor'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800'
                            : 'bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300'
                        }`}>
                          {row.subLedgerType === 'employee' || Boolean(row.employeeName)
                            ? 'موظف'
                            : (row.clientName || row.subLedgerType === 'client' ? 'عميل' : (row.vendorName || row.subLedgerType === 'vendor' ? 'مورد' : 'طرف'))}
                        </span>
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                          {party}
                        </span>
                      </div>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </Td>
                  {account?.isGroup && (
                    <Td>
                      <span className="inline-flex items-center gap-1 rounded-md border border-purple-200 bg-purple-50 px-2 py-1 text-xs font-semibold text-purple-800 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800">
                        <span className="num font-bold">{row.subAccountCode}</span>
                        <span>—</span>
                        <span>{row.subAccountName}</span>
                      </span>
                    </Td>
                  )}
                  <Td className="text-slate-600 dark:text-slate-300 max-w-xs">{row.description || '—'}</Td>
                  <Td>
                    {row.debit > 0 ? <span className="num font-bold">{formatMoney(row.debit)}</span> : <span className="text-slate-300">—</span>}
                  </Td>
                  <Td>
                    {row.credit > 0 ? <span className="num font-bold">{formatMoney(row.credit)}</span> : <span className="text-slate-300">—</span>}
                  </Td>
                  <Td>
                    <span className="num font-bold text-slate-900 dark:text-white">{formatMoney(row.balance)}</span>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </TableWrap>
      )}

      {account && rows.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/60">
          <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
            {t('acct.closingBalance')}:{' '}
            <span className="num font-extrabold text-slate-900 dark:text-white">{formatMoney(rows.at(-1).balance)}</span>{' '}
            <span className="text-xs text-slate-400">{t('common.currency')}</span>
          </p>
          <span className="text-xs text-slate-400">
            إجمالي الحركات المعروضة: {rows.length} حركة
          </span>
        </div>
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

  const revenueRows = balances.filter((row) => row.account.type === 'revenue' && (!row.account.isGroup || (row.debit !== 0 || row.credit !== 0)) && row.balance !== 0)
  const expenseRows = balances.filter((row) => row.account.type === 'expense' && (!row.account.isGroup || (row.debit !== 0 || row.credit !== 0)) && row.balance !== 0)

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

  const isContraEquity = (acc) =>
    acc?.role === 'drawings' || acc?.normalBalance === 'debit' || String(acc?.code || '').startsWith('3-01-03')

  const isContraAsset = (acc) =>
    acc?.role === 'accumDep' || acc?.normalBalance === 'credit'

  const assets = balances.filter((row) => row.account.type === 'asset' && (!row.account.isGroup || (row.debit !== 0 || row.credit !== 0)) && row.balance !== 0)
  const liabilities = balances.filter(
    (row) => row.account.type === 'liability' && (!row.account.isGroup || (row.debit !== 0 || row.credit !== 0)) && row.balance !== 0,
  )
  const equity = balances.filter((row) => row.account.type === 'equity' && (!row.account.isGroup || (row.debit !== 0 || row.credit !== 0)) && row.balance !== 0)

  const assetsTotal = assets.reduce((sum, row) => sum + (isContraAsset(row.account) ? -row.balance : row.balance), 0)
  const liabilitiesTotal = liabilities.reduce((sum, row) => sum + row.balance, 0)
  const equityTotal = equity.reduce((sum, row) => sum + (isContraEquity(row.account) ? -row.balance : row.balance), 0) + profit
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
                {equity.map((row) => {
                  const contra = isContraEquity(row.account)
                  return (
                    <tr key={row.account.id}>
                      <Td>
                        <span className="num me-2 text-xs font-bold text-slate-400">{row.account.code}</span>
                        <span className="text-slate-700">{accountLabel(row.account, lang)}</span>
                      </Td>
                      <Td>
                        <span className={`num font-bold ${contra ? 'text-rose-600' : 'text-slate-800'}`}>
                          {contra ? `-${formatMoney(row.balance)}` : formatMoney(row.balance)}
                        </span>
                      </Td>
                    </tr>
                  )
                })}
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
                        <Badge tone="slate">{formatRefType(row.refType, t)}</Badge>
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

function AccountStatementModal({ open, account, accounts = [], journal, settings = {}, locale, invoices = [], onClose }) {
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
                <Th>{t('acct.reference')}</Th>
                <Th>رقم العملية / الفاتورة</Th>
                <Th>العميل / الطرف</Th>
                {account.isGroup && <Th>الحساب الفرعي</Th>}
                <Th>{t('common.description')}</Th>
                <Th>{t('acct.debit')}</Th>
                <Th>{t('acct.credit')}</Th>
                <Th>{t('acct.balance')}</Th>
              </tr>
            </thead>
            <tbody>
              {periodMovements.map((row, idx) => {
                const docNum = row.invoiceNumber || row.ref
                const party = row.clientName || row.vendorName || row.partyName || (row.subLedgerType ? row.subLedgerName : '')
                return (
                  <tr key={`${row.entryId}-${idx}`}>
                    <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                    <Td>
                      <Badge tone="slate">{formatRefType(row.refType, t)}</Badge>
                    </Td>
                    <Td>
                      {docNum ? (
                        <div className="flex flex-col gap-0.5">
                          {(() => {
                            const targetUrl = getMovementDocUrl(row, invoices)
                            return targetUrl ? (
                              <a
                                href={targetUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 font-mono text-xs font-bold text-brand-600 hover:text-brand-800 hover:underline dark:text-brand-400 group"
                                title="فتح تفاصيل المستند في نافذة جديدة"
                              >
                                <span>#{docNum}</span>
                                <svg className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                            ) : (
                              <span className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200">
                                #{docNum}
                              </span>
                            )
                          })()}
                          {row.invoiceNumber && row.ref && row.ref !== row.invoiceNumber && (
                            <div className="text-[10px] text-slate-500 font-medium">
                              <span>فاتورة: </span>
                              {(() => {
                                const invUrl = row.invoiceId ? `/invoices/${row.invoiceId}` : getMovementDocUrl({ invoiceNumber: row.invoiceNumber }, invoices)
                                return invUrl ? (
                                  <a
                                    href={invUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-mono font-bold text-slate-600 hover:text-brand-600 hover:underline dark:text-slate-400"
                                  >
                                    #{row.invoiceNumber}
                                  </a>
                                ) : (
                                  <span className="font-mono font-bold">#{row.invoiceNumber}</span>
                                )
                              })()}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>
                    <Td>
                      {party ? (
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-200">{party}</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>
                    {account.isGroup && (
                      <Td>
                        <span className="num text-xs font-semibold text-brand-700">
                          {row.subAccountCode} - {row.subAccountName}
                        </span>
                      </Td>
                    )}
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
              )
            })}
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
                    <Th>رقم العملية / الفاتورة</Th>
                    <Th>العميل / الطرف</Th>
                    <Th>{t('common.description')}</Th>
                    <Th>{t('acct.debit')}</Th>
                    <Th>{t('acct.credit')}</Th>
                    <Th>{t('acct.balance')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {periodMovements.map((row, idx) => {
                    const docNum = row.invoiceNumber || row.ref
                    const party = row.clientName || row.vendorName || row.partyName || (row.subLedgerType ? row.subLedgerName : '—')
                    return (
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
                          <span className="text-xs font-bold text-slate-700">
                            {formatRefType(row.refType, t)}
                          </span>
                        </Td>
                        <Td>
                          <span className="num text-xs font-bold text-slate-800">
                            {docNum ? `#${docNum}` : '—'}
                          </span>
                        </Td>
                        <Td>
                          <span className="text-xs font-semibold text-slate-900">{party}</span>
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
                  )
                })}
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

  async function handleApplyFullStandardChart() {
    setBusy(true)
    setErrorMsg('')
    try {
      await seedAccounts(cleanAccounts)
      setSuccessMsg('تم تطبيق واعتماد شجرة الحسابات القياسية كاملة (367 حساباً - 6 مستويات) بنجاح!')
    } catch (err) {
      setErrorMsg('حدث خطأ أثناء تطبيق الشجرة القياسية: ' + (err.message || ''))
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
            onClick={() => setActiveTab('defaults')}
            className={`border-b-2 px-4 py-2.5 text-xs font-bold transition ${
              activeTab === 'defaults'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            شجرة الـ 6 مستويات القياسية (ملف الإكسيل)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('csv')}
            className={`border-b-2 px-4 py-2.5 text-xs font-bold transition ${
              activeTab === 'csv'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            استيراد من ملف CSV / Excel مخصص
          </button>
        </div>

        {successMsg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 p-4 text-xs font-bold text-emerald-800 dark:text-emerald-300">
            {successMsg}
          </div>
        )}

        {errorMsg && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 p-4 text-xs font-bold text-rose-800 dark:text-rose-300">
            {errorMsg}
          </div>
        )}

        {activeTab === 'defaults' && (
          <div className="space-y-4">
            <div className="rounded-2xl border-2 border-brand-200 bg-brand-50/40 dark:bg-slate-800/80 dark:border-brand-900/60 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-extrabold text-slate-900 dark:text-white flex items-center gap-2">
                  <span>شجرة الحسابات القياسية ذات الـ 6 مستويات (367 حساباً)</span>
                  <span className="rounded-full bg-brand-100 text-brand-700 font-bold px-2 py-0.5 text-[10px]">موصى به</span>
                </h4>
              </div>
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                هذا الإجراء يقوم بتطبيق دليل الحسابات القياسي المتكامل (367 حساباً موزعاً على 6 مستويات و 8 مجموعات رئيسية: الأصول، الالتزامات، حقوق الملكية، الإيرادات، تكلفة النشاط، المصروفات التشغيلية، إيرادات ومصروفات أخرى، حسابات التسويات والإقفال).
              </p>
              <div className="pt-2">
                <Button onClick={handleApplyFullStandardChart} disabled={busy}>
                  {busy ? 'جاري التطبيق والحفظ...' : 'تطبيق واعتماد شجرة الـ 6 مستويات القياسية الآن'}
                </Button>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 dark:bg-slate-800/40 dark:border-slate-700 p-4 space-y-2">
              <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200">استرداد الحسابات الوظيفية الناقصة فقط</h4>
              <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                يفحص فقط الحسابات التي تحمل أدواراً وظيفية أساسية بالنظام (الخزينة، العملاء، الموردين، الضرائب، الرواتب) ويضيف ما ينقص منها دون تعديل بقية الحسابات.
              </p>
              <div className="pt-1">
                <Button variant="ghost" size="sm" onClick={handleRestoreDefaults} disabled={busy}>
                  {busy ? 'جاري الفحص...' : 'فحص واسترداد الحسابات الناقصة فقط'}
                </Button>
              </div>
            </div>
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
      </div>
    </Modal>
  )
}
