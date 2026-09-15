import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { COL, createDoc, deleteDocById, updateDocById, useCollection, useLookup } from '../lib/db'
import SearchableSelect from '../components/SearchableSelect'
import { ACCOUNTS_COL, accountLabel, treasuryAccounts } from '../lib/accounts'
import { VENDORS_COL } from './Vendors'
import { formatDate, formatMoney, isWithin, monthKey, monthStartISO, todayISO, toNumber } from '../lib/format'
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
  const { t, locale } = useI18n()
  const { rows, loading } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: categories } = useCollection(COL.expenseCategories, 'name', 'asc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: vendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: accounts } = useCollection(ACCOUNTS_COL, 'code', 'asc')
  const { rows: paymentMethods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const categoryMap = useLookup(categories)
  const clientMap = useLookup(clients)

  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (categoryId && row.categoryId !== categoryId) return false
      if ((from || to) && !isWithin(row.date, from, to)) return false
      if (!term) return true
      return [row.description, row.paidBy, row.categoryName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(term)
    })
  }, [rows, search, categoryId, from, to])

  const totalShown = filtered.reduce((sum, row) => sum + toNumber(row.amount), 0)
  const monthTotal = rows
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
        <Button onClick={() => setEditing({})}>+ {t('expenses.add')}</Button>
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

      {rows.length === 0 ? (
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
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className="w-auto"
            >
              <option value="">{t('common.all')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>

            <Field label={t('common.from')} className="w-40">
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>

            <Field label={t('common.to')} className="w-40">
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>

            {(from || to || categoryId || search) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFrom('')
                  setTo('')
                  setCategoryId('')
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
                <Th>{t('expenses.category')}</Th>
                <Th>{t('expenses.reason')}</Th>
                <Th>{t('expenses.target')}</Th>
                <Th>{t('expenses.treasury')}</Th>
                <Th>{t('common.amount')}</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const auto = row.source === 'employee'
                return (
                  <tr key={row.id}>
                    <Td className="text-slate-600">{formatDate(row.date, locale)}</Td>
                    <Td>
                      <Badge tone="brand">
                        {categoryMap.get(row.categoryId)?.name ?? row.categoryName ?? '—'}
                      </Badge>
                    </Td>
                    <Td className="text-slate-700">
                      {row.description || '—'}
                      {auto && <span className="ms-2 text-[11px] text-slate-400">({t('expenses.auto')})</span>}
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
                      {row.treasuryAccountId
                        ? accountLabel(accounts.find((a) => a.id === row.treasuryAccountId), locale === 'ar-EG' ? 'ar' : 'en')
                        : row.paidBy || '—'}
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
                      {auto ? (
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

const TARGET_KINDS = ['none', 'vendor', 'employee', 'client', 'account']

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

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      categoryId: row?.categoryId ?? '',
      description: row?.description ?? '',
      amount: row?.amount ?? '',
      date: row?.date || todayISO(),
      treasuryAccountId: row?.treasuryAccountId ?? '',
      targetKind: row?.target?.kind ?? 'none',
      targetId: row?.target?.id ?? '',
      settled: row?.settled !== false,
      clientId: row?.clientId ?? '',
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  const invalid = !form.categoryId || toNumber(form.amount) === 0 || !form.description?.trim()

  /* ربط العميل يظهر فقط لفئات الإنفاق الإعلاني، لأنها التي قد تُموَّل من ميزانية عميل */
  const selectedIsAdSpend = Boolean(categories.find((item) => item.id === form.categoryId)?.isAdSpend)

  const postable = accounts.filter((account) => !account.isGroup)
  const targetOptions =
    form.targetKind === 'vendor'
      ? vendors.map((v) => ({ id: v.id, name: v.name }))
      : form.targetKind === 'employee'
        ? employees.map((e) => ({ id: e.id, name: e.name }))
        : form.targetKind === 'client'
          ? clients.map((c) => ({ id: c.id, name: c.name }))
          : form.targetKind === 'account'
            ? postable.map((a) => ({ id: a.id, name: `${a.code} — ${accountLabel(a, lang)}` }))
            : []

  const onAccountKind = form.targetKind === 'vendor' || form.targetKind === 'employee'

  function submit() {
    setTouched(true)
    if (invalid) return
    const category = categories.find((item) => item.id === form.categoryId)
    const target =
      form.targetKind !== 'none' && form.targetId
        ? {
            kind: form.targetKind,
            id: form.targetId,
            name: targetOptions.find((option) => option.id === form.targetId)?.name ?? '',
          }
        : null
    onSave({
      categoryId: form.categoryId,
      categoryName: category?.name ?? '',
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

  const active = categories.filter((category) => !category.archived)

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
        <Field
          label={t('expenses.category')}
          error={touched && !form.categoryId ? t('common.required') : null}
        >
          <SearchableSelect
            options={active}
            value={form.categoryId ?? ''}
            placeholder={t('expenses.category')}
            searchPlaceholder="ابحث باسم فئة المصروفات..."
            onChange={(val) => set('categoryId', val)}
          />
        </Field>

        <Field
          label={t('expenses.reason')}
          error={touched && !form.description?.trim() ? t('common.required') : null}
        >
          <Input value={form.description ?? ''} onChange={(event) => set('description', event.target.value)} />
        </Field>

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

        <Field label={t('expenses.treasury')} hint={t('expenses.treasuryHint')}>
          <Select
            value={form.treasuryAccountId ?? ''}
            onChange={(event) => set('treasuryAccountId', event.target.value)}
          >
            <option value="">—</option>
            {treasuries.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {accountLabel(account, lang)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('expenses.targetKind')}>
            <Select
              value={form.targetKind ?? 'none'}
              onChange={(event) =>
                setForm((current) => ({ ...current, targetKind: event.target.value, targetId: '' }))
              }
            >
              {TARGET_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`expenses.targetKind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>

          {form.targetKind !== 'none' && (
            <Field label={t('expenses.targetPick')}>
              <SearchableSelect
                options={targetOptions}
                value={form.targetId ?? ''}
                placeholder={t('expenses.targetPick')}
                searchPlaceholder="ابحث بالاسم أو رقم الهاتف..."
                onChange={(val) => set('targetId', val)}
              />
            </Field>
          )}
        </div>

        {onAccountKind && (
          <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
            <input
              type="checkbox"
              checked={Boolean(form.settled)}
              onChange={(event) => set('settled', event.target.checked)}
              className="h-4 w-4 accent-brand-600"
            />
            <span className="text-sm font-semibold text-slate-700">{t('expenses.settledNow')}</span>
          </label>
        )}

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
