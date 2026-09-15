import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import { COL, createDoc, deleteDocById, updateDocById, useCollection, useLookup } from '../lib/db'
import { formatDate, formatMoney, toNumber } from '../lib/format'
import { statusOf, statusTone } from '../lib/invoice'
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
  Textarea,
  Th,
} from '../components/ui'
import { IconClients, IconInvoices } from '../components/Icons'
import SearchableSelect from '../components/SearchableSelect'
import { JOURNAL_COL } from '../lib/journal'

export default function Clients() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const { rows, loading } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: activityTypes } = useCollection(COL.activityTypes, 'name', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: allVouchers } = useCollection(JOURNAL_COL, 'date', 'desc')

  const employeeMap = useLookup(employees)
  const activityMap = useLookup(activityTypes)

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const invoiceCountByClient = useMemo(() => {
    const map = new Map()
    for (const invoice of invoices) {
      map.set(invoice.clientId, (map.get(invoice.clientId) ?? 0) + 1)
    }
    return map
  }, [invoices])

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

    for (const voucher of allVouchers) {
      for (const line of voucher.lines || []) {
        if (line.subLedgerType === 'client' && line.subLedgerId) {
          const cid = line.subLedgerId
          const cur = map.get(cid) || { totalInvoiced: 0, totalPaid: 0, balance: 0 }
          cur.balance += toNumber(line.debit) - toNumber(line.credit)
          map.set(cid, cur)
        }
      }
    }
    return map
  }, [invoices, allVouchers])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return rows
    return rows.filter((row) =>
      [row.name, row.businessName, row.phone, row.email]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [rows, search])

  const clientMap = useMemo(() => new Map(rows.map((c) => [c.id, c])), [rows])

  const enrichedRows = useMemo(() => {
    const directMap = new Map()
    for (const row of filtered) {
      const stats = clientStatsMap.get(row.id)
      directMap.set(row.id, {
        ...row,
        totalInvoiced: stats ? stats.totalInvoiced : (row.totalInvoiced || 0),
        totalPaid: stats ? stats.totalPaid : (row.totalPaid || 0),
        balance: stats ? stats.balance : (row.balance || 0),
      })
    }

    return filtered.map((row) => {
      const direct = directMap.get(row.id)
      if (row.isParent) {
        // الجمع التراكمي للعميل الرئيسي + جميع الفروع التابعة له
        let aggInvoiced = direct.totalInvoiced
        let aggPaid = direct.totalPaid
        let aggBalance = direct.balance
        for (const child of rows) {
          if (child.parentId === row.id) {
            const childStats = clientStatsMap.get(child.id)
            if (childStats) {
              aggInvoiced += childStats.totalInvoiced || 0
              aggPaid += childStats.totalPaid || 0
              aggBalance += childStats.balance || 0
            }
          }
        }
        return {
          ...direct,
          totalInvoiced: aggInvoiced,
          totalPaid: aggPaid,
          balance: aggBalance,
        }
      }
      return direct
    })
  }, [filtered, rows, clientStatsMap])

  const totalInvoicedAll = useMemo(() => {
    return enrichedRows.reduce((sum, r) => sum + (toNumber(r.totalInvoiced) || 0), 0)
  }, [enrichedRows])

  const totalBalanceAll = useMemo(() => {
    return enrichedRows.reduce((sum, r) => sum + (toNumber(r.balance) || 0), 0)
  }, [enrichedRows])

  async function handleSave(values) {
    setBusy(true)
    if (editing?.id) {
      await updateDocById(COL.clients, editing.id, values)
    } else {
      await createDoc(COL.clients, {
        ...values,
        totalInvoiced: 0,
        totalPaid: 0,
        balance: 0,
        invoicesCount: 0,
      })
    }
    setBusy(false)
    setEditing(null)
  }

  function askDelete(row) {
    if ((invoiceCountByClient.get(row.id) ?? 0) > 0) {
      setError(t('clients.deleteBlocked'))
      return
    }
    setError(null)
    setRemoving(row)
  }

  async function handleDelete() {
    setBusy(true)
    await deleteDocById(COL.clients, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('clients.title')} subtitle={t('clients.subtitle')}>
        <Button onClick={() => setEditing({})}>+ {t('clients.add')}</Button>
      </PageHeader>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      {enrichedRows.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-3">
          <StatCard
            label={t('clients.count') || 'إجمالي العملاء'}
            value={enrichedRows.length}
            Icon={IconClients}
          />
          <StatCard
            label="إجمالي مبيعات الفواتير الصادرة"
            value={formatMoney(totalInvoicedAll)}
            suffix={t('common.currency')}
            Icon={IconInvoices}
            tone="text-emerald-600 bg-emerald-50"
          />
          <StatCard
            label="إجمالي مستحقات العملاء (ذمم 1102)"
            value={formatMoney(totalBalanceAll)}
            suffix={t('common.currency')}
            tone="text-amber-600 bg-amber-50"
          />
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={t('clients.empty')}
          message={t('clients.emptyHint')}
          action={<Button onClick={() => setEditing({})}>+ {t('clients.add')}</Button>}
        />
      ) : (
        <>
          <div className="mb-4">
            <SearchInput value={search} onChange={setSearch} placeholder={t('clients.search')} />
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('clients.name')}</Th>
                <Th>{t('clients.activityType')}</Th>
                <Th>{t('common.phone')}</Th>
                <Th>{t('clients.mainEmployee')}</Th>
                <Th>{t('clients.totalInvoiced')}</Th>
                <Th>{t('clients.balance')}</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {enrichedRows.map((row) => {
                const firstChar = (row.name || '?').trim().charAt(0).toUpperCase()
                return (
                  <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                    <Td>
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-indigo-600 text-sm font-black text-white shadow-sm">
                          {firstChar}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Link
                              to={`/clients/${row.id}`}
                              className="font-bold text-slate-900 hover:text-brand-600 transition"
                            >
                              {row.name}
                            </Link>
                            {row.isParent && (
                              <span className="inline-flex items-center rounded-md bg-purple-100 border border-purple-200 px-1.5 py-0.5 text-[10px] font-extrabold text-purple-700">
                                عميل رئيسي
                              </span>
                            )}
                          </div>
                          {row.parentId && clientMap.get(row.parentId) && (
                            <p className="text-xs font-semibold text-purple-600 mt-0.5">
                              ↳ فرع من: {clientMap.get(row.parentId).name}
                            </p>
                          )}
                          {row.businessName && (
                            <p className="text-xs font-medium text-slate-400 mt-0.5 truncate">{row.businessName}</p>
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td>
                      {row.activityTypeId && activityMap.get(row.activityTypeId) ? (
                        <Badge tone="sky">{activityMap.get(row.activityTypeId).name}</Badge>
                      ) : (
                        <span className="text-slate-400 text-xs">—</span>
                      )}
                    </Td>
                    <Td>
                      {row.phone ? (
                        <span className="num font-semibold text-slate-700 bg-slate-100 px-2 py-1 rounded-lg text-xs">
                          {row.phone}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-xs">—</span>
                      )}
                    </Td>
                    <Td>
                      {employeeMap.get(row.employeeId)?.name ? (
                        <span className="font-semibold text-slate-700 text-xs">
                          {employeeMap.get(row.employeeId).name}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-xs">—</span>
                      )}
                    </Td>
                    <Td>
                      <span className="num font-bold text-slate-900">{formatMoney(row.totalInvoiced)}</span>
                    </Td>
                    <Td>
                      <span
                        className={`num inline-flex items-center rounded-xl px-2.5 py-1 text-xs font-bold ${
                          Number(row.balance ?? 0) > 0
                            ? 'bg-amber-50 text-amber-700 border border-amber-200/60'
                            : Number(row.balance ?? 0) < 0
                              ? 'bg-sky-50 text-sky-700 border border-sky-200/60'
                              : 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                        }`}
                      >
                        {formatMoney(row.balance)}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5 whitespace-nowrap">
                        {row.isParent && (
                          <button
                            type="button"
                            onClick={() => setEditing({ parentId: row.id })}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-bold text-purple-700 bg-purple-50 hover:bg-purple-100 transition"
                          >
                            + فرعي
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditing(row)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => askDelete(row)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 transition"
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
        </>
      )}

      <ClientForm
        open={Boolean(editing)}
        row={editing}
        allClients={rows}
        employees={employees}
        activityTypes={activityTypes}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={handleSave}
      />

      <ClientProfile
        open={Boolean(viewing)}
        client={viewing}
        invoices={invoices.filter((invoice) => invoice.clientId === viewing?.id)}
        employeeMap={employeeMap}
        activityMap={activityMap}
        locale={locale}
        onClose={() => setViewing(null)}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={handleDelete}
        title={t('common.deleteTitle')}
        message={t('common.deleteMsg', { name: removing?.name ?? '' })}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ClientForm({ open, row, allClients = [], employees, activityTypes, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const key = row?.id ? row.id : (row?.parentId ? `parent-${row.parentId}` : 'new')
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      name: row?.name ?? '',
      businessName: row?.businessName ?? '',
      activityTypeId: row?.activityTypeId ?? '',
      phone: row?.phone ?? '',
      email: row?.email ?? '',
      address: row?.address ?? '',
      employeeId: row?.employeeId ?? '',
      secondEmployeeId: row?.secondEmployeeId ?? '',
      notes: row?.notes ?? '',
      isParent: Boolean(row?.isParent),
      parentId: row?.parentId ?? '',
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  function submit() {
    setTouched(true)
    if (!form.name?.trim()) return
    onSave({
      name: form.name.trim(),
      businessName: form.businessName?.trim() ?? '',
      activityTypeId: form.activityTypeId || null,
      phone: form.phone?.trim() ?? '',
      email: form.email?.trim() ?? '',
      address: form.address?.trim() ?? '',
      employeeId: form.employeeId || null,
      secondEmployeeId: form.secondEmployeeId || null,
      notes: form.notes?.trim() ?? '',
      isParent: Boolean(form.isParent),
      parentId: form.isParent ? null : (form.parentId || null),
    })
  }

  const activeEmployees = employees.filter((employee) => !employee.archived)

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={row?.id ? t('clients.edit') : row?.parentId ? 'إضافة فرع تابع لعميل' : t('clients.add')}
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
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-3 rounded-xl border border-purple-200 bg-purple-50/50 px-4 py-3 sm:col-span-2">
          <input
            type="checkbox"
            checked={Boolean(form.isParent)}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                isParent: event.target.checked,
                parentId: event.target.checked ? '' : current.parentId,
              }))
            }
            className="h-4 w-4 accent-purple-600"
          />
          <div>
            <span className="text-sm font-extrabold text-purple-900">عميل رئيسي (له فروع متعددة)</span>
            <p className="text-xs text-purple-700">فّعل هذا الخيار إذا كان للعميل فروع متعددة وتريد تجميع أرصدتها وفواتيرها تحت اسم هذا العميل الرئيسي</p>
          </div>
        </label>

        {!form.isParent && (
          <Field label="العميل الرئيسي (الأب)" hint="اختر إذا كان هذا العميل فرعاً تابعة لعميل رئيسي آخر" className="sm:col-span-2">
            <Select
              value={form.parentId ?? ''}
              onChange={(event) => set('parentId', event.target.value)}
            >
              <option value="">لا يوجد (عميل مستقل)</option>
              {allClients
                .filter((c) => c.id !== row?.id && (c.isParent || !c.parentId))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.isParent ? '(عميل رئيسي)' : ''}
                  </option>
                ))}
            </Select>
          </Field>
        )}

        <Field label={t('clients.name')} error={touched && !form.name?.trim() ? t('common.required') : null}>
          <Input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} />
        </Field>

        <Field label={t('clients.businessName')}>
          <Input value={form.businessName ?? ''} onChange={(event) => set('businessName', event.target.value)} />
        </Field>

        <Field label={t('clients.activityType')}>
          <Select value={form.activityTypeId ?? ''} onChange={(event) => set('activityTypeId', event.target.value)}>
            <option value="">{t('common.none')}</option>
            {activityTypes
              .filter((type) => !type.archived)
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
          </Select>
        </Field>

        <Field label={t('common.phone')}>
          <Input numeric value={form.phone ?? ''} onChange={(event) => set('phone', event.target.value)} />
        </Field>

        <Field label={`${t('common.email')} (${t('common.optional')})`}>
          <Input
            type="email"
            dir="ltr"
            value={form.email ?? ''}
            onChange={(event) => set('email', event.target.value)}
          />
        </Field>

        <Field label={t('common.address')}>
          <Input value={form.address ?? ''} onChange={(event) => set('address', event.target.value)} />
        </Field>

        <Field label={t('clients.mainEmployee')}>
          <SearchableSelect
            options={activeEmployees}
            value={form.employeeId ?? ''}
            placeholder={t('common.none')}
            searchPlaceholder="ابحث باسم الموظف المبتكر..."
            onChange={(val) => set('employeeId', val)}
          />
        </Field>

        <Field label={`${t('clients.secondEmployee')} (${t('common.optional')})`}>
          <SearchableSelect
            options={activeEmployees.filter((employee) => employee.id !== form.employeeId)}
            value={form.secondEmployeeId ?? ''}
            placeholder={t('common.none')}
            searchPlaceholder="ابحث باسم الموظف المبتكر..."
            onChange={(val) => set('secondEmployeeId', val)}
          />
        </Field>

        <Field label={`${t('common.notes')} (${t('common.optional')})`} className="sm:col-span-2">
          <Textarea value={form.notes ?? ''} onChange={(event) => set('notes', event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */

function ClientProfile({ open, client, invoices, employeeMap, activityMap, locale, onClose }) {
  const { t } = useI18n()
  if (!client) return null

  const rows = [
    { label: t('clients.businessName'), value: client.businessName },
    { label: t('clients.activityType'), value: activityMap.get(client.activityTypeId)?.name },
    { label: t('common.phone'), value: client.phone, numeric: true },
    { label: t('common.email'), value: client.email, numeric: true },
    { label: t('common.address'), value: client.address },
    { label: t('clients.mainEmployee'), value: employeeMap.get(client.employeeId)?.name },
    { label: t('clients.secondEmployee'), value: employeeMap.get(client.secondEmployeeId)?.name },
    { label: t('common.notes'), value: client.notes },
  ].filter((row) => row.value)

  return (
    <Modal open={open} onClose={onClose} wide title={`${t('clients.profile')} — ${client.name}`}>
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <SummaryTile label={t('clients.totalInvoiced')} value={client.totalInvoiced} tone="text-slate-900" />
        <SummaryTile label={t('clients.totalPaid')} value={client.totalPaid} tone="text-emerald-600" />
        <SummaryTile label={t('clients.balance')} value={client.balance} tone="text-amber-600" />
      </div>

      {rows.length > 0 && (
        <dl className="mb-6 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-4 border-b border-slate-100 pb-2">
              <dt className="text-xs font-semibold text-slate-500">{row.label}</dt>
              <dd className={`text-sm font-semibold text-slate-800 ${row.numeric ? 'num' : ''}`}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <h4 className="mb-3 text-sm font-bold text-slate-900">{t('clients.invoices')}</h4>

      {invoices.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          {t('clients.noInvoices')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
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
                const status = statusOf(invoice)
                return (
                  <tr key={invoice.id}>
                    <Td>
                      <span className="num font-semibold text-slate-800">{invoice.number}</span>
                      {invoice.items?.length > 0 && (
                        <p className="max-w-[220px] truncate text-xs text-slate-400">
                          {invoice.items.map((item) => item.name).join('، ')}
                        </p>
                      )}
                    </Td>
                    <Td className="text-slate-600">{formatDate(invoice.date, locale)}</Td>
                    <Td>
                      <span className="num font-semibold">{formatMoney(invoice.total)}</span>
                    </Td>
                    <Td>
                      <span className="num text-emerald-600">{formatMoney(invoice.paidAmount)}</span>
                    </Td>
                    <Td>
                      <span className="num text-amber-600">
                        {formatMoney(Number(invoice.total ?? 0) - Number(invoice.paidAmount ?? 0))}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={statusTone(status)}>{t(`invoices.status.${status}`)}</Badge>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

function SummaryTile({ label, value, tone }) {
  const { t } = useI18n()
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-extrabold ${tone}`}>
        <span className="num">{formatMoney(value)}</span>
        <span className="ms-1 text-xs font-semibold text-slate-400">{t('common.currency')}</span>
      </p>
    </div>
  )
}
