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
import { AUTO_COMMISSION, expectedCostOfItems, lineMargin, planCommission, resolveCommissionConfig, serviceCostBreakdown } from '../lib/costing'
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
export async function persistInvoiceEdit({ invoice, values, payment, invoices, employees, departments = [], jobCosts, uid }) {
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
  const plan = planCommission({ invoice: { ...values, id: invoiceId, paidAmount }, employee, existing, monthInvoices: patched, departments })
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
  const { rows: departments } = useCollection(COL.departments, 'name', 'asc')
  const { rows: services } = useCollection(COL.services, 'name', 'asc')
  const { rows: methods } = useCollection(COL.paymentMethods, 'name', 'asc')
  const { rows: activityTypes } = useCollection(COL.activityTypes, 'name', 'asc')
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
        const res = await createInvoiceClientSide({ values, number, payment, uid: user?.uid })
        invoiceId = res.invoiceId
      } else {
        await editInvoiceClientSide({ invoiceId, values, uid: user?.uid })
        if (payment) {
          await createPaymentClientSide({ invoiceId, payment, uid: user?.uid })
        }
      }

      if (invoiceId) {
        await syncCommission(invoiceId, values)

        let paidAmount = toNumber(editing?.paidAmount)
        if (payment) {
          paidAmount = (editing?.paidAmount || 0) + Number(payment.amount)
        }
        const patched = invoices.map((item) =>
          item.id === invoiceId ? { ...item, ...values, id: invoiceId, paidAmount } : item,
        )
        if (!invoices.some((item) => item.id === invoiceId)) {
          patched.push({ ...values, id: invoiceId, paidAmount, number: values.number })
        }
        await recalcClientTotals(values.clientId, patched)
        if (editing?.clientId && editing.clientId !== values.clientId) {
          await recalcClientTotals(editing.clientId, patched)
        }
      }
    } catch (error) {
      console.error('Invoice save error:', error)
      alert(`حدث خطأ أثناء حفظ الفاتورة:\n\n${error?.message || 'خطأ غير معروف'}`)
    }

    setBusy(false)
    setEditing(null)
  }

  /** يبقي تكلفة عمولة الموظف مطابقة للفاتورة بعد أي تعديل */
  async function syncCommission(invoiceId, values) {
    if (!invoiceId) return

    const employee = employees.find((item) => item.id === values.employeeId)
    const existing = jobCosts.find((cost) => cost.invoiceId === invoiceId && cost.auto === AUTO_COMMISSION)
    const plan = planCommission({ invoice: { ...values, id: invoiceId }, employee, existing, monthInvoices: invoices, departments })

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
   * ويحذف العمولة التلقائية من حساب الموظف.
   */
  async function cancelInvoice(reason) {
    setBusy(true)
    try {
      await cancelInvoiceClientSide({ invoiceId: cancelling.id, cancelReason: reason, cancelledDate: todayISO(), uid: user?.uid })
      await syncCommission(cancelling.id, { ...cancelling, cancelled: true })
      const patched = invoices.map((item) =>
        item.id === cancelling.id ? { ...item, cancelled: true } : item,
      )
      await recalcClientTotals(cancelling.clientId, patched)
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
      await syncCommission(invoice.id, { ...invoice, cancelled: false })
      const patched = invoices.map((item) =>
        item.id === invoice.id ? { ...item, cancelled: false } : item,
      )
      await recalcClientTotals(invoice.clientId, patched)
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

  return (
    <div>
      <PageHeader title={t('invoices.title')} subtitle={t('invoices.subtitle')}>
        <Button variant="ghost" onClick={() => setReceiptOpen(true)}>
          {t('receipts.button')}
        </Button>
        <Button onClick={() => setEditing({})}>
          + {t('invoices.add')}
        </Button>
      </PageHeader>

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
        departments={departments}
        services={services}
        methods={methods}
        activityTypes={activityTypes}
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

function QuickClientModal({ open, onClose, onCreated, employees = [], activityTypes = [] }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [phone, setPhone] = useState('')
  const [activityTypeId, setActivityTypeId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)

  const activeEmployees = employees.filter((e) => !e.archived && salesLike(e))

  async function handleSave() {
    setTouched(true)
    if (!name.trim()) return
    setBusy(true)
    try {
      const created = await createDoc(COL.clients, {
        name: name.trim(),
        businessName: businessName.trim(),
        phone: phone.trim(),
        activityTypeId: activityTypeId || null,
        employeeId: employeeId || null,
        address: address.trim(),
        totalInvoiced: 0,
        totalPaid: 0,
        balance: 0,
        invoicesCount: 0,
        isParent: false,
      })
      onCreated({ id: created.id, name: name.trim(), businessName: businessName.trim(), employeeId: employeeId || null })
      setName('')
      setBusinessName('')
      setPhone('')
      setActivityTypeId('')
      setEmployeeId('')
      setAddress('')
      setTouched(false)
    } catch (err) {
      console.error(err)
      alert(err?.message || 'حدث خطأ أثناء إضافة العميل.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="إضافة عميل جديد"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={busy}>
            {busy ? t('common.saving') : 'حفظ واختيار العميل'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('clients.name')} error={touched && !name.trim() ? t('common.required') : null}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم العميل الكامل..." autoFocus />
        </Field>

        <Field label={t('clients.businessName')}>
          <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="اسم الشركة أو النشاط..." />
        </Field>

        <Field label={t('common.phone')}>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="رقم الهاتف للتواصل..." />
        </Field>

        <Field label={t('clients.activityType')}>
          <Select value={activityTypeId} onChange={(e) => setActivityTypeId(e.target.value)}>
            <option value="">{t('common.none')}</option>
            {activityTypes.map((act) => (
              <option key={act.id} value={act.id}>
                {act.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('invoices.salesEmployee')} className="sm:col-span-2">
          <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">{t('common.none')}</option>
            {activeEmployees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('clients.address')} className="sm:col-span-2">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="العنوان..." />
        </Field>
      </div>
    </Modal>
  )
}

export function InvoiceForm({
  open,
  invoice,
  clients,
  employees,
  departments = [],
  services,
  methods,
  activityTypes = [],
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
  const [quickClientOpen, setQuickClientOpen] = useState(false)
  const [touched, setTouched] = useState(false)

  const key = invoice?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    const initialClientId = invoice?.clientId ?? ''
    const initialClient = clients.find((c) => c.id === initialClientId)
    const initialEmployeeId = invoice?.employeeId || initialClient?.employeeId || ''
    setForm({
      clientId: initialClientId,
      employeeId: initialEmployeeId,
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
    const effectiveEmployeeId = form.employeeId || client?.employeeId || null
    const employee = employees.find((item) => item.id === effectiveEmployeeId)

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
      responsibleEmployeeId: effectiveEmployeeId,
      responsibleEmployeeName: employee?.name ?? '',
      employeeId: effectiveEmployeeId,
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
        <Field
          label={
            <div className="flex items-center justify-between w-full">
              <span>{t('common.client')}</span>
              {!locked && (
                <button
                  type="button"
                  onClick={() => setQuickClientOpen(true)}
                  className="text-xs font-bold text-brand-600 hover:text-brand-800 hover:underline inline-flex items-center gap-1"
                >
                  <span>+</span>
                  <span>{t('clients.add') || 'إضافة عميل جديد'}</span>
                </button>
              )}
            </div>
          }
          error={touched && !form.clientId ? t('invoices.needClient') : null}
        >
          <SearchableSelect
            options={clients}
            value={form.clientId ?? ''}
            disabled={locked}
            placeholder={t('common.client')}
            searchPlaceholder="ابحث باسم العميل، الهاتف، أو الكود..."
            onChange={(val) => {
              const matchedClient = clients.find((c) => c.id === val)
              setForm((current) => ({
                ...current,
                clientId: val,
                employeeId: matchedClient?.employeeId || current.employeeId || '',
              }))
            }}
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
          {form.employeeId && (() => {
            const emp = employees.find((e) => e.id === form.employeeId)
            if (!emp) return null
            const cfg = resolveCommissionConfig(emp, departments)
            if (!cfg || cfg.commissionRate <= 0) return null
            return (
              <span className="mt-1 block text-xs text-sky-700 font-semibold">
                عمولة المبيعات: {cfg.commissionRate}% {cfg.source === 'department' ? '(موروثة من القسم)' : '(تخصيص فردي)'}
                {cfg.targetAmount > 0 && ` — تارجت: ${Number(cfg.targetAmount).toLocaleString()}`}
              </span>
            )
          })()}
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
        <QuickClientModal
          open={quickClientOpen}
          onClose={() => setQuickClientOpen(false)}
          onCreated={(newClient) => {
            setForm((current) => ({
              ...current,
              clientId: newClient.id,
              employeeId: newClient.employeeId || current.employeeId || '',
            }))
            setQuickClientOpen(false)
          }}
          employees={employees}
          activityTypes={activityTypes}
        />
      </div>
    )
  }

  return (
    <>
      <Modal open={open} onClose={onClose} wide title={title} footer={footerButtons}>
        {body}
      </Modal>
      <QuickClientModal
        open={quickClientOpen}
        onClose={() => setQuickClientOpen(false)}
        onCreated={(newClient) => {
          setForm((current) => ({
            ...current,
            clientId: newClient.id,
            employeeId: newClient.employeeId || current.employeeId || '',
          }))
          setQuickClientOpen(false)
        }}
        employees={employees}
        activityTypes={activityTypes}
      />
    </>
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

/* ------------------------------------------------------------------ */
/*  تصميم الفاتورة الاحترافي (Executive Invoice Printable Component)   */
/* ------------------------------------------------------------------ */

function TotalSummaryItem({ label, sublabel, value, currency = 'ج.م', tone = 'normal', isNegative = false, strong = false }) {
  const isDanger = tone === 'danger'
  const isSuccess = tone === 'success'
  const isWarning = tone === 'warning'
  
  return (
    <div className={`flex items-center justify-between py-1 text-xs ${strong ? 'font-bold' : 'font-medium'}`}>
      <div className="leading-tight">
        <span className={strong ? 'text-slate-900 font-bold text-sm' : isDanger ? 'text-rose-700 font-semibold' : 'text-slate-600'}>
          {label}
        </span>
        {sublabel && <span className="block text-[10px] text-slate-400 font-normal">{sublabel}</span>}
      </div>
      <div className={`${strong ? 'text-base font-black text-slate-900' : isDanger ? 'text-rose-600 font-bold' : isSuccess ? 'text-emerald-700 font-bold' : isWarning ? 'text-amber-700 font-bold' : 'text-slate-800 font-semibold'}`}>
        {isNegative && '- '}
        <span className="num">{formatMoney(Math.abs(value))}</span>
        <span className="ms-1 text-[10px] font-normal text-slate-400">{currency}</span>
      </div>
    </div>
  )
}

/**
 * جسم الفاتورة المطبوع — تصميم احترافي تنفيذي متكامل:
 * - بطاقة ورقية فاخرة على الشاشة
 * - توافق كامل ودقيق مع الطباعة والتصدير A4
 * - إبراز هوية الشركة ورقم الفاتورة وحالتها بدقة
 * - جدول بنود منظم بتدرج لوني وترقيم وأسعار دقيقة
 * - بطاقات متوازنة لبيانات العميل، السداد البنكي، والإجماليات
 */
export function InvoicePrintable({ invoice, client, employeeMap, settings, locale }) {
  const { t } = useI18n()
  const state = statusOf(invoice)
  const items = invoice.items ?? []
  const remaining = remainingOf(invoice)

  const isTaxInvoice = Boolean(invoice.taxEnabled)
  const isCancelled = Boolean(invoice.cancelled)
  const isFullyPaid = state === 'paid' && !isCancelled

  return (
    <div className="relative mx-auto max-w-[850px] bg-white text-slate-800 print:max-w-none print:bg-transparent">
      {/* ختم مائي للحالات الخاصة: ملغاة أو مدفوعة */}
      {isCancelled && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center select-none overflow-hidden">
          <div className="rotate-[-14deg] rounded-2xl border-4 border-dashed border-red-500/35 px-8 py-3 text-2xl font-black uppercase tracking-widest text-red-600/40">
            ملغاة • CANCELLED
          </div>
        </div>
      )}

      {/* الشريط العلوي للترويسة والهوية */}
      <PrintHeader
        invoice={invoice}
        client={client}
        employeeMap={employeeMap}
        settings={settings}
        locale={locale}
        state={state}
        isTaxInvoice={isTaxInvoice}
      />

      {/* شبكة معلومات العميل وبيانات الفاتورة */}
      <div className="my-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* بيانات العميل (Bill To) */}
        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4 text-xs">
          <div className="mb-2 flex items-center justify-between border-b border-slate-200 pb-2">
            <span className="font-extrabold uppercase tracking-wider text-slate-400 text-[10px]">
              فاتورة إلى • Billed To
            </span>
            <span className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
              العميل
            </span>
          </div>

          <h3 className="text-sm font-black text-slate-900">
            {client?.name || invoice.clientName || 'عميل نقدي'}
          </h3>

          {client?.businessName && (
            <p className="mt-0.5 font-bold text-brand-700 text-xs">
              {client.businessName}
            </p>
          )}

          <div className="mt-2.5 space-y-1 text-slate-600">
            {client?.phone && (
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">الهاتف:</span>
                <span className="num font-semibold text-slate-700" dir="ltr">{client.phone}</span>
              </div>
            )}
            {client?.address && (
              <div className="flex items-start gap-1.5">
                <span className="shrink-0 text-slate-400">العنوان:</span>
                <span className="text-slate-700">{client.address}</span>
              </div>
            )}
          </div>
        </div>

        {/* تفاصيل المستند والمواعيد والمسؤولين */}
        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4 text-xs">
          <div className="mb-2 flex items-center justify-between border-b border-slate-200 pb-2">
            <span className="font-extrabold uppercase tracking-wider text-slate-400 text-[10px]">
              بيانات المستند • Invoice Details
            </span>
            <span className="num font-mono font-bold text-slate-600">
              #{invoice.number}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div>
              <span className="block text-[10px] font-bold text-slate-400">تاريخ الإصدار:</span>
              <span className="num font-bold text-slate-800">{formatDate(invoice.date, locale)}</span>
            </div>

            {invoice.nextPaymentDate && (
              <div>
                <span className="block text-[10px] font-bold text-slate-400">تاريخ الاستحقاق:</span>
                <span className={`num font-bold ${remaining > 0 ? 'text-amber-700' : 'text-slate-800'}`}>
                  {formatDate(invoice.nextPaymentDate, locale)}
                </span>
              </div>
            )}

            <div>
              <span className="block text-[10px] font-bold text-slate-400">مسؤول المبيعات:</span>
              <span className="font-semibold text-slate-800">
                {invoice.responsibleEmployeeName || invoice.employeeName || (invoice.employeeId ? employeeMap?.get(invoice.employeeId)?.name : '—')}
              </span>
            </div>

            <div>
              <span className="block text-[10px] font-bold text-slate-400">المحاسب المسؤول:</span>
              <span className="font-semibold text-slate-800">
                {invoice.createdByName || invoice.accountantName || '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* جدول الخدمات والبنود */}
      <div className="mb-6 overflow-hidden rounded-2xl border border-slate-200">
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col style={{ width: '8%' }} />
            <col style={{ width: '44%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '18%' }} />
          </colgroup>
          <thead>
            <tr className="bg-slate-900 text-white print:bg-slate-800 print:text-white">
              <th className="py-3 px-2 text-center font-bold">#</th>
              <th className="py-3 px-3 text-start font-bold">الخدمة والبيان / Description</th>
              <th className="py-3 px-3 text-end font-bold">سعر الوحدة</th>
              <th className="py-3 px-2 text-center font-bold">الكمية</th>
              <th className="py-3 px-4 text-end font-bold">الإجمالي</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/80">
            {items.map((item, index) => (
              <tr key={index} className="transition-colors even:bg-slate-50/50 hover:bg-slate-50/80">
                <td className="py-3 px-2 text-center font-mono font-bold text-slate-400">
                  {String(index + 1).padStart(2, '0')}
                </td>
                <td className="py-3 px-3 align-middle text-start">
                  <div className="font-bold text-slate-800 text-sm">{item.name}</div>
                  {item.isAdBudget && (
                    <div className="mt-1">
                      <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-[10px] font-extrabold text-amber-800 ring-1 ring-inset ring-amber-300/50">
                        ميزانية إعلانات (عهدة منصات)
                      </span>
                    </div>
                  )}
                </td>
                <td className="py-3 px-3 text-end font-semibold text-slate-600">
                  <span className="num">{formatMoney(item.price)}</span>
                </td>
                <td className="py-3 px-2 text-center font-bold text-slate-800">
                  <span className="num">{item.qty}</span>
                </td>
                <td className="py-3 px-4 text-end text-sm font-black text-slate-900">
                  <span className="num">{formatMoney(item.total)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* القسم المالي وبيانات التحويل والملاحظات */}
      <div className="mb-6 grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
        {/* العمود الجانبي: البنك + كود QR + الملاحظات */}
        <div className="space-y-4">
          {/* بيانات التحويل البنكي */}
          {(settings.bankName || settings.bankAccount || settings.bankHolder) && (
            <div className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 text-xs">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-slate-700 text-[10px]">
                  🏛️
                </span>
                <span className="font-extrabold uppercase tracking-wide text-slate-800 text-[11px]">
                  بيانات التحويل البنكي • Bank Details
                </span>
              </div>

              <div className="space-y-1.5 text-slate-600">
                {settings.bankName && (
                  <div>
                    <span className="text-slate-400">اسم البنك: </span>
                    <span className="font-bold text-slate-800">{settings.bankName}</span>
                  </div>
                )}
                {settings.bankHolder && (
                  <div>
                    <span className="text-slate-400">اسم المستفيد: </span>
                    <span className="font-bold text-slate-800">{settings.bankHolder}</span>
                  </div>
                )}
                {settings.bankAccount && (
                  <div className="mt-2 rounded-xl border border-slate-200 bg-white p-2.5">
                    <span className="block text-[10px] font-bold text-slate-400">رقم الحساب / الآيبان (IBAN):</span>
                    <span className="num mt-0.5 block font-mono text-xs font-black text-slate-900 select-all" dir="ltr">
                      {settings.bankAccount}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* الباركود وروابط التواصل */}
          {settings.websiteUrl && (
            <div className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-slate-50/50 p-3">
              <div className="shrink-0 rounded-xl bg-white p-1 border border-slate-200 shadow-2xs">
                <QrImage value={settings.websiteUrl} size={68} />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-800">امسح الرمز للزيارة أو التحقق</p>
                <p className="mt-0.5 text-[10px] text-slate-500">Scan QR Code for company website & verification</p>
                <p className="num mt-1 text-[11px] font-bold text-brand-700 hover:underline" dir="ltr">
                  {settings.websiteUrl}
                </p>
              </div>
            </div>
          )}

          {/* ملاحظات خاصة بالفاتورة */}
          {invoice.notes && (
            <div className="rounded-2xl border border-amber-200/80 bg-amber-50/40 p-4 text-xs leading-relaxed text-amber-950">
              <span className="block font-bold text-amber-900 mb-1">ملاحظات الفاتورة • Notes:</span>
              <p className="whitespace-pre-wrap">{invoice.notes}</p>
            </div>
          )}
        </div>

        {/* صندوق الإجماليات التنفيذي */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5 shadow-2xs">
          <h4 className="mb-3 border-b border-slate-200 pb-2 text-xs font-extrabold uppercase tracking-wider text-slate-500">
            الملخص المالي • Financial Summary
          </h4>

          <div className="space-y-1.5 divide-y divide-slate-200/60">
            {/* المجموع الفرعي */}
            <div className="pt-1">
              <TotalSummaryItem label={t('invoices.subtotal')} value={invoice.subtotal} />
            </div>

            {/* الخصم */}
            {toNumber(invoice.discount) > 0 && (
              <div className="pt-1.5">
                <TotalSummaryItem
                  label={
                    invoice.discountMode === 'percent'
                      ? `${t('invoices.discount')} (${toNumber(invoice.discountValue)}%)`
                      : t('invoices.discount')
                  }
                  value={invoice.discount}
                  tone="danger"
                  isNegative
                />
              </div>
            )}

            {/* تفصيل الأتعاب وميزانية الإعلانات عند وجودها */}
            {toNumber(invoice.adBudgetTotal) > 0 && (
              <div className="pt-1.5 space-y-1">
                <TotalSummaryItem label={t('invoices.feesTotal')} value={invoice.feesTotal} />
                <TotalSummaryItem label={t('invoices.adBudgetTotal')} value={invoice.adBudgetTotal} />
              </div>
            )}

            {/* الضريبة */}
            {invoice.taxEnabled && (
              <div className="pt-1.5">
                <TotalSummaryItem
                  label={`${taxLabelOf(settings, invoice.taxKind) || t('invoices.tax')} (${invoice.taxRate}%)`}
                  value={invoice.taxAmount}
                />
              </div>
            )}

            {/* الإجمالي النهائي البارز */}
            <div className="pt-3">
              <div className="rounded-xl bg-slate-900 p-4 text-white shadow-sm print:bg-slate-900 print:text-white">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-300">
                      {t('invoices.total')}
                    </span>
                    <span className="text-[10px] text-slate-400">Total Net Amount</span>
                  </div>
                  <div className="num text-2xl font-black text-white">
                    {formatMoney(invoice.total)}
                    <span className="ms-1.5 text-xs font-semibold text-slate-300">{t('common.currency')}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* حالة السداد: المدفوع والمتبقي */}
            <div className="pt-3 space-y-2">
              <div className="flex items-center justify-between rounded-xl bg-emerald-50/80 px-3.5 py-2 text-xs font-bold text-emerald-800 border border-emerald-200/60">
                <span>المبلغ المسدد (Paid Amount):</span>
                <span className="num font-black text-emerald-700">
                  {formatMoney(invoice.paidAmount)} {t('common.currency')}
                </span>
              </div>

              {remaining > 0 ? (
                <div className="flex items-center justify-between rounded-xl bg-amber-50/80 px-3.5 py-2 text-xs font-bold text-amber-900 border border-amber-200/60">
                  <span>المتبقي المستحق (Balance Due):</span>
                  <span className="num font-black text-amber-700">
                    {formatMoney(remaining)} {t('common.currency')}
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-between rounded-xl bg-slate-100 px-3.5 py-1.5 text-[11px] font-bold text-slate-700">
                  <span>حالة الفاتورة:</span>
                  <span className="text-emerald-700">تم سداد كامل القيمة بنجاح ✓</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* الشروط والتوقيعات والاعتماد */}
      <InvoiceFooter settings={settings} />
    </div>
  )
}

function PrintHeader({ invoice, client, employeeMap, settings, locale, state, isTaxInvoice }) {
  const { t } = useI18n()

  const statusLabel = {
    paid: 'مدفوعة بالكامل • Paid',
    partial: 'مدفوعة جزئياً • Partial',
    unpaid: 'مستحقة الدفع • Due',
    credit: 'رصيد دائن • Credit',
  }[state] ?? state

  const statusToneClasses = {
    paid: 'bg-emerald-50 text-emerald-700 border-emerald-300/80',
    partial: 'bg-amber-50 text-amber-700 border-amber-300/80',
    unpaid: 'bg-rose-50 text-rose-700 border-rose-300/80',
    credit: 'bg-sky-50 text-sky-700 border-sky-300/80',
  }[state] ?? 'bg-slate-50 text-slate-700 border-slate-200'

  return (
    <div className="border-b-2 border-slate-200 pb-5">
      <div className="flex flex-wrap items-start justify-between gap-6">
        {/* هوية الشركة ومعلوماتها */}
        <div className="flex items-start gap-4">
          {settings.logoUrl ? (
            <div className="flex h-16 w-20 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xs">
              <img src={settings.logoUrl} alt={settings.companyName || 'logo'} className="h-full w-full object-contain" />
            </div>
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-slate-900 font-black text-xl text-white shadow-2xs">
              {(settings.companyName || 'IY').slice(0, 2).toUpperCase()}
            </div>
          )}

          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900" style={{ direction: 'ltr' }}>
              {settings.companyName || 'iyora'}
            </h1>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {settings.companyAddress || t('app.tagline')}
            </p>
            {(settings.companyPhone || settings.companyEmail) && (
              <p className="num mt-1 text-xs text-slate-500" dir="ltr">
                {[settings.companyPhone, settings.companyEmail].filter(Boolean).join(' • ')}
              </p>
            )}
          </div>
        </div>

        {/* عنوان المستند ورقمه وحالته */}
        <div className="text-end">
          <div className="inline-block text-end">
            <h2 className="text-2xl font-black tracking-tight text-slate-900">
              {isTaxInvoice ? 'فاتورة ضريبية' : 'فاتورة مبيعات'}
            </h2>
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-400">
              {isTaxInvoice ? 'TAX INVOICE' : 'SALES INVOICE'}
            </span>
          </div>

          <div className="mt-2.5 flex items-center justify-end gap-2">
            <div className="rounded-xl border border-slate-900 bg-slate-900 px-3.5 py-1 text-white shadow-2xs print:border print:border-slate-800">
              <span className="text-[10px] text-slate-300 font-normal me-1.5">No.</span>
              <span className="num font-mono font-black text-sm tracking-wider">
                {invoice.number}
              </span>
            </div>

            <div className={`rounded-xl border px-3 py-1 text-xs font-bold ${statusToneClasses}`}>
              {statusLabel}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** تذييل الفاتورة: الشروط والأحكام ومساحة الاعتماد والتوقيعات الرسمية */
function InvoiceFooter({ settings }) {
  const hasTerms = Boolean(settings.contractTerms?.trim())

  return (
    <div className="mt-8 border-t border-slate-200 pt-6">
      {/* الشروط والأحكام إن وجدت */}
      {hasTerms && (
        <div className="mb-6 rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4 text-xs">
          <h5 className="mb-1.5 font-bold text-slate-900">الشروط والأحكام العامة • Terms & Conditions</h5>
          <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-600">
            {settings.contractTerms}
          </p>
        </div>
      )}

      {/* مساحة التوقيعات والاعتماد الرسمي */}
      <div className="grid grid-cols-2 gap-8 text-center text-xs">
        <div>
          <p className="font-bold text-slate-700">توقيع المستلم / العميل</p>
          <p className="text-[10px] text-slate-400">Customer Acceptance</p>
          <div className="mt-10 mx-auto w-44 border-b border-dashed border-slate-300" />
        </div>
        <div>
          <p className="font-bold text-slate-700">الختم والاعتماد الرسمي</p>
          <p className="text-[10px] text-slate-400">Authorized Signature & Stamp</p>
          <div className="mt-10 mx-auto w-44 border-b border-dashed border-slate-300" />
        </div>
      </div>

      <div className="mt-8 border-t border-slate-100 pt-3 text-center text-[11px] font-semibold text-slate-400">
        شكراً لتعاملكم معنا • Thank you for your business
      </div>
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
