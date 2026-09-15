import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { COL, createDoc, deleteDocById, updateDocById, useCollection } from '../lib/db'
import { formatDate, formatMoney, todayISO, toNumber } from '../lib/format'
import { COST_TYPES, invoiceExpectedProfit, invoiceProfit, vendorTypeLabel } from '../lib/costing'
import { JOB_COSTS_COL, VENDORS_COL } from '../pages/Vendors'
import { Badge, Button, Field, Input, Modal, Select, TableWrap, Td, Th } from './ui'
import SearchableSelect from './SearchableSelect'

/**
 * تكاليف الشغل المباشرة على فاتورة بعينها — الفرق بين «قبضت كام»
 * و«كسبت كام». بدونها الربح المعروض هو إيراد فقط.
 */
export default function JobCosts({ invoice }) {
  const { t, locale } = useI18n()

  const { rows: allCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: vendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')

  const costs = useMemo(
    () => allCosts.filter((cost) => cost.invoiceId === invoice.id),
    [allCosts, invoice.id],
  )

  const approvedItemCosts = useMemo(
    () => (invoice?.items || []).filter((item) => item.supplierId && (item.costStatus === 'approved' || item.costStatus === 'partially_paid' || item.costStatus === 'paid')),
    [invoice?.items],
  )

  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)

  const profit = invoiceProfit(invoice, allCosts)
  const expected = invoiceExpectedProfit(invoice)

  async function save(values) {
    setBusy(true)
    if (editing?.id) await updateDocById(JOB_COSTS_COL, editing.id, values)
    else await createDoc(JOB_COSTS_COL, { ...values, invoiceId: invoice.id, clientId: invoice.clientId })
    setBusy(false)
    setEditing(null)
  }

  async function togglePaid(cost) {
    await updateDocById(JOB_COSTS_COL, cost.id, { paid: !cost.paid, paidDate: cost.paid ? null : todayISO() })
  }

  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold text-slate-900">{t('costs.title')}</h4>
        <Button variant="soft" onClick={() => setEditing({})}>
          + {t('costs.add')}
        </Button>
      </div>

      {expected.hasEstimate && expected.cost > 0 && (
        <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50/40 p-3">
          <p className="mb-2 text-xs font-bold text-slate-700">{t('costs.expectedTitle')}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryTile label={t('costs.cost')} value={expected.cost} tone="text-rose-600" />
            <SummaryTile
              label={t('costs.profit')}
              value={expected.profit}
              tone={expected.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}
            />
            <div className="rounded-2xl bg-white px-4 py-3">
              <p className="text-xs font-semibold text-slate-500">{t('costs.margin')}</p>
              <p className={`num mt-1 text-lg font-extrabold ${expected.margin >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {expected.margin}%
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ملخص الربحية */}
      <p className="mb-2 text-xs font-bold text-slate-700">{t('costs.actualTitle')}</p>
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <SummaryTile label={t('costs.revenue')} value={profit.revenue} tone="text-slate-900" />
        <SummaryTile label={t('costs.cost')} value={profit.cost} tone="text-rose-600" />
        <SummaryTile label={t('costs.profit')} value={profit.profit} tone={profit.profit >= 0 ? 'text-emerald-600' : 'text-red-600'} />
        <div className="rounded-2xl bg-slate-50 px-4 py-3">
          <p className="text-xs font-semibold text-slate-500">{t('costs.margin')}</p>
          <p className={`num mt-1 text-lg font-extrabold ${profit.margin >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {profit.margin}%
          </p>
        </div>
      </div>

      {approvedItemCosts.length > 0 && (
        <div className="mb-6 rounded-2xl border border-brand-200 bg-brand-50/30 p-4">
          <h4 className="mb-2 text-xs font-bold text-brand-900">تكاليف البنود المعتمدة رسمياً للموردين (حساب الذمم 211)</h4>
          <TableWrap>
            <thead>
              <tr>
                <Th>البند الخدمي</Th>
                <Th>المورد المستحق</Th>
                <Th>التكلفة المتوقعة</Th>
                <Th>التكلفة الفعلية المعتمدة</Th>
                <Th>حالة الاستحقاق</Th>
              </tr>
            </thead>
            <tbody>
              {approvedItemCosts.map((item) => (
                <tr key={item.id}>
                  <Td className="font-semibold text-slate-800">{item.name}</Td>
                  <Td className="font-bold text-slate-700">{item.supplierName || 'مورد محدد'}</Td>
                  <Td className="num text-slate-500">{item.expectedCost > 0 ? formatMoney(item.expectedCost) : '—'}</Td>
                  <Td className="num font-bold text-emerald-700">{formatMoney(item.approvedCost)}</Td>
                  <Td>
                    <Badge tone={item.costStatus === 'paid' ? 'green' : item.costStatus === 'partially_paid' ? 'amber' : 'brand'}>
                      {item.costStatus === 'paid' ? 'خالص' : item.costStatus === 'partially_paid' ? 'مسدد جزئياً' : 'معتمد بالدفاتر'}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}

      {costs.length === 0 && approvedItemCosts.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">{t('costs.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.type')}</Th>
              <Th>{t('common.description')}</Th>
              <Th>{t('costs.vendor')}</Th>
              <Th>{t('common.date')}</Th>
              <Th>{t('common.amount')}</Th>
              <Th>{t('common.status')}</Th>
              <Th className="w-px">{t('common.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {costs.map((cost) => (
              <tr key={cost.id}>
                <Td>
                  <Badge tone="brand">{vendorTypeLabel(cost.type, t)}</Badge>
                  {cost.auto && (
                    <span className="ms-1.5">
                      <Badge tone="sky">{t('costs.auto')}</Badge>
                    </span>
                  )}
                </Td>
                <Td className="text-slate-700">{cost.description || '—'}</Td>
                <Td className="text-slate-600">
                  {cost.employeeName ??
                    vendors.find((vendor) => vendor.id === cost.vendorId)?.name ??
                    '—'}
                  {cost.employeeId && (
                    <span className="ms-1.5">
                      <Badge tone="brand">{t('costs.staff')}</Badge>
                    </span>
                  )}
                </Td>
                <Td className="text-slate-600">{formatDate(cost.date, locale)}</Td>
                <Td>
                  <span className="num font-bold text-slate-800">{formatMoney(cost.amount)}</span>
                </Td>
                <Td>
                  <button type="button" onClick={() => togglePaid(cost)}>
                    <Badge tone={cost.paid ? 'green' : 'amber'}>
                      {cost.paid ? t('vendors.settled') : t('vendors.unpaid')}
                    </Badge>
                  </button>
                </Td>
                <Td>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEditing(cost)}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteDocById(JOB_COSTS_COL, cost.id)}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <CostForm
        open={Boolean(editing)}
        row={editing}
        vendors={vendors}
        employees={employees}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={save}
      />
    </div>
  )
}

function SummaryTile({ label, value, tone }) {
  const { t } = useI18n()
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={`num mt-1 text-lg font-extrabold ${tone}`}>
        {formatMoney(value)}
        <span className="ms-1 text-[11px] font-semibold text-slate-400">{t('common.currency')}</span>
      </p>
    </div>
  )
}

function CostForm({ open, row, vendors, employees = [], busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      type: row?.type ?? 'model',
      description: row?.description ?? '',
      vendorId: row?.vendorId ?? '',
      employeeId: row?.employeeId ?? '',
      amount: row?.amount ?? '',
      date: row?.date || todayISO(),
      paid: Boolean(row?.paid),
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const invalid = toNumber(form.amount) === 0

  /*
   * قائمة واحدة تجمع الموردين وموظفي الشركة — اختيار موظف يعني إنه
   * بياخد أجر إضافي عن الشغلانة دي فوق مرتبه، ويظهر في كشفه الشهري
   * بدل ما يتحاسب كمورد خارجي.
   */
  function pickBeneficiary(value) {
    if (!value) {
      setForm((current) => ({ ...current, vendorId: '', employeeId: '' }))
      return
    }
    const [kind, id] = value.split(':')
    if (kind === 'vendor') {
      const vendor = vendors.find((item) => item.id === id)
      /* لا نملأ نوع التكلفة من تخصص المورد — التخصص بقى قائمة حرة،
         والنوع محدود بحسابات الإنتاج (531–536)، فيختاره المستخدم */
      setForm((current) => ({
        ...current,
        vendorId: id,
        employeeId: '',
        amount: current.amount || (vendor?.defaultRate ? String(vendor.defaultRate) : ''),
      }))
    } else {
      setForm((current) => ({ ...current, vendorId: '', employeeId: id }))
    }
  }

  const beneficiaryValue = form.employeeId ? `employee:${form.employeeId}` : form.vendorId ? `vendor:${form.vendorId}` : ''

  const beneficiaryOptions = useMemo(() => {
    const list = []
    employees.forEach((emp) => {
      list.push({ id: `employee:${emp.id}`, name: `[موظف] ${emp.name}`, phone: emp.phone })
    })
    vendors.forEach((ven) => {
      list.push({ id: `vendor:${ven.id}`, name: `[مورد] ${ven.name}`, phone: ven.phone })
    })
    return list
  }, [employees, vendors])

  function submit() {
    setTouched(true)
    if (invalid) return
    const employee = employees.find((item) => item.id === form.employeeId)
    onSave({
      type: form.type,
      description: form.description?.trim() ?? '',
      vendorId: form.vendorId || null,
      employeeId: form.employeeId || null,
      employeeName: employee?.name ?? null,
      amount: toNumber(form.amount),
      date: form.date,
      paid: Boolean(form.paid),
      paidDate: form.paid ? (row?.paidDate ?? todayISO()) : null,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={row?.id ? t('costs.edit') : t('costs.add')}
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
        <Field label={t('costs.vendor')} hint={t('costs.vendorHint')}>
          <SearchableSelect
            options={beneficiaryOptions}
            value={beneficiaryValue}
            placeholder={t('costs.noVendor')}
            searchPlaceholder="ابحث باسم الموظف أو المورد..."
            onChange={(val) => pickBeneficiary(val)}
          />
          {form.employeeId && <p className="mt-1.5 text-xs font-semibold text-brand-600">{t('costs.staffHint')}</p>}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.type')}>
            <Select value={form.type} onChange={(event) => set('type', event.target.value)}>
              {COST_TYPES.filter((type) => type !== 'commission').map((type) => (
                <option key={type} value={type}>
                  {vendorTypeLabel(type, t)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('common.amount')} error={touched && invalid ? t('common.required') : null}>
            <Input numeric value={form.amount ?? ''} onChange={(event) => set('amount', event.target.value)} />
          </Field>
        </div>

        <Field label={`${t('common.description')} (${t('common.optional')})`}>
          <Input value={form.description ?? ''} onChange={(event) => set('description', event.target.value)} />
        </Field>

        <Field label={t('common.date')}>
          <Input type="date" value={form.date ?? ''} onChange={(event) => set('date', event.target.value)} />
        </Field>

        <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
          <input
            type="checkbox"
            checked={Boolean(form.paid)}
            onChange={(event) => set('paid', event.target.checked)}
            className="h-4 w-4 accent-brand-600"
          />
          <span className="text-sm font-semibold text-slate-700">{t('costs.alreadyPaid')}</span>
        </label>
      </div>
    </Modal>
  )
}
