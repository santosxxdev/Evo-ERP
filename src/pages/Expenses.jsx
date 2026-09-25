import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../i18n'
import { COL, createDoc, deleteDocById, updateDocById, useCollection, useLookup } from '../lib/db'
import SearchableSelect from '../components/SearchableSelect'
import { ACCOUNTS_COL, accountLabel, treasuryAccounts } from '../lib/accounts'
import { VENDORS_COL } from './Vendors'
import { formatDate, formatMoney, isWithin, monthKey, todayISO, toNumber } from '../lib/format'
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
  Td,
  TableWrap,
  Th,
} from '../components/ui'

export default function Expenses() {
  const { t, locale, lang } = useI18n()
  const { rows: expenseRows, loading: loadingExpenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: vouchers, loading: loadingVouchers } = useCollection(COL.vouchers, 'date', 'desc')
  const loading = loadingExpenses || loadingVouchers

  const { rows: categories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: vendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: accounts } = useCollection(ACCOUNTS_COL, 'code', 'asc')
  const { rows: paymentMethods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const categoryMap = useLookup(categories)
  const clientMap = useLookup(clients)
  const vendorMap = useLookup(vendors)
  const employeeMap = useLookup(employees)

  const [search, setSearch] = useState('')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const accountByCode = useMemo(() => new Map(accounts.map((a) => [String(a.code), a])), [accounts])

  const subAccountOptions = useMemo(() => {
    const postable = accounts.filter((a) => !a.isGroup)
    return postable
      .map((a) => ({
        id: a.id,
        code: String(a.code),
        name: `${a.code} — ${accountLabel(a, lang)}`,
        type: a.type,
        isExpense: a.type === 'expense' || String(a.code).startsWith('5'),
        badge:
          a.type === 'expense' || String(a.code).startsWith('5')
            ? 'مصروفات'
            : a.type === 'asset'
              ? 'أصول'
              : a.type === 'liability'
                ? 'التزامات'
                : 'حساب فرعي',
      }))
      .sort((a, b) => {
        if (a.isExpense && !b.isExpense) return -1
        if (!a.isExpense && b.isExpense) return 1
        return a.code.localeCompare(b.code)
      })
  }, [accounts, lang])

  function resolveRowAccount(row) {
    if (row.accountId && accountById.has(row.accountId)) {
      return accountById.get(row.accountId)
    }
    if (row.accountCode && accountByCode.has(String(row.accountCode))) {
      return accountByCode.get(String(row.accountCode))
    }
    if (row.target?.kind === 'account' && accountById.has(row.target.id)) {
      return accountById.get(row.target.id)
    }
    if (row.categoryId) {
      const cat = categoryMap.get(row.categoryId)
      if (cat?.accountId && accountById.has(cat.accountId)) {
        return accountById.get(cat.accountId)
      }
    }
    return null
  }

  const combinedRows = useMemo(() => {
    const list = [...expenseRows]
    for (const v of vouchers) {
      if (v.type !== 'payment') continue
      if (v.sourceType === 'expense' && v.sourceId && expenseRows.some((e) => e.id === v.sourceId)) {
        continue
      }
      const debitLine = v.lines?.find((l) => toNumber(l.debit) > 0) || v.lines?.[0]
      const creditLine = v.lines?.find((l) => toNumber(l.credit) > 0) || v.lines?.[1]

      list.push({
        id: v.id,
        date: v.date,
        amount: toNumber(v.totalDebit || v.amount || 0),
        description: v.description || v.notes || 'سند صرف',
        accountId: debitLine?.accountId,
        treasuryAccountId: creditLine?.accountId,
        target: debitLine?.subLedgerName
          ? {
              name: debitLine.subLedgerName,
              kind: debitLine.subLedgerType || 'other',
              id: debitLine.subLedgerId,
            }
          : null,
        source: 'voucher',
        voucherNumber: v.number,
      })
    }
    return list.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }, [expenseRows, vouchers])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return combinedRows.filter((row) => {
      const rowAcc = resolveRowAccount(row)
      if (selectedAccountId && rowAcc?.id !== selectedAccountId && row.accountId !== selectedAccountId) {
        return false
      }
      if ((from || to) && !isWithin(row.date, from, to)) return false
      if (!term) return true
      const accName = rowAcc ? accountLabel(rowAcc, lang) : ''
      const accCode = rowAcc?.code ? String(rowAcc.code) : ''
      return [
        row.description,
        row.paidBy,
        row.categoryName,
        row.accountName,
        accName,
        accCode,
        row.target?.name,
        row.voucherNumber,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(term)
    })
  }, [combinedRows, search, selectedAccountId, from, to, accountById, accountByCode, categoryMap, lang])

  const totalShown = filtered.reduce((sum, row) => sum + toNumber(row.amount), 0)
  const monthTotal = combinedRows
    .filter((row) => monthKey(row.date) === monthKey(todayISO()))
    .reduce((sum, row) => sum + toNumber(row.amount), 0)

  async function handleSave(values) {
    setBusy(true)
    if (editing?.id) await updateDocById(COL.expenses, editing.id, values)
    else await createDoc(COL.expenses, { ...values, source: 'manual' })
    setBusy(false)
    setEditing(null)
  }

  async function handleDelete() {
    setBusy(true)
    await deleteDocById(COL.expenses, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('expenses.title')} subtitle={t('expenses.subtitle')}>
        <div className="flex flex-wrap gap-2">
          <Link to="/vouchers?type=payment">
            <Button variant="secondary">
              سندات الصرف ({vouchers.filter((v) => v.type === 'payment').length}) ←
            </Button>
          </Link>
          <Button onClick={() => setEditing({})}>+ {t('expenses.add')}</Button>
        </div>
      </PageHeader>

      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <div className="card p-5">
          <p className="text-sm font-semibold text-slate-500">{t('expenses.thisMonth')}</p>
          <p className="mt-2 text-2xl font-extrabold text-rose-600">
            <span className="num">{formatMoney(monthTotal)}</span>
            <span className="ms-1.5 text-sm font-semibold text-slate-400">{t('common.currency')}</span>
          </p>
        </div>
        <div className="card p-5">
          <p className="text-sm font-semibold text-slate-500">{t('expenses.totalFiltered')}</p>
          <p className="mt-2 text-2xl font-extrabold text-slate-900">
            <span className="num">{formatMoney(totalShown)}</span>
            <span className="ms-1.5 text-sm font-semibold text-slate-400">{t('common.currency')}</span>
          </p>
        </div>
      </div>

      {combinedRows.length === 0 ? (
        <EmptyState
          title={t('expenses.empty')}
          message={t('expenses.emptyHint')}
          action={<Button onClick={() => setEditing({})}>+ {t('expenses.add')}</Button>}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <SearchInput value={search} onChange={setSearch} placeholder={t('common.search')} />

            <Select
              value={selectedAccountId}
              onChange={(event) => setSelectedAccountId(event.target.value)}
              className="w-auto max-w-xs"
            >
              <option value="">كل الحسابات الفرعية</option>
              {subAccountOptions.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name}
                </option>
              ))}
            </Select>

            <Field label={t('common.from')} className="w-40">
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>

            <Field label={t('common.to')} className="w-40">
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>

            {(from || to || selectedAccountId || search) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFrom('')
                  setTo('')
                  setSelectedAccountId('')
                  setSearch('')
                }}
              >
                {t('common.reset')}
              </Button>
            )}
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                <Th>الحساب الفرعي (شجرة الحسابات)</Th>
                <Th>{t('expenses.reason')}</Th>
                <Th>الجهة / العميل</Th>
                <Th>{t('expenses.treasury')}</Th>
                <Th>{t('common.amount')}</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const auto = row.source === 'employee'
                const rowAcc = resolveRowAccount(row)
                const treasury = row.treasuryAccountId
                  ? accountById.get(row.treasuryAccountId)
                  : null

                return (
                  <tr key={row.id}>
                    <Td className="text-slate-600">{formatDate(row.date, locale)}</Td>
                    <Td>
                      {rowAcc ? (
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50/80 px-2.5 py-1 text-xs font-bold text-purple-900">
                          <span className="num font-black text-purple-700">{rowAcc.code}</span>
                          <span>{accountLabel(rowAcc, lang)}</span>
                        </span>
                      ) : (
                        <Badge tone="brand">
                          {categoryMap.get(row.categoryId)?.name ?? row.categoryName ?? 'مصروف عام'}
                        </Badge>
                      )}
                    </Td>
                    <Td className="text-slate-700 font-medium">
                      <div className="flex items-center gap-2">
                        <span>{row.description || '—'}</span>
                        {row.source === 'voucher' && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">
                            سند صرف {row.voucherNumber ? `(${row.voucherNumber})` : ''}
                          </span>
                        )}
                        {auto && <span className="ms-2 text-[11px] text-slate-400">({t('expenses.auto')})</span>}
                      </div>
                    </Td>
                    <Td>
                      {row.target?.name ? (
                        <Badge tone="sky">{row.target.name}</Badge>
                      ) : row.clientId && clientMap.get(row.clientId) ? (
                        <Badge tone="amber">{clientMap.get(row.clientId).name}</Badge>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>
                    <Td className="text-slate-600">
                      {treasury ? (
                        <span className="text-xs font-semibold text-slate-700">
                          {treasury.code} — {accountLabel(treasury, lang)}
                        </span>
                      ) : (
                        row.paidBy || '—'
                      )}
                    </Td>
                    <Td>
                      <span
                        className={`num font-bold ${
                          toNumber(row.amount) < 0 ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {formatMoney(row.amount)}
                      </span>
                    </Td>
                    <Td>
                      {row.source === 'voucher' ? (
                        <Link
                          to="/vouchers?type=payment"
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 inline-block"
                        >
                          عرض السند
                        </Link>
                      ) : auto ? (
                        <span className="text-[11px] text-slate-400">{t('expenses.autoHint')}</span>
                      ) : (
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setEditing(row)}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                          >
                            {t('common.edit')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setRemoving(row)}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                          >
                            {t('common.delete')}
                          </button>
                        </div>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
        </>
      )}

      <ExpenseForm
        open={Boolean(editing)}
        row={editing}
        categories={categories}
        clients={clients}
        employees={employees}
        vendors={vendors}
        accounts={accounts}
        treasuries={treasuryAccounts(accounts, paymentMethods)}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={handleSave}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={handleDelete}
        title={t('common.deleteTitle')}
        message={t('common.deleteMsg', { name: removing?.description ?? '' })}
      />
    </div>
  )
}

function ExpenseForm({
  open,
  row,
  categories,
  clients,
  employees = [],
  vendors = [],
  accounts = [],
  treasuries = [],
  busy,
  onClose,
  onSave,
}) {
  const { t, lang } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const postableAccounts = useMemo(() => accounts.filter((account) => !account.isGroup), [accounts])

  const subAccountOptions = useMemo(() => {
    return postableAccounts
      .map((a) => ({
        id: a.id,
        code: String(a.code),
        name: `${a.code} — ${accountLabel(a, lang)}`,
        type: a.type,
        isExpense: a.type === 'expense' || String(a.code).startsWith('5'),
        badge:
          a.type === 'expense' || String(a.code).startsWith('5')
            ? 'مصروفات'
            : a.type === 'asset'
              ? 'أصول'
              : a.type === 'liability'
                ? 'التزامات'
                : 'حساب فرعي',
      }))
      .sort((a, b) => {
        if (a.isExpense && !b.isExpense) return -1
        if (!a.isExpense && b.isExpense) return 1
        return a.code.localeCompare(b.code)
      })
  }, [postableAccounts, lang])

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)

    // Find initial account ID from row
    let initialAccountId = row?.accountId ?? ''
    if (!initialAccountId && row?.accountCode) {
      const match = postableAccounts.find((a) => String(a.code) === String(row.accountCode))
      if (match) initialAccountId = match.id
    }
    if (!initialAccountId && row?.target?.kind === 'account') {
      initialAccountId = row.target.id
    }
    if (!initialAccountId && row?.categoryId) {
      const cat = categories.find((c) => c.id === row.categoryId)
      if (cat?.accountId) initialAccountId = cat.accountId
    }

    setForm({
      accountId: initialAccountId,
      categoryId: row?.categoryId ?? '',
      description: row?.description ?? '',
      amount: row?.amount ?? '',
      date: row?.date || todayISO(),
      treasuryAccountId: row?.treasuryAccountId ?? '',
      targetKind: row?.target?.kind && row.target.kind !== 'account' ? row.target.kind : 'none',
      targetId: row?.target?.id ?? '',
      settled: row?.settled !== false,
      clientId: row?.clientId ?? '',
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  const selectedAccount = postableAccounts.find((a) => a.id === form.accountId)

  const invalid = !form.accountId || toNumber(form.amount) === 0 || !form.description?.trim()

  const selectedIsAdSpend =
    Boolean(categories.find((item) => item.id === form.categoryId)?.isAdSpend) ||
    String(selectedAccount?.code).startsWith('53') ||
    selectedAccount?.role === 'costOther'

  const targetOptions =
    form.targetKind === 'vendor'
      ? vendors.map((v) => ({ id: v.id, name: v.name }))
      : form.targetKind === 'employee'
        ? employees.map((e) => ({ id: e.id, name: e.name }))
        : form.targetKind === 'client'
          ? clients.map((c) => ({ id: c.id, name: c.name }))
          : []

  const onAccountKind = form.targetKind === 'vendor' || form.targetKind === 'employee'

  function submit() {
    setTouched(true)
    if (invalid) return

    const matchedCat = categories.find((item) => item.accountId === form.accountId || item.id === form.categoryId)
    const target =
      form.targetKind && form.targetKind !== 'none' && form.targetId
        ? {
            kind: form.targetKind,
            id: form.targetId,
            name: targetOptions.find((option) => option.id === form.targetId)?.name ?? '',
          }
        : null

    onSave({
      accountId: form.accountId,
      accountCode: selectedAccount?.code ? String(selectedAccount.code) : '',
      accountName: selectedAccount ? accountLabel(selectedAccount, lang) : '',
      categoryId: matchedCat?.id || form.categoryId || null,
      categoryName: selectedAccount ? accountLabel(selectedAccount, lang) : (matchedCat?.name ?? ''),
      description: form.description.trim(),
      amount: toNumber(form.amount),
      date: form.date,
      treasuryAccountId: form.treasuryAccountId || null,
      target,
      settled: onAccountKind ? Boolean(form.settled) : true,
      paidBy: '',
      clientId: form.clientId || null,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={row?.id ? t('expenses.edit') : t('expenses.add')}
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
      <div className="space-y-4">
        {/* اختيار الحساب الفرعي من شجرة الحسابات */}
        <Field
          label="الحساب الفرعي (شجرة الحسابات)"
          hint="اختر الحساب الفرعي من دليل وشجرة الحسابات لتسجيل وتوجيه المصروف محاسبيًا"
          error={touched && !form.accountId ? t('common.required') : null}
        >
          <SearchableSelect
            options={subAccountOptions}
            value={form.accountId ?? ''}
            placeholder="اختر الحساب الفرعي للمصروف..."
            searchPlaceholder="ابحث باسم الحساب الفرعي أو الكود..."
            onChange={(val) => {
              const acc = postableAccounts.find((a) => a.id === val)
              const matchedCat = categories.find((c) => c.accountId === val)
              const adAcc = treasuries.find((a) => a.role === 'adTreasury' || String(a.code) === '110103')
              const isAd = matchedCat?.isAdSpend || String(acc?.code).startsWith('53')
              setForm((current) => ({
                ...current,
                accountId: val,
                categoryId: matchedCat?.id || current.categoryId,
                treasuryAccountId: isAd && !current.treasuryAccountId && adAcc ? adAcc.id : current.treasuryAccountId,
              }))
            }}
          />
        </Field>

        {/* سبب / بيان الصرف */}
        <Field
          label={t('expenses.reason')}
          hint="وصف وتفاصيل العملية أو الفاتورة"
          error={touched && !form.description?.trim() ? t('common.required') : null}
        >
          <Input
            value={form.description ?? ''}
            onChange={(event) => set('description', event.target.value)}
            placeholder="مثال: فاتورة كهرباء المقر، إيجار المكتب، شراء مستلزمات..."
          />
        </Field>

        {/* المبلغ والتاريخ */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('common.amount')}
            error={touched && toNumber(form.amount) === 0 ? t('common.required') : null}
          >
            <Input numeric value={form.amount ?? ''} onChange={(event) => set('amount', event.target.value)} />
          </Field>

          <Field label={t('common.date')}>
            <Input type="date" value={form.date ?? ''} onChange={(event) => set('date', event.target.value)} />
          </Field>
        </div>

        {/* الخزينة / الحساب الدائن (المصدر) */}
        <Field label={t('expenses.treasury')} hint="الخزنة أو الحساب البنكي / المحفظة التي تم الصرف منها">
          <Select
            value={form.treasuryAccountId ?? ''}
            onChange={(event) => set('treasuryAccountId', event.target.value)}
          >
            <option value="">— اختر الخزينة أو الحساب البنكي —</option>
            {treasuries.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {accountLabel(account, lang)}
              </option>
            ))}
          </Select>
        </Field>

        {/* مستفيد أو جهة إضافية (اختياري) */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="جهة مستفيدة / ربط إضافي (اختياري)">
              <Select
                value={form.targetKind ?? 'none'}
                onChange={(event) =>
                  setForm((current) => ({ ...current, targetKind: event.target.value, targetId: '' }))
                }
              >
                <option value="none">بدون ربط إضافي (مباشر على الحساب)</option>
                <option value="vendor">مورد / فريلانسر</option>
                <option value="employee">موظف / عامل</option>
                <option value="client">عميل</option>
              </Select>
            </Field>

            {form.targetKind !== 'none' && (
              <Field label="تحديد الاسم / الجهة">
                <SearchableSelect
                  options={targetOptions}
                  value={form.targetId ?? ''}
                  placeholder="ابحث بالاسم..."
                  searchPlaceholder="ابحث بالاسم أو رقم الهاتف..."
                  onChange={(val) => set('targetId', val)}
                />
              </Field>
            )}
          </div>

          {onAccountKind && form.targetId && (
            <label className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
              <input
                type="checkbox"
                checked={Boolean(form.settled)}
                onChange={(event) => set('settled', event.target.checked)}
                className="h-4 w-4 accent-brand-600"
              />
              <span className="text-xs font-semibold text-slate-700">تم السداد نقدًا فورًا (غير معلق على الحساب)</span>
            </label>
          )}
        </div>

        {/* ممول من ميزانية عميل لو كان الصرف لإعلانات */}
        {selectedIsAdSpend && (
          <Field label={t('expenses.forClient')} hint={t('expenses.forClientHint')}>
            <SearchableSelect
              options={clients}
              value={form.clientId ?? ''}
              placeholder={t('expenses.ownMarketing')}
              searchPlaceholder="ابحث باسم العميل أو الهاتف..."
              onChange={(val) => set('clientId', val)}
            />
          </Field>
        )}
      </div>
    </Modal>
  )
}
