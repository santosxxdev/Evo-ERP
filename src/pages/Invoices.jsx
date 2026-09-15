import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import {
  COL,
  createDoc,
  deleteDocById,
  nextInvoiceNumber,
  recalcClientTotals,
  sumPayments,
  updateDocById,
  useCollection,
  useLookup,
  useSettings,
  useSubCollection,
} from '../lib/db'
import {
  createInvoiceClientSide,
  editInvoiceClientSide,
  createPaymentClientSide,
  cancelInvoiceClientSide,
  deleteInvoiceClientSide,
  restoreInvoiceClientSide,
} from '../lib/clientInvoices'
import { formatDate, formatMoney, todayISO, toNumber } from '../lib/format'
import {
  computeTotals,
  isOverdue,
  lineTotal,
  remainingOf,
  resolveTaxRate,
  statusOf,
  statusTone,
  taxLabelOf,
} from '../lib/invoice'
import ReceiptModal from '../components/ReceiptModal'
import PrintDocument from '../components/PrintDocument'
import JobCosts from '../components/JobCosts'
import QrImage from '../components/QrImage'
import SearchableSelect from '../components/SearchableSelect'
import { useAuth } from '../context/AuthContext'
import { canSeeMoneyInternals } from '../lib/roles'
import { AUTO_COMMISSION, expectedCostOfItems, lineMargin, planCommission, serviceCostBreakdown } from '../lib/costing'
import { VENDORS_COL, JOB_COSTS_COL } from './Vendors'
import { approveSupplierCostClientSide } from '../lib/clientVendors'
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
  Textarea,
  Th,
} from '../components/ui'

const STATUSES = ['unpaid', 'partial', 'paid', 'credit']

/**
 * حفظ تعديل فاتورة قائمة (من صفحة التعديل): تحديث البيانات، دفعة اختيارية،
 * إعادة حساب رصيد العميل، ومزامنة عمولة الموظف مع الفاتورة الجديدة.
 */
export async function persistInvoiceEdit({ invoice, values, payment, invoices, employees, jobCosts, uid }) {
  const invoiceId = invoice.id
  
  await editInvoiceClientSide({ invoiceId, values, uid })

  let paidAmount = toNumber(invoice.paidAmount)
  if (payment) {
    await createPaymentClientSide({ invoiceId, payment, uid })
    paidAmount = (invoice.paidAmount || 0) + Number(payment.amount)
  }

  const patched = invoices.map((item) =>
    item.id === invoiceId ? { ...item, ...values, paidAmount } : item,
  )
  await recalcClientTotals(values.clientId, patched)
  if (invoice.clientId && invoice.clientId !== values.clientId) {
    await recalcClientTotals(invoice.clientId, patched)
  }

  const employee = employees.find((item) => item.id === values.employeeId)
  const existing = jobCosts.find((cost) => cost.invoiceId === invoiceId && cost.auto === AUTO_COMMISSION)
  const plan = planCommission({ invoice: { ...values, id: invoiceId }, employee, existing })
  if (plan.action === 'create') {
    await createDoc(JOB_COSTS_COL, { ...plan.data, invoiceId, clientId: values.clientId })
  } else if (plan.action === 'update') {
    await updateDocById(JOB_COSTS_COL, plan.id, plan.data)
  } else if (plan.action === 'delete') {
    await deleteDocById(JOB_COSTS_COL, plan.id)
  }
}

export default function Invoices() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const { settings } = useSettings()
  const { user, role, profile } = useAuth()
  /* الحذف النهائي يمحو الأثر المحاسبي — للمدير وحده؛ الباقي «إلغاء» */
  const canHardDelete = role === 'admin'
  const { rows: invoices, loading } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: services } = useCollection(COL.services, 'name', 'asc')
  const { rows: methods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: vendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: accounts } = useCollection(COL.accounts, 'code', 'asc')

  const clientMap = useLookup(clients)
  const employeeMap = useLookup(employees)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [cancelling, setCancelling] = useState(null)
  const [busy, setBusy] = useState(false)

  const today = todayISO()

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return invoices.filter((invoice) => {
      /* الفاتورة الملغاة قد تبدو "خالص" أو "مدين" رقميًا حسب ما كان مسدَّدًا
         قبل الإلغاء — فلا تُحسب ضمن أي حالة تحصيل حقيقية عند التصفية */
      if (status && (invoice.cancelled || statusOf(invoice) !== status)) return false
      if (!term) return true
      return [invoice.number, invoice.clientName, invoice.employeeName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(term)
    })
  }, [invoices, search, status])

  /**
   * تُحفظ الفاتورة ومعها التحصيل المبدئي في خطوة واحدة، حتى لا تظهر فاتورة
   * مدفوعة بالكامل على أنها «مدين» لمجرد أن الدفعة لم تُسجَّل بعد.
   */
  async function handleSave(values, payment) {
    setBusy(true)

    let invoiceId = editing?.id ?? null

    try {
      if (!invoiceId) {
        const number = await nextInvoiceNumber(settings.invoicePrefix)
        await createInvoiceClientSide({ values, number, payment, uid: user?.uid })
      } else {
        await editInvoiceClientSide({ invoiceId, values, uid: user?.uid })
      }
    } catch (error) {
      console.error('Invoice save error:', error)
      alert(`❌ حدث خطأ أثناء حفظ الفاتورة:\n\n${error?.message || 'خطأ غير معروف'}`)
    }

    setBusy(false)
    setEditing(null)
  }

  /** يبقي تكلفة عمولة الموظف مطابقة للفاتورة بعد أي تعديل */
  async function syncCommission(invoiceId, values) {
    if (!invoiceId) return

    const employee = employees.find((item) => item.id === values.employeeId)
    const existing = jobCosts.find((cost) => cost.invoiceId === invoiceId && cost.auto === AUTO_COMMISSION)
    const plan = planCommission({ invoice: { ...values, id: invoiceId }, employee, existing, monthInvoices: invoices })

    if (plan.action === 'create') {
      await createDoc(JOB_COSTS_COL, { ...plan.data, invoiceId, clientId: values.clientId })
    } else if (plan.action === 'update') {
      await updateDocById(JOB_COSTS_COL, plan.id, plan.data)
    } else if (plan.action === 'delete') {
      await deleteDocById(JOB_COSTS_COL, plan.id)
    }
  }

  /**
   * الإلغاء يحفظ الفاتورة ويولّد قيدًا عكسيًا بتاريخ الإلغاء،
   * بدل الحذف الذي يمحو الأثر المحاسبي بالكامل.
   */
  async function cancelInvoice(reason) {
    setBusy(true)
    try {
      await cancelInvoiceClientSide({ invoiceId: cancelling.id, cancelReason: reason, cancelledDate: todayISO(), uid: user?.uid })
    } catch (error) {
      console.error(error)
      alert(error?.message || 'حدث خطأ أثناء إلغاء الفاتورة.')
    }
    setBusy(false)
    setCancelling(null)
  }

  async function restoreInvoice(invoice) {
    setBusy(true)
    try {
      await restoreInvoiceClientSide({ invoiceId: invoice.id, uid: user?.uid })
    } catch (error) {
      console.error(error)
      alert(error?.message || 'حدث خطأ أثناء استرجاع الفاتورة.')
    }
    setBusy(false)
  }

  async function handleDelete() {
    setBusy(true)
    const { id, clientId } = removing
    try {
      await deleteInvoiceClientSide({ invoiceId: id })
      await recalcClientTotals(clientId, invoices.filter((invoice) => invoice.id !== id))
    } catch (error) {
      console.error(error)
      alert(error?.message || 'حدث خطأ أثناء حذف الفاتورة.')
    }
    setBusy(false)
    setRemoving(null)
  }

  if (loading) return <Loading />

  const canCreate = clients.length > 0

  return (
    <div>
      <PageHeader title={t('invoices.title')} subtitle={t('invoices.subtitle')}>
        <Button variant="ghost" onClick={() => setReceiptOpen(true)} disabled={!canCreate}>
          {t('receipts.button')}
        </Button>
        <Button onClick={() => setEditing({})} disabled={!canCreate}>
          + {t('invoices.add')}
        </Button>
      </PageHeader>

      {!canCreate && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          {t('invoices.needClient')}
        </div>
      )}

      {invoices.length === 0 ? (
        <EmptyState title={t('invoices.empty')} message={t('invoices.emptyHint')} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <SearchInput value={search} onChange={setSearch} placeholder={t('invoices.search')} />
            <Select value={status} onChange={(event) => setStatus(event.target.value)} className="w-auto">
              <option value="">{t('common.all')}</option>
              {STATUSES.map((item) => (
                <option key={item} value={item}>
                  {t(`invoices.status.${item}`)}
                </option>
              ))}
            </Select>
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('invoices.number')}</Th>
                <Th>{t('common.client')}</Th>
                <Th>{t('common.date')}</Th>
                <Th>{t('invoices.total')}</Th>
                <Th>{t('invoices.paid')}</Th>
                <Th>{t('invoices.remaining')}</Th>
                <Th>{t('common.status')}</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((invoice) => {
                const state = statusOf(invoice)
                return (
                  <tr key={invoice.id}>
                    <Td>
                      <button
                        type="button"
                        onClick={() => navigate(`/invoices/${invoice.id}`)}
                        className="num text-start font-bold text-slate-800 hover:text-brand-600"
                      >
                        {invoice.number}
                      </button>
                      {isOverdue(invoice, today) && (
                        <span className="ms-2">
                          <Badge tone="red">{t('invoices.overdue')}</Badge>
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="font-semibold text-slate-700">
                        {clientMap.get(invoice.clientId)?.name ?? invoice.clientName ?? '—'}
                      </span>
                    </Td>
                    <Td className="text-slate-600">{formatDate(invoice.date, locale)}</Td>
                    <Td>
                      <span className="num font-bold text-slate-800">{formatMoney(invoice.total)}</span>
                    </Td>
                    <Td>
                      <span className="num text-emerald-600">{formatMoney(invoice.paidAmount)}</span>
                    </Td>
                    <Td>
                      <span className="num font-semibold text-amber-600">{formatMoney(remainingOf(invoice))}</span>
                    </Td>
                    <Td>
                      {invoice.cancelled ? (
                        <Badge tone="slate">{t('invoices.cancelled')}</Badge>
                      ) : (
                        <Badge tone={statusTone(state)}>{t(`invoices.status.${state}`)}</Badge>
                      )}
                    </Td>
                    <Td>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => navigate(`/invoices/${invoice.id}`)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                        >
                          {t('common.details')}
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate(`/invoices/${invoice.id}/edit`)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                        >
                          {t('common.edit')}
                        </button>
                        {invoice.cancelled ? (
                          <button
                            type="button"
                            onClick={() => restoreInvoice(invoice)}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                          >
                            {t('invoices.restore')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setCancelling(invoice)}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50"
                          >
                            {t('invoices.cancel')}
                          </button>
                        )}
                        {canHardDelete && (
                          <button
                            type="button"
                            onClick={() => setRemoving(invoice)}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                          >
                            {t('common.delete')}
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
        </>
      )}

      <InvoiceForm
        open={Boolean(editing)}
        invoice={editing}
        clients={clients}
        employees={employees}
        services={services}
        methods={methods}
        settings={settings}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={handleSave}
      />

      <CancelInvoiceDialog
        open={Boolean(cancelling)}
        invoice={cancelling}
        busy={busy}
        onClose={() => setCancelling(null)}
        onConfirm={cancelInvoice}
      />

      <ReceiptModal
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        clients={clients}
        invoices={invoices}
        methods={methods}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={handleDelete}
        title={t('common.deleteTitle')}
        message={t('common.deleteMsg', { name: removing?.number ?? '' })}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  نموذج الفاتورة                                                     */
/* ------------------------------------------------------------------ */

const emptyItem = () => ({ serviceId: '', name: '', price: '', qty: 1, isAdBudget: false })

/** موظف مبيعات أو بلا نوع محدَّد — قائمة «موظف السيلز» في الفاتورة */
const salesLike = (employee) => !employee.role || employee.role === 'sales'

function CancelInvoiceDialog({ open, invoice, busy, onClose, onConfirm }) {
  const { t } = useI18n()
  const [reason, setReason] = useState('')

  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setReason('')
  }
  if (!open && wasOpen) setWasOpen(false)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('invoices.cancel')} — ${invoice?.number ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => onConfirm(reason.trim())} disabled={busy}>
            {busy ? t('common.saving') : t('invoices.confirmCancel')}
          </Button>
        </>
      }
    >
      <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
        {t('invoices.cancelHint')}
      </p>
      <Field label={t('invoices.cancelReason')}>
        <Input value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Modal>
  )
}

export function InvoiceForm({
  open,
  invoice,
  clients,
  employees,
  services,
  methods,
  settings,
  busy,
  asPage = false,
  onClose,
  onSave,
}) {
  const { t } = useI18n()
  const { user, profile, username } = useAuth()
  const [form, setForm] = useState({})
  const [items, setItems] = useState([emptyItem()])
  const [collect, setCollect] = useState({ amount: '', date: todayISO(), methodId: methods[0]?.id ?? '', clientAccount: '' })
  const [touched, setTouched] = useState(false)

  const key = invoice?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      clientId: invoice?.clientId ?? '',
      employeeId: invoice?.employeeId ?? '',
      date: invoice?.date || todayISO(),
      discount: invoice?.discountValue ?? invoice?.discount ?? '',
      discountMode: invoice?.discountMode === 'percent' ? 'percent' : 'amount',
      taxKind:
        invoice?.taxKind ??
        (invoice?.id
          ? invoice?.taxEnabled
            ? 'tax1'
            : 'none'
          : settings.taxEnabled
            ? 'tax1'
            : 'none'),
      nextPaymentDate: invoice?.nextPaymentDate ?? '',
      notes: invoice?.notes ?? '',
    })
    setItems(invoice?.items?.length ? invoice.items.map((item) => ({ ...item })) : [emptyItem()])
    setCollect({ amount: '', date: todayISO(), methodId: methods[0]?.id ?? '', clientAccount: '' })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  function setItem(index, patch) {
    setItems((current) => current.map((item, position) => (position === index ? { ...item, ...patch } : item)))
  }

  function pickService(index, serviceId) {
    const service = services.find((item) => item.id === serviceId)
    setItem(index, {
      serviceId,
      name: service?.name ?? '',
      price: service ? service.price : '',
      isAdBudget: Boolean(service?.isAdBudget),
    })
  }

  /* الفاتورة عليها ضريبة = مبلغها الرئيسي مقفول: يُعدَّل اسم البند وطريقة
     الدفع والملاحظات، لا الأسعار ولا الخصم ولا الإجمالي. */
  const locked = Boolean(invoice?.id) && toNumber(invoice?.taxAmount) > 0

  const taxKind = form.taxKind ?? 'none'
  const taxRate = locked ? toNumber(invoice.taxRate) : resolveTaxRate(settings, taxKind)
  const taxEnabled = locked ? toNumber(invoice.taxAmount) > 0 : taxKind !== 'none' && taxRate > 0

  const computed = computeTotals({
    items,
    discountMode: form.discountMode,
    discountValue: form.discount,
    taxRate,
    taxEnabled,
  })
  /* في وضع القفل تُثبَّت الأرقام المالية على المخزَّن مهما عُدِّلت البنود */
  const totals = locked
    ? {
        subtotal: toNumber(invoice.subtotal),
        adBudgetTotal: toNumber(invoice.adBudgetTotal),
        feesTotal: toNumber(invoice.feesTotal),
        discount: toNumber(invoice.discount),
        discountMode: invoice.discountMode === 'percent' ? 'percent' : 'amount',
        discountValue: toNumber(invoice.discountValue ?? invoice.discount),
        taxAmount: toNumber(invoice.taxAmount),
        total: toNumber(invoice.total),
      }
    : computed

  const serviceMap = useMemo(() => {
    const map = new Map()
    for (const service of services) map.set(service.id, service)
    return map
  }, [services])
  const expected = useMemo(() => expectedCostOfItems(items, serviceMap), [items, serviceMap])
  const expectedFees = totals.feesTotal
  const expectedMargin = lineMargin(expectedFees, expected.total)

  const validItems = items.filter((item) => item.name?.trim() && toNumber(item.qty) > 0)
  const collectMethod = methods.find((item) => item.id === collect.methodId)

  function submit() {
    setTouched(true)
    if (!form.clientId || validItems.length === 0) return

    const client = clients.find((item) => item.id === form.clientId)
    const employee = employees.find((item) => item.id === form.employeeId)

    const collected = toNumber(collect.amount)
    const effectiveMethodId = collect.methodId || (methods.length > 0 ? methods[0].id : null)
    const method = methods.find((item) => item.id === effectiveMethodId)

    if (collected > 0 && !effectiveMethodId) {
      alert('يرجى تحديد طريقة التحويل لحفظ التحصيل المبدئي.')
      return
    }

    const collectorName = profile?.name || username || ''
    const payment =
      collected > 0
        ? {
            amount: collected,
            date: collect.date || todayISO(),
            methodId: effectiveMethodId,
            methodName: method?.name ?? '',
            methodType: method?.type ?? '',
            ourAccount: method?.accountNumber ?? '',
            clientAccount: collect.clientAccount?.trim() ?? '',
            collectorId: profile?.id || user?.uid || null,
            collectorName,
            collectedBy: collectorName,
            collectedByUsername: username || '',
          }
        : null

    onSave({
      clientId: form.clientId,
      clientName: client?.name ?? '',
      createdByUserId: invoice?.createdByUserId ?? profile?.id ?? user?.uid ?? null,
      createdByName: invoice?.createdByName ?? invoice?.accountantName ?? profile?.name ?? username ?? '',
      responsibleEmployeeId: form.employeeId || null,
      responsibleEmployeeName: employee?.name ?? '',
      employeeId: form.employeeId || null,
      employeeName: employee?.name ?? '',
      accountantName: invoice?.accountantName ?? profile?.name ?? username ?? '',
      accountantUsername: invoice?.accountantUsername ?? username ?? '',
      date: form.date,
      items: validItems.map((item) => ({
        serviceId: item.serviceId || null,
        name: item.name.trim(),
        price: toNumber(item.price),
        qty: toNumber(item.qty),
        isAdBudget: Boolean(item.isAdBudget),
        total: lineTotal(item),
      })),
      subtotal: totals.subtotal,
      feesTotal: totals.feesTotal,
      adBudgetTotal: totals.adBudgetTotal,
      expectedCost: locked ? toNumber(invoice.expectedCost) : expected.total,
      expectedCostDirect: locked ? toNumber(invoice.expectedCostDirect) : expected.direct,
      expectedCostIndirect: locked ? toNumber(invoice.expectedCostIndirect) : expected.indirect,
      expectedCostBreakdown: locked ? (invoice.expectedCostBreakdown ?? []) : expected.lines,
      discount: totals.discount,
      discountMode: totals.discountMode,
      discountValue: totals.discountValue,
      taxKind,
      taxEnabled,
      taxRate: taxEnabled ? taxRate : 0,
      taxAmount: totals.taxAmount,
      total: totals.total,
      nextPaymentDate: form.nextPaymentDate || null,
      notes: form.notes?.trim() ?? '',
    }, payment)
  }

  const title = invoice?.id ? `${t('invoices.edit')} ${invoice.number ?? ''}` : t('invoices.add')
  const footerButtons = (
    <>
      <Button variant="ghost" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      <Button onClick={submit} disabled={busy}>
        {busy ? t('common.saving') : t('common.save')}
      </Button>
    </>
  )

  const body = (
    <>
      {locked && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold leading-relaxed text-amber-800">
          {t('invoices.lockedByTax')}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('common.client')} error={touched && !form.clientId ? t('invoices.needClient') : null}>
          <SearchableSelect
            options={clients}
            value={form.clientId ?? ''}
            disabled={locked}
            placeholder={t('common.client')}
            searchPlaceholder="ابحث باسم العميل، الهاتف، أو الكود..."
            onChange={(val) => set('clientId', val)}
          />
        </Field>

        <Field label={t('invoices.salesEmployee')}>
          <SearchableSelect
            options={employees.filter((employee) => salesLike(employee) || employee.id === form.employeeId)}
            value={form.employeeId ?? ''}
            placeholder={t('common.none')}
            searchPlaceholder="ابحث باسم الموظف..."
            onChange={(val) => set('employeeId', val)}
          />
        </Field>

        <Field label={t('invoices.date')}>
          <Input type="date" value={form.date ?? ''} onChange={(event) => set('date', event.target.value)} />
        </Field>
      </div>

      {/* البنود */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-bold text-slate-900">{t('invoices.items')}</h4>
          {!locked && (
            <Button variant="soft" onClick={() => setItems((current) => [...current, emptyItem()])}>
              + {t('invoices.addItem')}
            </Button>
          )}
        </div>

        {touched && validItems.length === 0 && (
          <p className="mb-2 text-xs font-semibold text-red-600">{t('invoices.needItems')}</p>
        )}

        <div className="space-y-3">
          {items.map((item, index) => (
            <div key={index} className="rounded-2xl border border-slate-200 p-3">
              <div className="grid gap-3 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <Select
                    value={item.serviceId ?? ''}
                    disabled={locked}
                    onChange={(event) => pickService(index, event.target.value)}
                  >
                    <option value="">{t('invoices.pickService')}</option>
                    {services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="sm:col-span-3">
                  <Input
                    value={item.name ?? ''}
                    onChange={(event) => setItem(index, { name: event.target.value })}
                    placeholder={t('common.service')}
                  />
                </div>

                <div className="sm:col-span-2">
                  <Input
                    numeric
                    disabled={locked}
                    value={item.price ?? ''}
                    onChange={(event) => setItem(index, { price: event.target.value })}
                    placeholder={t('common.price')}
                  />
                </div>

                <div className="sm:col-span-1">
                  <Input
                    numeric
                    disabled={locked}
                    value={item.qty ?? ''}
                    onChange={(event) => setItem(index, { qty: event.target.value })}
                    placeholder={t('common.qty')}
                  />
                </div>

                <div className="flex items-center justify-between gap-2 sm:col-span-2">
                  <span className="num text-sm font-bold text-slate-800">{formatMoney(lineTotal(item))}</span>
                  {items.length > 1 && !locked && (
                    <button
                      type="button"
                      onClick={() => setItems((current) => current.filter((_, position) => position !== index))}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {(() => {
                if (item.isAdBudget || !item.serviceId) return null
                const b = serviceCostBreakdown(serviceMap.get(item.serviceId))
                if (!b.hasCosting) return null
                const qty = toNumber(item.qty) || 1
                const floor = b.fullCost * qty
                const m = lineMargin(lineTotal(item), floor)
                return (
                  <p className="mt-2 text-xs font-semibold text-slate-500">
                    {t('invoices.floor')}:{' '}
                    <span className="num text-rose-600">{formatMoney(floor)}</span>
                    <span className="mx-1.5 text-slate-300">·</span>
                    {t('invoices.expectedMargin')}:{' '}
                    <span className={`num ${m.margin >= 15 ? 'text-emerald-600' : 'text-red-600'}`}>{m.margin}%</span>
                  </p>
                )
              })()}

              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(item.isAdBudget)}
                  disabled={locked}
                  onChange={(event) => setItem(index, { isAdBudget: event.target.checked })}
                  className="h-3.5 w-3.5 accent-amber-500"
                />
                <span className="text-xs font-semibold text-slate-500">{t('invoices.itemIsAdBudget')}</span>
              </label>
            </div>
          ))}
        </div>
      </div>

      {expected.total > 0 && (
        <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50/50 p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-slate-900">{t('invoices.expectedCost')}</h4>
            <span className="text-xs font-semibold text-slate-500">
              {t('invoices.expectedMargin')}:{' '}
              <span className={`num font-bold ${expectedMargin.margin >= 15 ? 'text-emerald-600' : 'text-red-600'}`}>
                {expectedMargin.margin}% ({formatMoney(expectedMargin.profit)} {t('common.currency')})
              </span>
            </span>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-slate-500">{t('invoices.expectedCostHint')}</p>
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <span>
              {t('services.directCost')}:{' '}
              <span className="num font-bold text-rose-600">{formatMoney(expected.direct)}</span>
            </span>
            <span>
              {t('services.indirectCost')}:{' '}
              <span className="num font-bold text-rose-600">{formatMoney(expected.indirect)}</span>
            </span>
            <span>
              {t('services.fullCost')}:{' '}
              <span className="num font-extrabold text-rose-700">{formatMoney(expected.total)}</span>
            </span>
          </div>
        </div>
      )}

      {/* الإجماليات */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="space-y-4">
          <Field label={t('invoices.discount')}>
            <div className="flex gap-2">
              <Select
                value={form.discountMode ?? 'amount'}
                disabled={locked}
                onChange={(event) => set('discountMode', event.target.value)}
                className="w-32"
              >
                <option value="amount">{t('invoices.discountMode.amount')}</option>
                <option value="percent">{t('invoices.discountMode.percent')}</option>
              </Select>
              <Input
                numeric
                disabled={locked}
                value={form.discount ?? ''}
                onChange={(event) => set('discount', event.target.value)}
                placeholder={form.discountMode === 'percent' ? '%' : '0'}
              />
            </div>
          </Field>

          {settings.taxEnabled && (
            <Field label={t('invoices.taxKind')}>
              <Select
                value={form.taxKind ?? 'none'}
                disabled={locked}
                onChange={(event) => set('taxKind', event.target.value)}
              >
                <option value="none">{t('invoices.taxKind.none')}</option>
                <option value="tax1">
                  {taxLabelOf(settings, 'tax1')} ({toNumber(settings.taxRate1 ?? settings.taxRate)}%)
                </option>
                <option value="tax2">
                  {taxLabelOf(settings, 'tax2')} ({toNumber(settings.taxRate2)}%)
                </option>
              </Select>
            </Field>
          )}

          <Field label={`${t('invoices.nextPaymentDate')} (${t('common.optional')})`}>
            <Input
              type="date"
              value={form.nextPaymentDate ?? ''}
              onChange={(event) => set('nextPaymentDate', event.target.value)}
            />
          </Field>

          <Field label={`${t('common.notes')} (${t('common.optional')})`}>
            <Textarea value={form.notes ?? ''} onChange={(event) => set('notes', event.target.value)} />
          </Field>
        </div>

        <div className="h-fit rounded-2xl bg-slate-50 p-4">
          <TotalRow label={t('invoices.subtotal')} value={totals.subtotal} />
          <TotalRow
            label={
              form.discountMode === 'percent'
                ? `${t('invoices.discount')} ${toNumber(form.discount)}%`
                : t('invoices.discount')
            }
            value={-totals.discount}
          />
          {taxEnabled && (
            <TotalRow
              label={`${taxLabelOf(settings, taxKind) || t('invoices.tax')} ${taxRate}%`}
              value={totals.taxAmount}
            />
          )}

          {totals.adBudgetTotal > 0 && (
            <div className="my-2 rounded-xl bg-white px-3 py-2">
              <TotalRow label={t('invoices.feesTotal')} value={totals.feesTotal + totals.taxAmount} />
              <TotalRow label={t('invoices.adBudgetTotal')} value={totals.adBudgetTotal} />
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{t('invoices.adBudgetNote')}</p>
            </div>
          )}

          <div className="mt-2 border-t border-slate-200 pt-2">
            <TotalRow label={t('invoices.total')} value={totals.total} strong />
          </div>
        </div>
      </div>

      {/* التحصيل داخل نفس النموذج — الفاتورة وحالتها تُسجَّلان معًا */}
      <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-bold text-slate-900">{t('invoices.collectNow')}</h4>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCollect((current) => ({ ...current, amount: String(totals.total) }))}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
            >
              {t('invoices.paidInFull')}
            </button>
            <button
              type="button"
              onClick={() => setCollect((current) => ({ ...current, amount: '' }))}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              {t('invoices.notPaid')}
            </button>
          </div>
        </div>

        <p className="mb-3 text-xs leading-relaxed text-slate-500">{t('invoices.collectHint')}</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('invoices.paymentAmount')}>
            <Input
              numeric
              value={collect.amount}
              onChange={(event) => setCollect((current) => ({ ...current, amount: event.target.value }))}
              placeholder="0"
            />
          </Field>

          <Field label={t('invoices.paymentDate')}>
            <Input
              type="date"
              value={collect.date}
              onChange={(event) => setCollect((current) => ({ ...current, date: event.target.value }))}
            />
          </Field>

          {toNumber(collect.amount) > 0 && (
            <>
              <Field label={t('invoices.method')}>
                <Select
                  value={collect.methodId}
                  onChange={(event) => setCollect((current) => ({ ...current, methodId: event.target.value }))}
                >
                  <option value="">{t('common.none')}</option>
                  {methods
                    .filter((item) => !item.archived)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.accountNumber ? ` — ${item.accountNumber}` : ''}
                      </option>
                    ))}
                </Select>
              </Field>

              {collectMethod && collectMethod.type !== 'cash' && (
                <Field label={t('invoices.clientAccount')} hint={t('invoices.clientAccountHint')}>
                  <Input
                    numeric
                    value={collect.clientAccount}
                    onChange={(event) =>
                      setCollect((current) => ({ ...current, clientAccount: event.target.value }))
                    }
                  />
                </Field>
              )}
            </>
          )}
        </div>

        {toNumber(collect.amount) > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-emerald-200 pt-3">
            <span className="text-xs font-semibold text-slate-500">
              {t('invoices.remaining')}:{' '}
              <span className="num font-bold text-amber-600">
                {formatMoney(totals.total - toNumber(collect.amount))}
              </span>
            </span>
            <span className="text-xs font-semibold text-slate-500">
              {t('common.status')}:{' '}
              <span className="font-bold text-slate-700">
                {t(
                  `invoices.status.${
                    toNumber(collect.amount) > totals.total
                      ? 'credit'
                      : toNumber(collect.amount) >= totals.total
                        ? 'paid'
                        : 'partial'
                  }`,
                )}
              </span>
            </span>
          </div>
        )}
      </div>
    </>
  )

  if (asPage) {
    return (
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-6 py-4">
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
        </div>
        <div className="px-6 py-5">{body}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-6 py-4">
          {footerButtons}
        </div>
      </div>
    )
  }

  return (
    <Modal open={open} onClose={onClose} wide title={title} footer={footerButtons}>
      {body}
    </Modal>
  )
}

function TotalRow({ label, value, strong }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className={`text-sm ${strong ? 'font-bold text-slate-900' : 'font-semibold text-slate-500'}`}>
        {label}
      </span>
      <span className={`num ${strong ? 'text-lg font-extrabold text-slate-900' : 'text-sm font-semibold text-slate-700'}`}>
        {formatMoney(value)}
        <span className="ms-1 text-xs font-semibold text-slate-400">{t('common.currency')}</span>
      </span>
    </div>
  )
}

/**
 * جسم الفاتورة المطبوع — يُعرض على الشاشة داخل المودال، ويُطبع وحده
 * في صفحة واحدة نظيفة عبر PrintDocument.
 */
export function InvoicePrintable({ invoice, client, employeeMap, settings, locale }) {
  const { t } = useI18n()
  const state = statusOf(invoice)
  const items = invoice.items ?? []
  const remaining = remainingOf(invoice)

  return (
    <div className="mx-auto max-w-[800px] text-slate-800 print:max-w-none">
      <PrintHeader invoice={invoice} client={client} employeeMap={employeeMap} settings={settings} locale={locale} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(state)}>{t(`invoices.status.${state}`)}</Badge>
        {state === 'credit' && <span className="text-xs text-sky-600">{t('invoices.overpaid')}</span>}
        {invoice.cancelled && <Badge tone="slate">{t('invoices.cancelled')}</Badge>}
      </div>

      <table className="mb-5 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-slate-300 text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pe-2 text-start font-bold">{t('common.service')}</th>
            <th className="py-2 px-2 text-end font-bold">{t('common.price')}</th>
            <th className="py-2 px-2 text-end font-bold">{t('common.qty')}</th>
            <th className="py-2 ps-2 text-end font-bold">{t('common.total')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index} className="border-b border-slate-200">
              <td className="py-2.5 pe-2 align-top">
                <span className="font-semibold">{item.name}</span>
                {item.isAdBudget && (
                  <span className="ms-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                    {t('services.adBudget')}
                  </span>
                )}
              </td>
              <td className="num py-2.5 px-2 text-end text-slate-600">{formatMoney(item.price)}</td>
              <td className="num py-2.5 px-2 text-end text-slate-600">{item.qty}</td>
              <td className="num py-2.5 ps-2 text-end font-bold">{formatMoney(item.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-6">
        {settings.websiteUrl && (
          <div className="hidden shrink-0 text-center print:block">
            <p className="mb-1 text-[10px] font-bold text-slate-700">{t('invoices.socialMediaQr')}</p>
            <QrImage value={settings.websiteUrl} size={85} />
            <p className="mt-1 text-[10px] text-slate-400" dir="ltr">{settings.websiteUrl}</p>
          </div>
        )}
        <div className="ms-auto w-full max-w-xs">
        <TotalRow label={t('invoices.subtotal')} value={invoice.subtotal} />
        {toNumber(invoice.discount) > 0 && (
          <TotalRow
            label={
              invoice.discountMode === 'percent'
                ? `${t('invoices.discount')} ${toNumber(invoice.discountValue)}%`
                : t('invoices.discount')
            }
            value={-invoice.discount}
          />
        )}
        {invoice.taxEnabled && (
          <TotalRow
            label={`${taxLabelOf(settings, invoice.taxKind) || t('invoices.tax')} ${invoice.taxRate}%`}
            value={invoice.taxAmount}
          />
        )}
        {toNumber(invoice.adBudgetTotal) > 0 && (
          <div className="my-2 border-y border-slate-200 py-1">
            <TotalRow
              label={t('invoices.feesTotal')}
              value={toNumber(invoice.feesTotal) + toNumber(invoice.taxAmount)}
            />
            <TotalRow label={t('invoices.adBudgetTotal')} value={invoice.adBudgetTotal} />
          </div>
        )}
        <div className="mt-1 border-t-2 border-slate-300 pt-1">
          <TotalRow label={t('invoices.total')} value={invoice.total} strong />
        </div>
        <TotalRow label={t('invoices.paid')} value={invoice.paidAmount} />
        {remaining > 0 && <TotalRow label={t('invoices.remaining')} value={remaining} />}
        </div>
      </div>

      {invoice.nextPaymentDate && remaining > 0 && (
        <p className="mb-4 rounded-lg bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-800 print:bg-transparent print:px-0">
          {t('invoices.nextPaymentDate')}: {formatDate(invoice.nextPaymentDate, locale)}
        </p>
      )}

      {invoice.notes && <p className="mb-4 text-sm text-slate-600">{invoice.notes}</p>}

      <InvoiceFooter settings={settings} />
    </div>
  )
}

function PrintHeader({ invoice, client, employeeMap, settings, locale }) {
  const { t } = useI18n()
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
      <div className="flex items-center gap-3">
        {settings.logoUrl && (
          <img src={settings.logoUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl object-contain" />
        )}
        <div>
          <p className="text-2xl font-extrabold lowercase tracking-tight text-slate-900" style={{ direction: 'ltr' }}>
            {settings.companyName || 'iyora'}
          </p>
          <p className="text-xs text-slate-500">{settings.companyAddress || t('app.tagline')}</p>
          {(settings.companyPhone || settings.companyEmail) && (
            <p className="num text-xs text-slate-500" dir="ltr">
              {[settings.companyPhone, settings.companyEmail].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>
      <div className="text-end">
        <p className="num text-sm font-bold text-slate-900">{invoice.number}</p>
        <p className="text-xs text-slate-500">{formatDate(invoice.date, locale)}</p>
        {client && <p className="mt-1 text-sm font-semibold text-slate-700">{client.name}</p>}
        {client?.phone && <p className="num text-xs text-slate-500">{client.phone}</p>}
        {invoice.employeeId && employeeMap.get(invoice.employeeId) && (
          <p className="text-xs text-slate-500">
            {t('invoices.salesEmployee')}: {employeeMap.get(invoice.employeeId).name}
          </p>
        )}
        {invoice.accountantName && (
          <p className="text-xs text-slate-500">
            {t('invoices.accountant')}: {invoice.accountantName}
          </p>
        )}
      </div>
    </div>
  )
}

/** تذييل ثابت للفاتورة المطبوعة: حساب التحويل + شروط العقد (الـ QR فوق كتلة الضريبة) */
function InvoiceFooter({ settings }) {
  const { t } = useI18n()
  const hasBank = settings.bankName || settings.bankAccount || settings.bankHolder
  const hasTerms = Boolean(settings.contractTerms?.trim())

  if (!hasBank && !hasTerms) return null

  return (
    <div className={`mt-6 border-t border-slate-200 pt-4 ${hasBank ? '' : 'hidden print:block'}`}>
      {hasBank && (
        <div className="text-sm">
          <p className="mb-1 font-bold text-slate-900">{t('invoices.transferTo')}</p>
          {settings.bankName && <p className="text-slate-600">{t('settings.bankName')}: {settings.bankName}</p>}
          {settings.bankHolder && <p className="text-slate-600">{t('settings.bankHolder')}: {settings.bankHolder}</p>}
          {settings.bankAccount && (
            <p className="num text-slate-600" dir="ltr">{settings.bankAccount}</p>
          )}
        </div>
      )}

      {hasTerms && (
        <div className="mt-4 hidden print:block">
          <p className="mb-1 text-sm font-bold text-slate-900">{t('invoices.terms')}</p>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{settings.contractTerms}</p>
        </div>
      )}
    </div>
  )
}

export function PaymentForm({ open, busy, methods, remaining, onClose, onSave }) {
  const { t } = useI18n()
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [methodId, setMethodId] = useState('')
  const [clientAccount, setClientAccount] = useState('')
  const [touched, setTouched] = useState(false)

  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setAmount(remaining > 0 ? String(remaining) : '')
    setDate(todayISO())
    setMethodId('')
    setClientAccount('')
    setTouched(false)
  }
  if (!open && wasOpen) setWasOpen(false)

  const method = methods.find((item) => item.id === methodId)

  function submit() {
    setTouched(true)
    if (toNumber(amount) <= 0) return
    onSave({
      amount: toNumber(amount),
      date,
      methodId: methodId || null,
      methodName: method?.name ?? '',
      methodType: method?.type ?? '',
      ourAccount: method?.accountNumber ?? '',
      clientAccount: clientAccount.trim(),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('invoices.addPayment')}
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('invoices.paymentAmount')}
            error={touched && toNumber(amount) <= 0 ? t('common.required') : null}
          >
            <Input numeric value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>

          <Field label={t('invoices.paymentDate')}>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
        </div>

        <Field label={t('invoices.method')}>
          <Select value={methodId} onChange={(event) => setMethodId(event.target.value)}>
            <option value="">{t('common.none')}</option>
            {methods
              .filter((item) => !item.archived)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.accountNumber ? ` — ${item.accountNumber}` : ''}
                </option>
              ))}
          </Select>
        </Field>

        {method && method.type !== 'cash' && (
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold text-slate-500">{t('invoices.ourAccount')}</p>
            <p className="num text-sm font-bold text-slate-800">{method.accountNumber || '—'}</p>
            {method.accountHolder && <p className="text-xs text-slate-500">{method.accountHolder}</p>}
          </div>
        )}

        {method && method.type !== 'cash' && (
          <Field label={t('invoices.clientAccount')} hint={t('invoices.clientAccountHint')}>
            <Input numeric value={clientAccount} onChange={(event) => setClientAccount(event.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
