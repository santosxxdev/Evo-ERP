import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { COL, useAllPayments, useCollection, useSettings } from '../lib/db'
import { ACCOUNTS_COL, accountLabel } from '../lib/accounts'
import { JOURNAL_COL, createVoucher } from '../lib/journal'
import { ASSETS_COL, ASSET_USAGE_COL, MAINTENANCE_COL } from '../lib/assets'
import { accountBalances, accountMovements, buildJournal, getMovementDocUrl } from '../lib/ledger'
import { formatDate, formatMoney, todayISO, toNumber } from '../lib/format'
import { JOB_COSTS_COL, VENDORS_COL } from './Vendors'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  StatCard,
  TableWrap,
  Td,
  Th,
} from '../components/ui'
import SearchableSelect from '../components/SearchableSelect'
import { IconExpenses } from '../components/Icons'

import { useAuth } from '../context/AuthContext'

/** الحسابات التي تمثّل نقدية فعلية: الخزينة والبنوك والمحافظ وما تحتها */
const CASH_ROLES = ['cash', 'bank', 'adTreasury']

export default function Treasury() {
  const { t, lang, locale } = useI18n()
  const { user } = useAuth()

  const { settings } = useSettings()
  const { rows: accounts, loading } = useCollection(ACCOUNTS_COL, 'code', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: expenseCategories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const { rows: paymentMethods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: vendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: vouchers } = useCollection(JOURNAL_COL, 'date', 'desc')
  const { rows: assets } = useCollection(ASSETS_COL, 'name', 'asc')
  const { rows: maintenance } = useCollection(MAINTENANCE_COL, 'date', 'desc')
  const { rows: assetUsage } = useCollection(ASSET_USAGE_COL, 'date', 'desc')
  const { rows: payments } = useAllPayments()
  const { rows: accountingTransactions } = useCollection(COL.accountingTransactions, 'transactionDate', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: purchaseInvoices } = useCollection('purchaseInvoices', 'date', 'desc')
  const { rows: vendorPayments } = useCollection('vendorPayments', 'date', 'desc')

  const [transferOpen, setTransferOpen] = useState(false)
  const [viewing, setViewing] = useState(null)
  const [busy, setBusy] = useState(false)

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

  const balances = useMemo(() => accountBalances(journal, accounts), [journal, accounts])

  /* حسابات النقدية: الأدوار الأساسية + أي حساب مرتبط بطريقة تحويل + أطفال 1111/1112/1101 + أطفال الشجرة القياسية 1-01-01 / 1-01-02 */
  const cashAccounts = useMemo(() => {
    const linked = new Set(paymentMethods.map((method) => method.accountId).filter(Boolean))
    return balances.filter(
      (row) =>
        !row.account.isGroup &&
        (CASH_ROLES.includes(row.account.role) ||
          linked.has(row.account.id) ||
          String(row.account.code).startsWith('1-01-01') ||
          String(row.account.code).startsWith('1-01-02') ||
          String(row.account.parentCode).startsWith('1-01-01') ||
          String(row.account.parentCode).startsWith('1-01-02') ||
          row.account.parentCode === '1101' ||
          row.account.parentCode === '110101' ||
          row.account.parentCode === '110102' ||
          row.account.parentCode === '1112' ||
          row.account.parentCode === '1111'),
    )
  }, [balances, paymentMethods])

  /* تقسيم الحسابات: خزائن نقدية / بنوك ومحافظ رقمية / محافظ ميزانيات الإعلانات */
  const isCash = (row) =>
    row.account.role === 'cash' ||
    String(row.account.code).startsWith('1-01-01-01') ||
    row.account.parentCode === '1111' ||
    row.account.parentCode === '110101'
  const isAdWallet = (row) =>
    row.account.role === 'adTreasury' || String(row.account.code) === '110103'

  const cashBoxes = cashAccounts.filter((row) => isCash(row) && !isAdWallet(row))
  const bankAccounts = cashAccounts.filter((row) => !isCash(row) && !isAdWallet(row))
  const adWallets = cashAccounts.filter(isAdWallet)

  const cashTotal = cashBoxes.reduce((sum, row) => sum + row.balance, 0)
  const bankTotal = bankAccounts.reduce((sum, row) => sum + row.balance, 0)
  const adWalletTotal = adWallets.reduce((sum, row) => sum + row.balance, 0)

  // النقدية الحرة للشركة (الخزائن + البنوك بدون ميزانيات الإعلانات)
  const companyFreeCash = cashTotal + bankTotal
  // إجمالي السيولة النقدية المجمعة
  const total = companyFreeCash + adWalletTotal

  async function transfer({ fromId, toId, amount, date, description }) {
    setBusy(true)
    try {
      await createVoucher({
        date,
        type: 'transfer',
        description,
        lines: [
          { accountId: toId, debit: amount, credit: 0 },
          { accountId: fromId, debit: 0, credit: amount },
        ],
        uid: user?.uid,
      })
      setTransferOpen(false)
    } catch (err) {
      alert(err.message || 'حدث خطأ أثناء التحويل بين الحسابات.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />

  if (cashAccounts.length === 0) {
    return (
      <div>
        <PageHeader title={t('treasury.title')} subtitle={t('treasury.subtitle')} />
        <EmptyState title={t('treasury.empty')} message={t('treasury.emptyHint')} />
      </div>
    )
  }

  return (
    <div>
      <PageHeader title={t('treasury.title')} subtitle={t('treasury.subtitle')}>
        <Button onClick={() => setTransferOpen(true)}>{t('treasury.transfer')}</Button>
      </PageHeader>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t('treasury.cashTotal')}
          value={formatMoney(cashTotal)}
          suffix={t('common.currency')}
          tone="text-amber-600 bg-amber-50"
          Icon={IconExpenses}
        />
        <StatCard
          label={t('treasury.bankTotal')}
          value={formatMoney(bankTotal)}
          suffix={t('common.currency')}
          tone="text-sky-600 bg-sky-50"
          Icon={IconExpenses}
        />
        <StatCard
          label="محفظة ميزانيات الإعلانات"
          value={formatMoney(adWalletTotal)}
          suffix={t('common.currency')}
          tone="text-brand-600 bg-brand-50"
          Icon={IconExpenses}
        />
        <StatCard
          label={t('treasury.totalCash')}
          value={formatMoney(total)}
          suffix={t('common.currency')}
          tone="text-emerald-600 bg-emerald-50"
          Icon={IconExpenses}
        />
      </div>

      <div className="space-y-6">
        <AccountGroup
          title={t('settings.methodType.cash')}
          rows={cashBoxes}
          subtotal={cashTotal}
          tone="amber"
          paymentMethods={paymentMethods}
          lang={lang}
          onView={setViewing}
        />
        <AccountGroup
          title={t('treasury.banksAndWallets')}
          rows={bankAccounts}
          subtotal={bankTotal}
          tone="sky"
          paymentMethods={paymentMethods}
          lang={lang}
          onView={setViewing}
        />
        {adWallets.length > 0 && (
          <AccountGroup
            title="محافظ ميزانيات إعلانات العملاء"
            rows={adWallets}
            subtotal={adWalletTotal}
            tone="brand"
            paymentMethods={paymentMethods}
            lang={lang}
            onView={setViewing}
          />
        )}
      </div>

      <TransferForm
        open={transferOpen}
        accounts={cashAccounts.map((row) => row.account)}
        lang={lang}
        busy={busy}
        onClose={() => setTransferOpen(false)}
        onSave={transfer}
      />

      <AccountMovements
        open={Boolean(viewing)}
        account={viewing}
        journal={journal}
        accounts={accounts}
        invoices={invoices}
        lang={lang}
        locale={locale}
        onClose={() => setViewing(null)}
      />
    </div>
  )
}

function AccountGroup({ title, rows, subtotal, tone, paymentMethods, lang, onView }) {
  const { t } = useI18n()
  if (rows.length === 0) return null

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-900">{title}</h3>
        <span className="text-xs font-semibold text-slate-500">
          {t('acct.closingBalance')}:{' '}
          <span className={`num font-extrabold ${subtotal >= 0 ? 'text-slate-900' : 'text-red-600'}`}>
            {formatMoney(subtotal)} {t('common.currency')}
          </span>
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => {
          const method = paymentMethods.find((item) => item.accountId === row.account.id)
          return (
            <button
              key={row.account.id}
              type="button"
              onClick={() => onView(row.account)}
              className="card p-5 text-start transition hover:border-brand-300 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-slate-800">{accountLabel(row.account, lang)}</p>
                  <p className="num mt-0.5 text-xs font-semibold text-slate-400">{row.account.code}</p>
                </div>
                <Badge tone={tone}>
                  {t(row.account.role === 'cash' ? 'settings.methodType.cash' : 'settings.methodType.bank')}
                </Badge>
              </div>

              <p className={`num mt-4 text-2xl font-extrabold ${row.balance >= 0 ? 'text-slate-900' : 'text-red-600'}`}>
                {formatMoney(row.balance)}
                <span className="ms-1.5 text-sm font-semibold text-slate-400">{t('common.currency')}</span>
              </p>

              {method?.accountNumber && (
                <p className="num mt-2 text-xs font-semibold text-slate-500">{method.accountNumber}</p>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TransferForm({ open, accounts, lang, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setForm({ fromId: '', toId: '', amount: '', date: todayISO(), description: '' })
    setTouched(false)
  }
  if (!open && wasOpen) setWasOpen(false)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const invalid = !form.fromId || !form.toId || form.fromId === form.toId || toNumber(form.amount) <= 0

  function submit() {
    setTouched(true)
    if (invalid) return
    onSave({
      fromId: form.fromId,
      toId: form.toId,
      amount: toNumber(form.amount),
      date: form.date,
      description: form.description?.trim() || t('treasury.transfer'),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('treasury.transfer')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <p className="mb-4 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
        {t('treasury.transferHint')}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('treasury.from')}>
          <SearchableSelect
            options={accounts.map((acc) => ({
              id: acc.id,
              name: `${acc.code ? `${acc.code} - ` : ''}${accountLabel(acc, lang)}`,
              code: acc.code,
            }))}
            value={form.fromId ?? ''}
            placeholder={t('treasury.from')}
            searchPlaceholder="ابحث باسم الحساب أو الكود..."
            onChange={(val) => set('fromId', val)}
          />
        </Field>

        <Field label={t('treasury.to')}>
          <SearchableSelect
            options={accounts.map((acc) => ({
              id: acc.id,
              name: `${acc.code ? `${acc.code} - ` : ''}${accountLabel(acc, lang)}`,
              code: acc.code,
            }))}
            value={form.toId ?? ''}
            placeholder={t('treasury.to')}
            searchPlaceholder="ابحث باسم الحساب أو الكود..."
            onChange={(val) => set('toId', val)}
          />
        </Field>

        <Field label={t('common.amount')} error={touched && toNumber(form.amount) <= 0 ? t('common.required') : null}>
          <Input numeric value={form.amount ?? ''} onChange={(event) => set('amount', event.target.value)} />
        </Field>

        <Field label={t('common.date')}>
          <Input type="date" value={form.date ?? ''} onChange={(event) => set('date', event.target.value)} />
        </Field>

        <Field label={`${t('common.description')} (${t('common.optional')})`} className="sm:col-span-2">
          <Input value={form.description ?? ''} onChange={(event) => set('description', event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function AccountMovements({ open, account, journal, accounts, invoices = [], lang, locale, onClose }) {
  const { t } = useI18n()
  if (!account) return null

  const rows = accountMovements(journal, account?.id, accounts)

  return (
    <Modal open={open} onClose={onClose} wide title={accountLabel(account, lang)}>
      {rows.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.date')}</Th>
              <Th>{t('acct.reference')}</Th>
              <Th>رقم العملية / الفاتورة</Th>
              <Th>العميل / الطرف</Th>
              <Th>{t('common.description')}</Th>
              <Th>{t('treasury.in')}</Th>
              <Th>{t('treasury.out')}</Th>
              <Th>{t('acct.balance')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const docNum = row.invoiceNumber || row.ref
              const party = row.clientName || row.vendorName || row.partyName || (row.subLedgerType ? row.subLedgerName : '')
              const targetUrl = getMovementDocUrl(row, invoices)
              return (
                <tr key={`${row.entryId}-${index}`}>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                  <Td>
                    <span className="num text-xs font-bold text-slate-700">{row.refType || row.ref || '—'}</span>
                  </Td>
                  <Td>
                    {docNum ? (
                      targetUrl ? (
                        <a
                          href={targetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-xs font-bold text-brand-600 hover:text-brand-800 hover:underline dark:text-brand-400 group"
                          title="الانتقال إلى تفاصيل الفاتورة / المستند"
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
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">{party || '—'}</span>
                  </Td>
                  <Td className="text-slate-600">{row.description || '—'}</Td>
                  <Td>
                    {row.debit > 0 ? (
                      <span className="num font-bold text-emerald-600">{formatMoney(row.debit)}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </Td>
                  <Td>
                    {row.credit > 0 ? (
                      <span className="num font-bold text-rose-600">{formatMoney(row.credit)}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="num font-bold text-slate-900">{formatMoney(row.balance)}</span>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </TableWrap>
      )}
    </Modal>
  )
}
