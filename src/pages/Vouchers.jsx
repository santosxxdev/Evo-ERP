import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useI18n } from '../i18n'
import { COL, useCollection } from '../lib/db'
import { ACCOUNTS_COL, accountLabel, byRole, treasuryAccounts } from '../lib/accounts'
import {
  JOURNAL_COL,
  VOUCHER_SHAPES,
  VOUCHER_TYPES,
  createVoucher,
  updateVoucher,
  deleteVoucher,
  voucherTotals,
} from '../lib/journal'
import { formatDate, formatMoney, isWithin, todayISO, toNumber } from '../lib/format'
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
  TableWrap,
  Td,
  Textarea,
  Th,
} from '../components/ui'

/* المستندات السريعة: كل واحد بيملأ القيد تلقائيًا ومحتاج مبلغ واحد بس */
const QUICK = [
  { type: 'opening', tone: 'bg-sky-600' },
  { type: 'payment', tone: 'bg-rose-600' },
  { type: 'receipt', tone: 'bg-emerald-600' },
  { type: 'drawing', tone: 'bg-amber-600' },
  { type: 'tax', tone: 'bg-violet-600' },
  { type: 'transfer', tone: 'bg-slate-700' },
  { type: 'manual', tone: 'bg-brand-600' },
]

import { useAuth } from '../context/AuthContext'
import SearchableSelect from '../components/SearchableSelect'

export default function Vouchers() {
  const { t, lang, locale } = useI18n()
  const { user } = useAuth()

  const { rows: accounts, loading } = useCollection(ACCOUNTS_COL, 'code', 'asc')
  const { rows: paymentMethods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const { rows: allVouchers } = useCollection(JOURNAL_COL, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: vendors } = useCollection(COL.vendors, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')

  /* ?type= يفتح الصفحة على نوع مستند واحد (من قائمة «تقارير سندات») */
  const [searchParams] = useSearchParams()
  const filterType = VOUCHER_TYPES.includes(searchParams.get('type')) ? searchParams.get('type') : null

  const [creating, setCreating] = useState(null)
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)

  // Filters
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')

  const accountMap = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts])

  const vouchers = useMemo(() => {
    let list = allVouchers
    if (filterType) {
      list = list.filter((voucher) => voucher.type === filterType)
    }
    if (from || to) {
      list = list.filter((voucher) => isWithin(voucher.date, from, to))
    }
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter((voucher) => {
        const linesMatch = (voucher.lines || []).some((l) => {
          const acc = accountMap.get(l.accountId)
          const accName = acc?.name || ''
          const accCode = acc?.code ? String(acc.code) : ''
          const subName = l.subLedgerName || ''
          return accName.toLowerCase().includes(q) || accCode.includes(q) || subName.toLowerCase().includes(q)
        })
        return (
          voucher.number?.toLowerCase().includes(q) ||
          voucher.description?.toLowerCase().includes(q) ||
          voucher.notes?.toLowerCase().includes(q) ||
          linesMatch
        )
      })
    }
    return list
  }, [allVouchers, filterType, from, to, search, accountMap])

  const quickButtons = filterType ? QUICK.filter((item) => item.type === filterType) : QUICK

  async function save(values) {
    setBusy(true)
    try {
      if (values.id) {
        await updateVoucher(values.id, { ...values, uid: user?.uid })
      } else {
        await createVoucher({ ...values, uid: user?.uid })
      }
      setCreating(null)
      setEditing(null)
    } catch (err) {
      alert(err.message || 'حدث خطأ أثناء حفظ القيد.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await deleteVoucher(removing.id)
      setRemoving(null)
    } catch (err) {
      alert(err.message || 'حدث خطأ أثناء حذف القيد.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />

  if (accounts.length === 0) {
    return (
      <div>
        <PageHeader title={t('vouchers.title')} subtitle={t('vouchers.subtitle')} />
        <EmptyState title={t('vouchers.needAccounts')} message={t('vouchers.needAccountsHint')} />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={filterType ? t(`vouchers.type.${filterType}`) : t('vouchers.title')}
        subtitle={filterType ? t(`vouchers.hint.${filterType}`) : t('vouchers.subtitle')}
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {quickButtons.map(({ type, tone }) => (
          <button
            key={type}
            type="button"
            onClick={() => {
              setEditing(null)
              setCreating({ type })
            }}
            className={`rounded-xl px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90 ${tone}`}
          >
            + {t(`vouchers.type.${type}`)}
          </button>
        ))}
      </div>

      {/* Filter Toolbar */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-72">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="ابحث برقم السند، البيان، أو اسم الطرف..."
          />
        </div>

        <Field label={t('common.from')} className="w-full sm:w-40">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>

        <Field label={t('common.to')} className="w-full sm:w-40">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>

        {(from || to || search) && (
          <Button
            variant="ghost"
            onClick={() => {
              setFrom('')
              setTo('')
              setSearch('')
            }}
            className="text-xs"
          >
            ✕ إلغاء الفلترة
          </Button>
        )}

        <div className="ms-auto flex items-center gap-2 text-xs font-semibold text-slate-500">
          <span>
            عدد السندات: <b className="text-slate-800">{vouchers.length}</b>
          </span>
        </div>
      </div>

      {vouchers.length === 0 ? (
        <EmptyState title={t('vouchers.empty')} message={t('vouchers.emptyHint')} />
      ) : (
        <div className="space-y-3">
          {vouchers.map((voucher) => {
            const totals = voucherTotals(voucher.lines ?? [])
            return (
              <div key={voucher.id} className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="brand">{t(`vouchers.type.${voucher.type}`)}</Badge>
                    <span className="num text-sm font-bold text-slate-800">{voucher.number}</span>
                    <span className="text-xs text-slate-500">{voucher.description}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-500 me-2">
                      {formatDate(voucher.date, locale)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setCreating(null)
                        setEditing(voucher)
                      }}
                      className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 hover:bg-brand-50 transition"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemoving(voucher)}
                      className="rounded-lg px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 transition"
                    >
                      {t('common.delete')}
                    </button>
                  </div>
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
                      {(voucher.lines ?? []).map((item, index) => {
                        const account = accountMap.get(item.accountId)
                        return (
                          <tr key={index}>
                            <Td>
                              <span className="num me-2 text-xs font-bold text-slate-400">{account?.code ?? '—'}</span>
                              <span className="text-slate-700">{accountLabel(account, lang)}</span>
                              {item.subLedgerName && (
                                <span className="ms-2 inline-flex items-center rounded-md bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
                                  الطرف: {item.subLedgerName}
                                </span>
                              )}
                            </Td>
                            <Td>
                              {toNumber(item.debit) > 0 ? (
                                <span className="num font-bold text-slate-800">{formatMoney(item.debit)}</span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </Td>
                            <Td>
                              {toNumber(item.credit) > 0 ? (
                                <span className="num font-bold text-slate-800">{formatMoney(item.credit)}</span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </Td>
                          </tr>
                        )
                      })}
                      <tr className="bg-slate-50">
                        <Td className="text-xs font-extrabold text-slate-700">{t('common.total')}</Td>
                        <Td>
                          <span className="num font-extrabold text-slate-900">{formatMoney(totals.debit)}</span>
                        </Td>
                        <Td>
                          <span className="num font-extrabold text-slate-900">{formatMoney(totals.credit)}</span>
                        </Td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <VoucherForm
        open={Boolean(creating || editing)}
        type={editing?.type || creating?.type}
        initialData={editing}
        accounts={accounts}
        paymentMethods={paymentMethods}
        clients={clients}
        vendors={vendors}
        employees={employees}
        lang={lang}
        busy={busy}
        onClose={() => {
          setCreating(null)
          setEditing(null)
        }}
        onSave={save}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={t('common.deleteTitle')}
        message={t('common.deleteMsg', { name: removing?.number ?? '' })}
      />
    </div>
  )
}

const emptyLine = () => ({
  accountId: '',
  debit: '',
  credit: '',
  subLedgerType: null,
  subLedgerId: null,
  subLedgerName: '',
})

export function buildUnifiedAccountOptions(accounts = [], clients = [], vendors = [], employees = [], lang = 'ar') {
  const options = []

  const receivableAccount = accounts.find(
    (a) =>
      a.role === 'receivable' ||
      String(a.code) === '110201' ||
      String(a.code) === '112' ||
      String(a.code).startsWith('110201') ||
      String(a.code).startsWith('112'),
  )
  const vendorPayableAccount = accounts.find(
    (a) =>
      a.role === 'vendorPayable' ||
      String(a.code) === '2101' ||
      String(a.code) === '210101' ||
      String(a.code) === '211' ||
      String(a.code).startsWith('2101') ||
      String(a.code).startsWith('211'),
  )
  const empPayableAccount = accounts.find(
    (a) =>
      a.role === 'employeePayable' ||
      String(a.code) === '210201' ||
      String(a.code) === '212' ||
      String(a.code).startsWith('2102'),
  )
  const empAdvanceAccount = accounts.find(
    (a) =>
      String(a.code) === '110203' ||
      String(a.code) === '113' ||
      String(a.code).startsWith('110203') ||
      String(a.code).startsWith('113'),
  )

  const recAccId = receivableAccount?.id || '110201'
  const recAccCode = receivableAccount?.code || '110201'

  const venAccId = vendorPayableAccount?.id || '2101'
  const venAccCode = vendorPayableAccount?.code || '2101'

  const empPayAccId = empPayableAccount?.id || '210201'
  const empPayAccCode = empPayableAccount?.code || '210201'

  const empAdvAccId = empAdvanceAccount?.id || '110203'
  const empAdvAccCode = empAdvanceAccount?.code || '110203'

  // 1. Build client sub-options (deduplicated by client ID)
  const clientOptions = []
  const seenClientIds = new Set()
  const parentClients = clients.filter((c) => !c.parentId && c.id && !seenClientIds.has(c.id))
  parentClients.forEach((c) => seenClientIds.add(c.id))

  const childClientsMap = new Map()
  clients.forEach((c) => {
    if (c.parentId && c.id) {
      if (!childClientsMap.has(c.parentId)) childClientsMap.set(c.parentId, [])
      childClientsMap.get(c.parentId).push(c)
    }
  })

  parentClients.forEach((p, pIdx) => {
    const pCode = `${recAccCode}${String(pIdx + 1).padStart(2, '0')}`
    const pName = p.name || p.businessName || 'عميل بدون اسم'
    const hasBranches = childClientsMap.has(p.id)

    clientOptions.push({
      id: `client-${p.id}`,
      name: `${pCode} — ${pName}${hasBranches ? ' (عميل رئيسي)' : ' (عميل)'}`,
      code: pCode,
      type: 'client',
      accountId: recAccId,
      subLedgerType: 'client',
      subLedgerId: p.id,
      subLedgerName: pName,
    })

    const children = childClientsMap.get(p.id) || []
    children.forEach((b, bIdx) => {
      seenClientIds.add(b.id)
      const bCode = `${pCode}${String(bIdx + 1).padStart(2, '0')}`
      const bName = b.name || b.businessName || 'فرع بدون اسم'
      const fullBranchName = `${pName} - ${bName}`

      clientOptions.push({
        id: `client-${b.id}`,
        name: `${bCode} — ↳ ${fullBranchName} (فرع)`,
        code: bCode,
        type: 'client',
        accountId: recAccId,
        subLedgerType: 'client',
        subLedgerId: b.id,
        subLedgerName: fullBranchName,
      })
    })
  })

  clients.forEach((c, idx) => {
    if (c.id && !seenClientIds.has(c.id)) {
      seenClientIds.add(c.id)
      const cCode = `${recAccCode}${String(idx + 1).padStart(2, '0')}`
      const cName = c.name || c.businessName || 'عميل'
      clientOptions.push({
        id: `client-${c.id}`,
        name: `${cCode} — ${cName} (عميل)`,
        code: cCode,
        type: 'client',
        accountId: recAccId,
        subLedgerType: 'client',
        subLedgerId: c.id,
        subLedgerName: cName,
      })
    }
  })

  // 2. Build vendor sub-options (deduplicated by vendor ID)
  const vendorOptions = []
  const seenVendorIds = new Set()
  vendors.forEach((v, vIdx) => {
    if (v.id && !seenVendorIds.has(v.id)) {
      seenVendorIds.add(v.id)
      const vCode = `${venAccCode}${String(vIdx + 1).padStart(2, '0')}`
      const vName = v.name || 'مورد بدون اسم'
      vendorOptions.push({
        id: `vendor-${v.id}`,
        name: `${vCode} — ${vName} (مورد)`,
        code: vCode,
        type: 'vendor',
        accountId: venAccId,
        subLedgerType: 'vendor',
        subLedgerId: v.id,
        subLedgerName: vName,
      })
    }
  })

  // 3. Build employee payable sub-options (deduplicated by employee ID)
  const empPayableOptions = []
  const seenEmpPayableIds = new Set()
  employees.forEach((e, eIdx) => {
    if (e.id && !seenEmpPayableIds.has(e.id)) {
      seenEmpPayableIds.add(e.id)
      const eCode = `${empPayAccCode}${String(eIdx + 1).padStart(2, '0')}`
      const eName = e.name || 'موظف بدون اسم'
      empPayableOptions.push({
        id: `emp-payable-${e.id}`,
        name: `${eCode} — ${eName} (مستحقات موظف)`,
        code: eCode,
        type: 'employee',
        accountId: empPayAccId,
        subLedgerType: 'employee',
        subLedgerId: e.id,
        subLedgerName: eName,
      })
    }
  })

  // 4. Build employee advance sub-options (deduplicated by employee ID)
  const empAdvanceOptions = []
  const seenEmpAdvanceIds = new Set()
  employees.forEach((e, eIdx) => {
    if (e.id && !seenEmpAdvanceIds.has(e.id)) {
      seenEmpAdvanceIds.add(e.id)
      const eCode = `${empAdvAccCode}${String(eIdx + 1).padStart(2, '0')}`
      const eName = e.name || 'موظف بدون اسم'
      empAdvanceOptions.push({
        id: `emp-advance-${e.id}`,
        name: `${eCode} — ${eName} (سلف موظف)`,
        code: eCode,
        type: 'employee',
        accountId: empAdvAccId,
        subLedgerType: 'employee',
        subLedgerId: e.id,
        subLedgerName: eName,
      })
    }
  })

  let attachedClients = false
  let attachedVendors = false
  let attachedEmpPayable = false
  let attachedEmpAdvance = false

  // Deduplicate accounts array by id
  const uniqueAccounts = []
  const seenAccountIds = new Set()
  accounts.forEach((acc) => {
    if (acc.id && !seenAccountIds.has(acc.id)) {
      seenAccountIds.add(acc.id)
      uniqueAccounts.push(acc)
    }
  })

  uniqueAccounts.forEach((acc) => {
    const accLabel = accountLabel(acc, lang)
    options.push({
      id: acc.id,
      name: `${acc.code} — ${accLabel}${acc.isGroup ? ' (حساب رئيسي)' : ''}`,
      code: String(acc.code),
      type: 'account',
      accountId: acc.id,
      subLedgerType: null,
      subLedgerId: null,
      subLedgerName: '',
    })

    if (!attachedClients && (acc.id === recAccId || String(acc.code) === '110201' || String(acc.code) === '112')) {
      options.push(...clientOptions)
      attachedClients = true
    }
    if (
      !attachedVendors &&
      (acc.id === venAccId ||
        String(acc.code) === '2101' ||
        String(acc.code) === '210101' ||
        String(acc.code) === '211')
    ) {
      options.push(...vendorOptions)
      attachedVendors = true
    }
    if (
      !attachedEmpPayable &&
      (acc.id === empPayAccId || String(acc.code) === '210201' || String(acc.code) === '212')
    ) {
      options.push(...empPayableOptions)
      attachedEmpPayable = true
    }
    if (
      !attachedEmpAdvance &&
      (acc.id === empAdvAccId || String(acc.code) === '110203' || String(acc.code) === '113')
    ) {
      options.push(...empAdvanceOptions)
      attachedEmpAdvance = true
    }
  })

  if (!attachedClients && clientOptions.length > 0) options.push(...clientOptions)
  if (!attachedVendors && vendorOptions.length > 0) options.push(...vendorOptions)
  if (!attachedEmpPayable && empPayableOptions.length > 0) options.push(...empPayableOptions)
  if (!attachedEmpAdvance && empAdvanceOptions.length > 0) options.push(...empAdvanceOptions)

  // Final deduplication on option ID
  const finalOptions = []
  const seenFinalIds = new Set()
  options.forEach((opt) => {
    if (!seenFinalIds.has(opt.id)) {
      seenFinalIds.add(opt.id)
      finalOptions.push(opt)
    }
  })

  return finalOptions
}

function getOptionIdForLine(item, accounts) {
  if (!item) return ''
  if (item.subLedgerType === 'client' && item.subLedgerId) return `client-${item.subLedgerId}`
  if (item.subLedgerType === 'vendor' && item.subLedgerId) return `vendor-${item.subLedgerId}`
  if (item.subLedgerType === 'employee' && item.subLedgerId) {
    const acc = accounts?.find((a) => a.id === item.accountId)
    if (acc?.code === '110203' || String(acc?.code).startsWith('110203')) {
      return `emp-advance-${item.subLedgerId}`
    }
    return `emp-payable-${item.subLedgerId}`
  }
  return item.accountId || ''
}

function AccountSelect({ options = [], value, onChange, placeholder = 'اختر الحساب...' }) {
  return (
    <SearchableSelect
      options={options}
      value={value}
      placeholder={placeholder}
      searchPlaceholder="ابحث باسم الحساب، الكود، أو اسم العميل/الموظف/المورد..."
      onChange={(val) => {
        const selected = options.find((opt) => opt.id === val)
        onChange(val, selected)
      }}
    />
  )
}

function VoucherForm({
  open,
  type,
  initialData = null,
  accounts = [],
  paymentMethods = [],
  clients = [],
  vendors = [],
  employees = [],
  lang,
  busy,
  onClose,
  onSave,
}) {
  const { t } = useI18n()

  const [date, setDate] = useState(todayISO())
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState([emptyLine(), emptyLine()])
  const [amount, setAmount] = useState('')
  const [debitId, setDebitId] = useState('')
  const [creditId, setCreditId] = useState('')
  const [touched, setTouched] = useState(false)

  const [debitSubLedger, setDebitSubLedger] = useState({ subLedgerType: null, subLedgerId: null, subLedgerName: '' })
  const [creditSubLedger, setCreditSubLedger] = useState({ subLedgerType: null, subLedgerId: null, subLedgerName: '' })

  const isManual =
    type === 'manual' ||
    type === 'opening' ||
    (Boolean(initialData?.lines) && initialData.lines.length > 2)

  const unifiedOptions = useMemo(
    () => buildUnifiedAccountOptions(accounts, clients, vendors, employees, lang),
    [accounts, clients, vendors, employees, lang],
  )

  /* الطرف النقدي في السند السريع يعرض حسابات الخزينة فقط */
  const treasury = treasuryAccounts(accounts, paymentMethods)
  const treasuryOptions = useMemo(() => {
    const seen = new Set()
    const opts = []
    treasury.forEach((acc) => {
      if (!seen.has(acc.id)) {
        seen.add(acc.id)
        opts.push({
          id: acc.id,
          name: `${acc.code} — ${accountLabel(acc, lang)}`,
          code: String(acc.code),
          type: 'account',
          accountId: acc.id,
          subLedgerType: null,
          subLedgerId: null,
          subLedgerName: '',
        })
      }
    })
    return opts
  }, [treasury, lang])

  const quickShape = VOUCHER_SHAPES[type]
  const debitOptions = quickShape?.debitRole === 'cash' ? treasuryOptions : unifiedOptions
  const creditOptions = quickShape?.creditRole === 'cash' ? treasuryOptions : unifiedOptions

  useEffect(() => {
    if (!open) return

    if (initialData) {
      setDate(initialData.date || todayISO())
      setDescription(initialData.description || '')
      setNotes(initialData.notes || '')
      setTouched(false)

      const isManualEntry =
        initialData.type === 'manual' ||
        initialData.type === 'opening' ||
        (Boolean(initialData.lines) && initialData.lines.length > 2)

      if (isManualEntry) {
        setLines(
          initialData.lines?.length
            ? initialData.lines.map((l) => ({
                accountId: l.accountId || '',
                debit: l.debit !== undefined && l.debit !== null && l.debit !== 0 ? String(l.debit) : '',
                credit: l.credit !== undefined && l.credit !== null && l.credit !== 0 ? String(l.credit) : '',
                subLedgerType: l.subLedgerType || null,
                subLedgerId: l.subLedgerId || null,
                subLedgerName: l.subLedgerName || '',
              }))
            : [emptyLine(), emptyLine()],
        )
        setAmount('')
        setDebitId('')
        setCreditId('')
        setDebitSubLedger({ subLedgerType: null, subLedgerId: null, subLedgerName: '' })
        setCreditSubLedger({ subLedgerType: null, subLedgerId: null, subLedgerName: '' })
      } else {
        const debitLine = initialData.lines?.find((l) => toNumber(l.debit) > 0) || initialData.lines?.[0]
        const creditLine = initialData.lines?.find((l) => toNumber(l.credit) > 0) || initialData.lines?.[1]

        const amtVal = debitLine && toNumber(debitLine.debit) > 0 ? debitLine.debit : creditLine?.credit ?? ''
        setAmount(amtVal ? String(amtVal) : '')

        setDebitId(debitLine?.accountId || '')
        setDebitSubLedger({
          subLedgerType: debitLine?.subLedgerType || null,
          subLedgerId: debitLine?.subLedgerId || null,
          subLedgerName: debitLine?.subLedgerName || '',
        })

        setCreditId(creditLine?.accountId || '')
        setCreditSubLedger({
          subLedgerType: creditLine?.subLedgerType || null,
          subLedgerId: creditLine?.subLedgerId || null,
          subLedgerName: creditLine?.subLedgerName || '',
        })

        setLines([emptyLine(), emptyLine()])
      }
    } else {
      setDate(todayISO())
      setDescription('')
      setNotes('')
      setAmount('')
      setTouched(false)
      setDebitSubLedger({ subLedgerType: null, subLedgerId: null, subLedgerName: '' })
      setCreditSubLedger({ subLedgerType: null, subLedgerId: null, subLedgerName: '' })

      const shape = VOUCHER_SHAPES[type]
      setDebitId(shape?.debitRole ? (byRole(accounts, shape.debitRole)?.id ?? '') : '')
      setCreditId(shape?.creditRole ? (byRole(accounts, shape.creditRole)?.id ?? '') : '')

      if (type === 'opening') {
        setLines([emptyLine(), emptyLine(), emptyLine()])
      } else {
        setLines([emptyLine(), emptyLine()])
      }
    }
  }, [open, initialData, type, accounts])

  function setLine(index, patch) {
    setLines((current) => current.map((item, position) => (position === index ? { ...item, ...patch } : item)))
  }

  /* القيد النهائي: إما بنود حرة، أو سطرين من المستند السريع */
  const finalLines = isManual
    ? lines
    : [
        {
          accountId: debitId,
          debit: toNumber(amount),
          credit: 0,
          subLedgerType: debitSubLedger.subLedgerType || null,
          subLedgerId: debitSubLedger.subLedgerId || null,
          subLedgerName: debitSubLedger.subLedgerName || '',
        },
        {
          accountId: creditId,
          debit: 0,
          credit: toNumber(amount),
          subLedgerType: creditSubLedger.subLedgerType || null,
          subLedgerId: creditSubLedger.subLedgerId || null,
          subLedgerName: creditSubLedger.subLedgerName || '',
        },
      ]

  const totals = voucherTotals(finalLines)

  const hasIncompleteLine = finalLines.some(
    (entry) => (toNumber(entry.debit) > 0 || toNumber(entry.credit) > 0) && !entry.accountId,
  )

  const invalid = isManual
    ? !totals.balanced || hasIncompleteLine
    : !debitId || !creditId || toNumber(amount) <= 0 || debitId === creditId

  function submit() {
    setTouched(true)
    if (invalid) return
    onSave({
      id: initialData?.id,
      date,
      type: initialData?.type || type,
      description: description.trim() || t(`vouchers.type.${type}`),
      notes: notes.trim(),
      lines: finalLines,
    })
  }

  const modalTitle = initialData
    ? `${t('common.edit')}: ${t(`vouchers.type.${initialData.type || type}`)} (${initialData.number})`
    : t(`vouchers.type.${type}`)

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide={isManual}
      title={modalTitle}
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
        {t(`vouchers.hint.${initialData?.type || type}`)}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('common.date')}>
          <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>

        <Field label={t('common.description')}>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </div>

      {isManual ? (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-bold text-slate-900">{t('vouchers.lines')}</h4>
            <Button variant="soft" onClick={() => setLines((current) => [...current, emptyLine()])}>
              + {t('vouchers.addLine')}
            </Button>
          </div>

          <div className="space-y-2">
            {lines.map((item, index) => {
              return (
                <div key={index} className="space-y-2 rounded-xl bg-slate-50 p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_130px_130px_auto]">
                    <AccountSelect
                      options={unifiedOptions}
                      value={getOptionIdForLine(item, accounts)}
                      onChange={(val, selected) => {
                        if (selected) {
                          setLine(index, {
                            accountId: selected.accountId,
                            subLedgerType: selected.subLedgerType,
                            subLedgerId: selected.subLedgerId,
                            subLedgerName: selected.subLedgerName,
                          })
                        } else {
                          setLine(index, {
                            accountId: val || '',
                            subLedgerType: null,
                            subLedgerId: null,
                            subLedgerName: '',
                          })
                        }
                      }}
                    />
                    <Input
                      numeric
                      placeholder={t('acct.debit')}
                      value={item.debit}
                      onChange={(event) => setLine(index, { debit: event.target.value, credit: '' })}
                    />
                    <Input
                      numeric
                      placeholder={t('acct.credit')}
                      value={item.credit}
                      onChange={(event) => setLine(index, { credit: event.target.value, debit: '' })}
                    />
                    {lines.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setLines((current) => current.filter((_, position) => position !== index))}
                        className="rounded-lg px-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-slate-50 px-4 py-3">
            <span className="text-xs font-semibold text-slate-500">
              {t('acct.debit')}: <span className="num font-bold text-slate-900">{formatMoney(totals.debit)}</span>
            </span>
            <span className="text-xs font-semibold text-slate-500">
              {t('acct.credit')}: <span className="num font-bold text-slate-900">{formatMoney(totals.credit)}</span>
            </span>
            <span
              className={`text-xs font-extrabold ${totals.balanced && !hasIncompleteLine ? 'text-emerald-600' : 'text-red-600'}`}
            >
              {hasIncompleteLine
                ? t('vouchers.missingAccount')
                : totals.balanced
                  ? t('acct.balanced')
                  : t('vouchers.mustBalance')}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.amount')} error={touched && toNumber(amount) <= 0 ? t('common.required') : null}>
              <Input numeric value={amount} onChange={(event) => setAmount(event.target.value)} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Field
                label={quickShape?.debitRole === 'cash' ? t('vouchers.treasury') : t('vouchers.debitAccount')}
                hint={t('vouchers.debitHint')}
              >
                <AccountSelect
                  options={debitOptions}
                  value={getOptionIdForLine({ accountId: debitId, ...debitSubLedger }, accounts)}
                  onChange={(val, selected) => {
                    if (selected) {
                      setDebitId(selected.accountId)
                      setDebitSubLedger({
                        subLedgerType: selected.subLedgerType,
                        subLedgerId: selected.subLedgerId,
                        subLedgerName: selected.subLedgerName,
                      })
                    } else {
                      setDebitId(val || '')
                      setDebitSubLedger({ subLedgerType: null, subLedgerId: null, subLedgerName: '' })
                    }
                  }}
                />
              </Field>
            </div>

            <div>
              <Field
                label={quickShape?.creditRole === 'cash' ? t('vouchers.treasury') : t('vouchers.creditAccount')}
                hint={t('vouchers.creditHint')}
              >
                <AccountSelect
                  options={creditOptions}
                  value={getOptionIdForLine({ accountId: creditId, ...creditSubLedger }, accounts)}
                  onChange={(val, selected) => {
                    if (selected) {
                      setCreditId(selected.accountId)
                      setCreditSubLedger({
                        subLedgerType: selected.subLedgerType,
                        subLedgerId: selected.subLedgerId,
                        subLedgerName: selected.subLedgerName,
                      })
                    } else {
                      setCreditId(val || '')
                      setCreditSubLedger({ subLedgerType: null, subLedgerId: null, subLedgerName: '' })
                    }
                  }}
                />
              </Field>
            </div>
          </div>
        </div>
      )}

      <Field label={`${t('common.notes')} (${t('common.optional')})`} className="mt-4">
        <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>
    </Modal>
  )
}
