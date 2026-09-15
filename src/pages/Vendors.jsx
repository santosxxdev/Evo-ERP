import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { COL, createDoc, deleteDocById, updateDocById, useCollection } from '../lib/db'
import { formatDate, formatMoney, round2, todayISO, toNumber } from '../lib/format'
import { formalVendorBalance, vendorBalance, vendorTypeLabel } from '../lib/costing'
import { DEFAULT_ACCOUNTS } from '../lib/accounts'
import ManagedSelect from '../components/ManagedSelect'
import SearchableSelect from '../components/SearchableSelect'
import {
  createPurchaseInvoiceClientSide,
  createVendorPaymentClientSide,
  createVendorAdvanceClientSide,
  createPurchaseReturnClientSide,
  cancelPurchaseInvoiceClientSide,
  createSupplierCreditNoteClientSide,
  applyVendorAdvanceClientSide,
} from '../lib/clientVendors'
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
  TableWrap,
  Td,
  Textarea,
  Th,
} from '../components/ui'
import { IconClients } from '../components/Icons'

export const VENDORS_COL = 'vendors'
export const JOB_COSTS_COL = 'jobCosts'
export const PURCHASE_INVOICES_COL = 'purchaseInvoices'
export const PURCHASE_RETURNS_COL = 'purchaseReturns'
export const SUPPLIER_CREDIT_NOTES_COL = 'supplierCreditNotes'
export const VENDOR_ADVANCES_COL = 'vendorAdvances'
export const SUPPLIER_PAYABLES_COL = 'supplierPayables'
export const VENDOR_SPECIALTY_DEFAULTS = ['موديل', 'تصوير ومونتاج', 'تصميم جرافيك', 'إيجار معدات', 'صوت', 'أخرى']

export default function Vendors() {
  const { t, locale } = useI18n()

  const { rows: vendors, loading } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: costs } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: purchaseInvoices } = useCollection(PURCHASE_INVOICES_COL, 'date', 'desc')
  const { rows: purchaseReturns } = useCollection(PURCHASE_RETURNS_COL, 'returnDate', 'desc')
  const { rows: creditNotes } = useCollection(SUPPLIER_CREDIT_NOTES_COL, 'creditNoteDate', 'desc')
  const { rows: advances } = useCollection(VENDOR_ADVANCES_COL, 'advanceDate', 'desc')
  const { rows: supplierPayables } = useCollection(SUPPLIER_PAYABLES_COL, 'createdAt', 'desc')
  const { rows: accounts } = useCollection(COL.accounts, 'code', 'asc')
  const { rows: paymentMethods } = useCollection('paymentMethods', 'name', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc')
  const { rows: services } = useCollection(COL.services, 'name', 'asc')

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [addingInvoice, setAddingInvoice] = useState(null)
  const [addingPayment, setAddingPayment] = useState(null)
  const [addingReturn, setAddingReturn] = useState(null)
  const [addingCreditNote, setAddingCreditNote] = useState(null)
  const [addingAdvance, setAddingAdvance] = useState(null)
  const [applyingAdvance, setApplyingAdvance] = useState(null)
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  const activeVendors = useMemo(() => vendors.filter((v) => !v.archived), [vendors])

  const enriched = useMemo(
    () =>
      activeVendors.map((vendor) => {
        const formal = formalVendorBalance(vendor.id, purchaseInvoices, supplierPayables)
        const legacy = vendorBalance(vendor.id, costs)
        return {
          ...vendor,
          formal,
          legacy,
          due: formal.due,
          paid: formal.totalPaid,
          earned: formal.totalPurchases,
        }
      }),
    [activeVendors, purchaseInvoices, supplierPayables, costs],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return enriched
    return enriched.filter((vendor) =>
      [vendor.name, vendor.phone, vendor.specialty].some((value) =>
        String(value ?? '').toLowerCase().includes(needle),
      ),
    )
  }, [enriched, query])

  const totalDue = enriched.reduce((sum, vendor) => sum + vendor.formal.due, 0)
  const totalPaid = enriched.reduce((sum, vendor) => sum + vendor.formal.totalPaid, 0)

  async function save(values) {
    setBusy(true)
    setErrorMsg(null)
    try {
      if (editing?.id) await updateDocById(VENDORS_COL, editing.id, values)
      else await createDoc(VENDORS_COL, { ...values, archived: false })
      setEditing(null)
    } catch (err) {
      setErrorMsg(err.message || 'حدث خطأ أثناء حفظ البيانات')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!removing) return
    setBusy(true)
    setErrorMsg(null)
    try {
      const hasInvoiceHistory = purchaseInvoices.some((p) => p.vendorId === removing.id)
      const hasJobHistory = costs.some((c) => c.vendorId === removing.id)

      if (hasInvoiceHistory || hasJobHistory) {
        // Soft delete / archive to preserve historical accounting identity
        await updateDocById(VENDORS_COL, removing.id, { archived: true })
      } else {
        await deleteDocById(VENDORS_COL, removing.id)
      }
      setRemoving(null)
    } catch (err) {
      setErrorMsg(err.message || 'حدث خطأ أثناء حذف المورد')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('vendors.title')} subtitle={t('vendors.subtitle')}>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setAddingInvoice({})}>
            + فاتورة شراء جديدة
          </Button>
          <Button onClick={() => setEditing({})}>+ {t('vendors.add')}</Button>
        </div>
      </PageHeader>

      {errorMsg && (
        <div className="mb-4 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-700">
          {errorMsg}
        </div>
      )}

      {enriched.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-3">
          <StatCard label={t('vendors.count')} value={enriched.length} Icon={IconClients} />
          <StatCard
            label="إجمالي مستحقات الموردين (حساب 211)"
            value={formatMoney(totalDue)}
            suffix={t('common.currency')}
            tone="text-amber-600 bg-amber-50"
          />
          <StatCard
            label="إجمالي المسدد للموردين"
            value={formatMoney(totalPaid)}
            suffix={t('common.currency')}
            tone="text-emerald-600 bg-emerald-50"
          />
        </div>
      )}

      {enriched.length === 0 ? (
        <EmptyState
          title={t('vendors.empty')}
          message={t('vendors.emptyHint')}
          action={<Button onClick={() => setEditing({})}>+ {t('vendors.add')}</Button>}
        />
      ) : (
        <>
          <div className="mb-4">
            <SearchInput value={query} onChange={setQuery} placeholder={t('vendors.search')} />
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.name')}</Th>
                <Th>{t('vendors.specialty')}</Th>
                <Th>{t('common.phone')}</Th>
                <Th>فواتير الشراء</Th>
                <Th>إجمالي المشتروات</Th>
                <Th>المستحق (ذمم 211)</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((vendor) => (
                <tr key={vendor.id}>
                  <Td className="font-semibold text-slate-800">{vendor.name}</Td>
                  <Td>
                    {vendor.specialty ? (
                      <Badge tone="brand">{vendorTypeLabel(vendor.specialty, t)}</Badge>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="num text-slate-600">{vendor.phone || '—'}</span>
                  </Td>
                  <Td>
                    <span className="num text-slate-600">{vendor.formal.count}</span>
                  </Td>
                  <Td>
                    <span className="num text-slate-700">{formatMoney(vendor.formal.totalPurchases)}</span>
                  </Td>
                  <Td>
                    <span
                      className={`num font-bold ${
                        vendor.formal.due > 0 ? 'text-amber-600' : 'text-emerald-600'
                      }`}
                    >
                      {formatMoney(vendor.formal.due)}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setViewing(vendor)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                      >
                        كشف الحساب
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddingInvoice({ vendorId: vendor.id })}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                      >
                        + فاتورة
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(vendor)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemoving(vendor)}
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
        </>
      )}

      <VendorForm
        open={Boolean(editing)}
        row={editing}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={save}
      />

      <PurchaseInvoiceModal
        open={Boolean(addingInvoice)}
        initialVendorId={addingInvoice?.vendorId}
        vendors={activeVendors}
        accounts={accounts}
        services={services}
        busy={busy}
        onClose={() => setAddingInvoice(null)}
      />

      <VendorPaymentModal
        open={Boolean(addingPayment)}
        invoice={addingPayment}
        paymentMethods={paymentMethods}
        busy={busy}
        onClose={() => setAddingPayment(null)}
      />

      <PurchaseReturnModal
        open={Boolean(addingReturn)}
        initialInvoice={addingReturn}
        purchaseInvoices={purchaseInvoices}
        busy={busy}
        onClose={() => setAddingReturn(null)}
      />

      <SupplierCreditNoteModal
        open={Boolean(addingCreditNote)}
        initialVendorId={addingCreditNote?.vendorId}
        vendors={activeVendors}
        purchaseInvoices={purchaseInvoices}
        busy={busy}
        onClose={() => setAddingCreditNote(null)}
      />

      <VendorAdvanceModal
        open={Boolean(addingAdvance)}
        initialVendorId={addingAdvance?.vendorId}
        vendors={activeVendors}
        paymentMethods={paymentMethods}
        busy={busy}
        onClose={() => setAddingAdvance(null)}
      />

      <ApplyVendorAdvanceModal
        open={Boolean(applyingAdvance)}
        advance={applyingAdvance}
        purchaseInvoices={purchaseInvoices}
        busy={busy}
        onClose={() => setApplyingAdvance(null)}
      />

      <VendorStatement
        open={Boolean(viewing)}
        vendor={viewing}
        purchaseInvoices={purchaseInvoices}
        supplierPayables={supplierPayables}
        purchaseReturns={purchaseReturns}
        creditNotes={creditNotes}
        advances={advances}
        costs={costs}
        invoices={invoices}
        clients={clients}
        expenses={expenses}
        paymentMethods={paymentMethods}
        locale={locale}
        onClose={() => setViewing(null)}
        onAddInvoice={(vId) => setAddingInvoice({ vendorId: vId })}
        onAddPayment={(inv) => setAddingPayment(inv)}
        onAddReturn={(inv) => setAddingReturn(inv)}
        onAddCreditNote={(vId) => setAddingCreditNote({ vendorId: vId })}
        onAddAdvance={(vId) => setAddingAdvance({ vendorId: vId })}
        onApplyAdvance={(adv) => setApplyingAdvance(adv)}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={t('common.deleteTitle')}
        message={`هل أنت تأكد من حذف/أرشفة المورد "${removing?.name ?? ''}"؟ (إذا كان لديه سجلات مالية سابقة سيتم تعطيله وأرشفته دون حذف التاريخ المحاسبي)`}
      />
    </div>
  )
}

function VendorForm({ open, row, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      name: row?.name ?? '',
      specialty: row?.specialty ?? '',
      phone: row?.phone ?? '',
      email: row?.email ?? '',
      defaultRate: row?.defaultRate ?? '',
      notes: row?.notes ?? '',
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const invalid = !form.name?.trim()

  function submit() {
    setTouched(true)
    if (invalid) return
    onSave({
      name: form.name.trim(),
      specialty: form.specialty,
      phone: form.phone?.trim() ?? '',
      email: form.email?.trim() ?? '',
      defaultRate: toNumber(form.defaultRate),
      notes: form.notes?.trim() ?? '',
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={row?.id ? t('vendors.edit') : t('vendors.add')}
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
        <Field label={t('common.name')} error={touched && invalid ? t('common.required') : null}>
          <Input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('vendors.specialty')}>
            <ManagedSelect
              collectionName="vendorSpecialties"
              value={form.specialty}
              onChange={(next) => set('specialty', next)}
              defaults={VENDOR_SPECIALTY_DEFAULTS}
            />
          </Field>

          <Field label={t('vendors.defaultRate')} hint={t('vendors.defaultRateHint')}>
            <Input numeric value={form.defaultRate ?? ''} onChange={(event) => set('defaultRate', event.target.value)} />
          </Field>

          <Field label={t('common.phone')}>
            <Input numeric value={form.phone ?? ''} onChange={(event) => set('phone', event.target.value)} />
          </Field>

          <Field label={`${t('common.email')} (${t('common.optional')})`}>
            <Input dir="ltr" value={form.email ?? ''} onChange={(event) => set('email', event.target.value)} />
          </Field>
        </div>

        <Field label={`${t('common.notes')} (${t('common.optional')})`}>
          <Textarea value={form.notes ?? ''} onChange={(event) => set('notes', event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function PurchaseInvoiceModal({ open, initialVendorId, vendors, accounts, services = [], busy, onClose }) {
  const [form, setForm] = useState({
    vendorId: '',
    invoiceNumber: '',
    date: todayISO(),
    dueDate: todayISO(),
    purchaseType: 'expense',
    serviceId: '',
    accountId: '',
    subtotal: '',
    taxAmount: '0',
    description: '',
  })
  const [errorMsg, setErrorMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  const availableAccounts = useMemo(() => {
    const raw = accounts && accounts.length > 0
      ? accounts
      : DEFAULT_ACCOUNTS.map((a, i) => ({ id: a.id || a.code || `def-${i}`, ...a }))
    return raw.filter((acct) => !acct.isGroup && !acct.archived && acct.active !== false)
  }, [accounts])

  const serviceOptions = useMemo(() => {
    return (services || []).map((s) => ({
      id: s.id,
      name: `${s.name} ${s.price ? `(${formatMoney(s.price)} EGP)` : ''}`,
      raw: s,
    }))
  }, [services])

  // Helper to resolve the best matching debit account for a given service or purchase type
  function findMatchingAccount(pType, serviceObj) {
    if (!availableAccounts || availableAccounts.length === 0) return ''

    if (serviceObj) {
      const sName = (serviceObj.name || '').toLowerCase()
      if (sName.includes('تصوير') || sName.includes('مونتاج') || sName.includes('فيديو') || sName.includes('فديو')) {
        const match = availableAccounts.find(a => a.role === 'costVideo' || a.code === '5102' || a.name.includes('تصوير'))
        if (match) return match.id
      }
      if (sName.includes('تصميم') || sName.includes('جرافيك') || sName.includes('هوّية')) {
        const match = availableAccounts.find(a => a.role === 'costDesign' || a.code === '5103' || a.name.includes('تصميم'))
        if (match) return match.id
      }
      if (sName.includes('موديل') || sName.includes('محتوى') || sName.includes('ugc')) {
        const match = availableAccounts.find(a => a.role === 'costModel' || a.code === '5101' || a.name.includes('موديل'))
        if (match) return match.id
      }
      if (sName.includes('إيجار') || sName.includes('معدات') || sName.includes('استوديو')) {
        const match = availableAccounts.find(a => a.role === 'costEquipment' || a.code === '5104' || a.name.includes('معدات'))
        if (match) return match.id
      }
      if (sName.includes('عمولة') || sName.includes('تسويق') || sName.includes('ميديا')) {
        const match = availableAccounts.find(a => a.role === 'costCommission' || a.code === '5105' || a.name.includes('عمول'))
        if (match) return match.id
      }
      // General direct cost fallback
      const costMatch = availableAccounts.find(a => a.role === 'costOther' || a.code === '5106' || String(a.code).startsWith('51'))
      if (costMatch) return costMatch.id
    }

    if (pType === 'asset') {
      const assetMatch = availableAccounts.find(a => a.role === 'equipment' || a.code === '120101' || String(a.code).startsWith('1201'))
      if (assetMatch) return assetMatch.id
    } else if (pType === 'inventory') {
      const invMatch = availableAccounts.find(a => a.role === 'inventory' || a.code === '1103' || String(a.code).startsWith('1103'))
      if (invMatch) return invMatch.id
    } else {
      const expMatch = availableAccounts.find(a => a.role === 'costOther' || a.code === '5106' || String(a.code).startsWith('5'))
      if (expMatch) return expMatch.id
    }

    return availableAccounts[0]?.id || ''
  }

  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== initialVendorId) {
    setLastKey(initialVendorId)
    const defaultPType = 'expense'
    const defaultAcctId = findMatchingAccount(defaultPType, null)
    setForm({
      vendorId: initialVendorId || (vendors[0]?.id ?? ''),
      invoiceNumber: `PUR-${Date.now().toString().slice(-6)}`,
      date: todayISO(),
      dueDate: todayISO(),
      purchaseType: defaultPType,
      serviceId: '',
      accountId: defaultAcctId,
      subtotal: '',
      taxAmount: '0',
      description: '',
    })
    setErrorMsg(null)
  }

  useEffect(() => {
    if (!open) return
    if (!form.accountId && availableAccounts.length > 0) {
      const sObj = (services || []).find((s) => s.id === form.serviceId)
      const matchedId = findMatchingAccount(form.purchaseType, sObj)
      if (matchedId) {
        setForm((f) => ({ ...f, accountId: matchedId }))
      }
    }
  }, [open, availableAccounts, services, form.serviceId, form.purchaseType, form.accountId])

  function handleServiceChange(selectedServiceId) {
    const s = (services || []).find((srv) => srv.id === selectedServiceId)
    const resolvedAcctId = findMatchingAccount(form.purchaseType, s)
    setForm((f) => ({
      ...f,
      serviceId: selectedServiceId,
      accountId: resolvedAcctId || f.accountId,
      description: s ? s.name : f.description,
      subtotal: s && !f.subtotal && s.price ? String(s.price) : f.subtotal,
    }))
  }

  function handlePurchaseTypeChange(pType) {
    const s = (services || []).find((srv) => srv.id === form.serviceId)
    const resolvedAcctId = findMatchingAccount(pType, s)
    setForm((f) => ({
      ...f,
      purchaseType: pType,
      accountId: resolvedAcctId || f.accountId,
    }))
  }

  const subtotalNum = toNumber(form.subtotal)
  const taxNum = toNumber(form.taxAmount)
  const totalNum = round2(subtotalNum + taxNum)

  async function submit() {
    if (!form.vendorId || !form.date || subtotalNum <= 0) {
      setErrorMsg('يرجى استكمال الحقول المطلوبة (المورد، التاريخ، والمبلغ الإجمالي)')
      return
    }
    setSaving(true)
    setErrorMsg(null)
    try {
      await createPurchaseInvoiceClientSide({
        payload: {
          vendorId: form.vendorId,
          number: form.invoiceNumber,
          date: form.date,
          targetAccountId: form.accountId || undefined,
          subtotal: subtotalNum,
          taxAmount: taxNum,
          total: totalNum,
          notes: form.description,
        }
      })
      onClose()
    } catch (err) {
      setErrorMsg(err.message || 'فشل إنشاء فاتورة الشراء')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="إثبات فاتورة شراء رسمية (Purchase Invoice Entry)"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={saving || busy}>
            {saving ? 'جاري الترحيل...' : 'حفظ وترحيل الفاتورة'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorMsg && (
          <div className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">
            {errorMsg}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="المورد / الدائن (Supplier - AP Account 211)">
            <SearchableSelect
              options={vendors}
              value={form.vendorId}
              placeholder="اختر المورد..."
              searchPlaceholder="ابحث باسم المورد أو الهاتف..."
              onChange={(val) => setForm((f) => ({ ...f, vendorId: val }))}
            />
          </Field>

          <Field label="رقم فاتورة الشراء / المستند (Invoice No.)">
            <Input
              value={form.invoiceNumber}
              onChange={(e) => setForm((f) => ({ ...f, invoiceNumber: e.target.value }))}
            />
          </Field>

          <Field label="تاريخ الاستحقاق المحاسبي (Invoice Date)">
            <Input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
          </Field>

          <Field label="تصنيف القيد المدين (Debit Account Classification)">
            <Select
              value={form.purchaseType}
              onChange={(e) => handlePurchaseTypeChange(e.target.value)}
            >
              <option value="expense">مصروفات وتكاليف تشغيلية (Expense / COGS - 51/52)</option>
              <option value="asset">أصول ثابتة غير متداولة (Fixed Assets - 12)</option>
              <option value="inventory">مخزون ومواد متداولة (Inventory - 1103)</option>
            </Select>
          </Field>
        </div>

        <Field label="البند التشغيلي / الخدمة (Operational Item / Service)">
          <SearchableSelect
            options={serviceOptions}
            value={form.serviceId}
            placeholder="-- اختر الخدمة المعرفة (اختياري) --"
            searchPlaceholder="ابحث باسم الخدمة المعرفة..."
            onChange={(val) => handleServiceChange(val)}
          />
        </Field>

        <Field label="الحساب المحاسبي المدين (Debit Account - Dr.)">
          <SearchableSelect
            options={availableAccounts.map((acct) => ({
              id: acct.id,
              name: `${acct.code} - ${acct.name} (${acct.type})`,
              code: acct.code,
            }))}
            value={form.accountId}
            placeholder="-- اختيار تلقائي حسب نوع المشتريات / الخدمة --"
            searchPlaceholder="ابحث بكود الحساب أو اسمه..."
            onChange={(val) => setForm((f) => ({ ...f, accountId: val }))}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="المبلغ الصافي قبل الضريبة (Subtotal)">
            <Input
              numeric
              value={form.subtotal}
              onChange={(e) => setForm((f) => ({ ...f, subtotal: e.target.value }))}
              placeholder="10000"
            />
          </Field>

          <Field label="ضريبة القيمة المضافة المدخلات (Input VAT - 1104)">
            <Input
              numeric
              value={form.taxAmount}
              onChange={(e) => setForm((f) => ({ ...f, taxAmount: e.target.value }))}
              placeholder="1500"
            />
          </Field>

          <Field label="إجمالي الالتزام المستحق (Total AP Liability - 211)">
            <div className="flex h-10 items-center rounded-xl bg-slate-100 px-3 font-bold text-slate-900 num">
              {formatMoney(totalNum)}
            </div>
          </Field>
        </div>

        <Field label="البيان المحاسبي / شرح الفاتورة (Transaction Description & Memo)">
          <Textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="تفاصيل مشتريات الخدمات أو التجهيزات..."
          />
        </Field>
      </div>
    </Modal>
  )
}

function VendorPaymentModal({ open, invoice, paymentMethods, busy, onClose }) {
  const [amount, setAmount] = useState('')
  const [methodId, setMethodId] = useState('')
  const [date, setDate] = useState(todayISO())
  const [notes, setNotes] = useState('')
  const [errorMsg, setErrorMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  const remaining = round2(toNumber(invoice?.remainingAmount ?? invoice?.total))

  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== invoice?.id) {
    setLastKey(invoice?.id)
    setAmount(remaining > 0 ? String(remaining) : '')
    setMethodId(paymentMethods[0]?.id ?? '')
    setDate(todayISO())
    setNotes('')
    setErrorMsg(null)
  }

  async function submit() {
    const payNum = toNumber(amount)
    if (payNum <= 0) {
      setErrorMsg('مبلغ السداد يجب أن يكون أكبر من صفر')
      return
    }
    if (payNum > remaining + 0.0001) {
      setErrorMsg(`مبلغ السداد (${formatMoney(payNum)}) يتجاوز المتبقي المستحق على الفاتورة (${formatMoney(remaining)})`)
      return
    }
    if (!methodId) {
      setErrorMsg('يرجى اختيار طريقة الخزينة / الدفع')
      return
    }

    setSaving(true)
    setErrorMsg(null)
    try {
      await createVendorPaymentClientSide({
        payload: {
          vendorId: invoice.vendorId,
          purchaseInvoiceId: invoice.id,
          amount: payNum,
          methodId,
          date,
          notes,
        },
      })
      onClose()
    } catch (err) {
      setErrorMsg(err.message || 'فشل تسجيل سداد المورد')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`سداد فاتورة شراء #${invoice?.number || invoice?.invoiceNumber || ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={saving || busy}>
            {saving ? 'جاري الترحيل...' : 'إثبات السداد الخزني'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorMsg && (
          <div className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">
            {errorMsg}
          </div>
        )}

        <div className="rounded-xl bg-slate-50 p-3 text-xs">
          <div>إجمالي الفاتورة: <span className="font-bold num">{formatMoney(invoice?.total)}</span></div>
          <div>المسدد سابقًا: <span className="font-bold num">{formatMoney(invoice?.paidAmount)}</span></div>
          <div className="text-amber-700 font-bold">المتبقي المستحق: <span className="num">{formatMoney(remaining)}</span></div>
        </div>

        <Field label="مبلغ السداد">
          <Input numeric value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>

        <Field label="طريقة الدفع / الخزينة">
          <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            {paymentMethods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="تاريخ السداد">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>

        <Field label="ملاحظات السداد">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="رقم الشيك أو التحويل..." />
        </Field>
      </div>
    </Modal>
  )
}

function VendorStatement({
  open,
  vendor,
  purchaseInvoices = [],
  supplierPayables = [],
  purchaseReturns = [],
  creditNotes = [],
  advances = [],
  costs = [],
  invoices = [],
  clients = [],
  expenses = [],
  paymentMethods = [],
  locale,
  onClose,
  onAddInvoice,
  onAddPayment,
  onAddReturn,
  onAddCreditNote,
  onAddAdvance,
  onApplyAdvance,
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  if (!vendor) return null

  const formal = formalVendorBalance(vendor.id, purchaseInvoices, supplierPayables)

  const vendorPurchases = purchaseInvoices.filter((inv) => inv.vendorId === vendor.id)
  const vendorReturns = purchaseReturns.filter((r) => r.vendorId === vendor.id)
  const vendorCreditNotes = creditNotes.filter((cn) => cn.vendorId === vendor.id)
  const vendorAdvances = advances.filter((adv) => adv.vendorId === vendor.id)

  const totalAdvancesRemaining = vendorAdvances.reduce((sum, a) => sum + (a.reversed ? 0 : (a.remainingAmount || 0)), 0)

  // Build unified AP formal statement ledger rows (Account 211)
  const allAPEvents = []
  vendorPurchases.forEach(inv => {
    allAPEvents.push({
      id: inv.id,
      date: inv.date || inv.invoiceDate,
      type: 'فاتورة شراء',
      ref: inv.number || inv.invoiceNumber || inv.id.slice(0, 6),
      desc: inv.description || (inv.purchaseType === 'asset' ? 'أصل ثابت' : inv.purchaseType === 'inventory' ? 'مخزون' : 'مصروفات'),
      debit: 0,
      credit: inv.cancelled ? 0 : toNumber(inv.total),
      cancelled: Boolean(inv.cancelled),
      rawObj: inv,
      kind: 'invoice'
    })
  })

  vendorReturns.forEach(ret => {
    allAPEvents.push({
      id: ret.id,
      date: ret.returnDate,
      type: 'مردود مشتريات',
      ref: ret.number || ret.id.slice(0, 6),
      desc: ret.reason || 'إرجاع مشتريات',
      debit: ret.cancelled ? 0 : toNumber(ret.total),
      credit: 0,
      cancelled: Boolean(ret.cancelled),
      rawObj: ret,
      kind: 'return'
    })
  })

  vendorCreditNotes.forEach(cn => {
    allAPEvents.push({
      id: cn.id,
      date: cn.creditNoteDate,
      type: 'إشعار دائن للمورد',
      ref: cn.creditNoteNumber || cn.id.slice(0, 6),
      desc: cn.reason || 'إشعار دائن',
      debit: cn.cancelled ? 0 : toNumber(cn.total),
      credit: 0,
      cancelled: Boolean(cn.cancelled),
      rawObj: cn,
      kind: 'creditNote'
    })
  })

  const vendorPayables = (supplierPayables || []).filter((sp) => sp.supplierId === vendor.id)
  vendorPayables.forEach(sp => {
    const isReconciled = sp.status === 'reconciled'
    const isCancelled = sp.status === 'cancelled'
    allAPEvents.push({
      id: sp.id,
      date: sp.approvedAt || sp.createdAt,
      type: isReconciled ? 'تكلفة مسواة بفاتورة شراء' : 'تكلفة بند معتمدة',
      ref: `SP-${sp.id.slice(-6)}`,
      desc: isReconciled
        ? `تسوية مديونية بند مع فاتورة شراء (تسوية كاملة)`
        : sp.notes || (sp.supplierName ? `بند مشروع - ${sp.supplierName}` : 'استحقاق تكلفة مشروع'),
      debit: 0,
      credit: (isCancelled || isReconciled) ? 0 : toNumber(sp.approvedCost),
      cancelled: isCancelled || isReconciled,
      rawObj: sp,
      kind: 'itemPayable'
    })
  })

  allAPEvents.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))

  let runningAP = 0
  const formalRows = allAPEvents.map(evt => {
    runningAP += (evt.credit - evt.debit)
    return { ...evt, runningAP }
  })

  /* Legacy jobCosts for historical reference only */
  const legacyCosts = costs
    .filter((cost) => cost.vendorId === vendor.id)
    .slice()
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))

  async function cancelInvoice(inv) {
    if (!window.confirm(`هل أنت تأكد من إلغاء فاتورة الشراء #${inv.number || inv.invoiceNumber}؟`)) return
    setBusy(true)
    setErrorMsg(null)
    try {
      await cancelPurchaseInvoiceClientSide({ purchaseInvoiceId: inv.id })
    } catch (err) {
      setErrorMsg(err.message || 'فشل إلغاء الفاتورة')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`كشف حساب المورد — ${vendor.name}`}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => onAddInvoice(vendor.id)}>
            + فاتورة شراء
          </Button>
          <Button variant="secondary" onClick={() => onAddReturn(vendor.id)}>
            + مردود مشتريات
          </Button>
          <Button variant="secondary" onClick={() => onAddCreditNote(vendor.id)}>
            + إشعار دائن
          </Button>
          <Button variant="secondary" onClick={() => onAddAdvance(vendor.id)}>
            + دفعة مقدمة
          </Button>
          <Button variant="ghost" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      }
    >
      {errorMsg && (
        <div className="mb-4 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-700">
          {errorMsg}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {vendor.specialty && <Badge tone="brand">{vendorTypeLabel(vendor.specialty, t)}</Badge>}
        {vendor.phone && <span className="num text-xs font-semibold text-slate-500">{vendor.phone}</span>}
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatCard label="إجمالي الفواتير الرسمية" value={formatMoney(formal.totalPurchases)} suffix={t('common.currency')} />
        <StatCard
          label="إجمالي المسدد"
          value={formatMoney(formal.totalPaid)}
          suffix={t('common.currency')}
          tone="text-emerald-600 bg-emerald-50"
        />
        <StatCard
          label="ذمم مستحقة (حساب 211)"
          value={formatMoney(formal.due)}
          suffix={t('common.currency')}
          tone="text-amber-600 bg-amber-50"
        />
        <StatCard
          label="دفعت مسبقًا / أصول (حساب 115)"
          value={formatMoney(totalAdvancesRemaining)}
          suffix={t('common.currency')}
          tone="text-blue-600 bg-blue-50"
        />
      </div>

      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-bold text-slate-900">كشف حساب ذمم المورد الرسمية (حساب 211 - Vendor Payable)</h4>
          <div className="flex gap-1.5">
            <Button size="xs" onClick={() => onAddInvoice(vendor.id)}>+ فاتورة جديدة</Button>
            <Button size="xs" variant="secondary" onClick={() => onAddReturn(vendor.id)}>+ مردود</Button>
            <Button size="xs" variant="secondary" onClick={() => onAddCreditNote(vendor.id)}>+ إشعار دائن</Button>
          </div>
        </div>

        {formalRows.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            لا توجد فواتير شراء أو مردودات أو إشعارات محاسبية مسجلة لـ {vendor.name} بعد.
          </p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                <Th>نوع المستند</Th>
                <Th>المرجع / الوصف</Th>
                <Th>مدين (خصم AP)</Th>
                <Th>دائن (التزام AP)</Th>
                <Th>رصيد الذمم 211</Th>
                <Th className="w-px">الإجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {formalRows.map((row) => (
                <tr key={row.id} className={row.cancelled ? 'opacity-50 line-through' : ''}>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                  <Td>
                    <Badge tone={row.kind === 'return' ? 'amber' : row.kind === 'creditNote' ? 'purple' : 'brand'}>
                      {row.type}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="font-bold text-slate-800">#{row.ref}</span>
                    {row.desc && <div className="text-xs text-slate-500">{row.desc}</div>}
                  </Td>
                  <Td>
                    <span className="num font-bold text-emerald-600">{row.debit > 0 ? formatMoney(row.debit) : '—'}</span>
                  </Td>
                  <Td>
                    <span className="num font-bold text-slate-900">{row.credit > 0 ? formatMoney(row.credit) : '—'}</span>
                  </Td>
                  <Td>
                    <span className={`num font-bold ${row.runningAP > 0 ? 'text-amber-600' : 'text-slate-700'}`}>
                      {formatMoney(row.runningAP)}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      {row.kind === 'invoice' && !row.cancelled && row.rawObj.remainingAmount > 0 && (
                        <button
                          type="button"
                          onClick={() => onAddPayment(row.rawObj)}
                          className="rounded px-2 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-50"
                        >
                          سداد
                        </button>
                      )}
                      {row.kind === 'invoice' && !row.cancelled && row.rawObj.paidAmount === 0 && (
                        <button
                          type="button"
                          onClick={() => cancelInvoice(row.rawObj)}
                          className="rounded px-2 py-1 text-xs font-bold text-red-600 hover:bg-red-50"
                        >
                          إلغاء
                        </button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>

      {vendorAdvances.length > 0 && (
        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-bold text-blue-900">سجل الدفعات المقدمة للمورد (حساب 115 - أصول متداولة)</h4>
            <Button size="xs" onClick={() => onAddAdvance(vendor.id)}>+ دفعة مقدمة جديد</Button>
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                <Th>المرجع</Th>
                <Th>إجمالي الدفعة</Th>
                <Th>المتبقي المتاح للتسوية</Th>
                <Th>الحالة</Th>
                <Th className="w-px">الإجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {vendorAdvances.map((adv) => (
                <tr key={adv.id}>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(adv.advanceDate, locale)}</Td>
                  <Td className="font-bold text-slate-800">{adv.reference || adv.id.slice(0,6)}</Td>
                  <Td className="num font-bold text-slate-900">{formatMoney(adv.amount)}</Td>
                  <Td className="num font-bold text-blue-700">{formatMoney(adv.remainingAmount)}</Td>
                  <Td>
                    <Badge tone={adv.reversed ? 'red' : adv.remainingAmount <= 0 ? 'green' : 'blue'}>
                      {adv.reversed ? 'ملغاة / مستردة' : adv.remainingAmount <= 0 ? 'مستوفاة بالكامل' : 'نشطة'}
                    </Badge>
                  </Td>
                  <Td>
                    {!adv.reversed && adv.remainingAmount > 0 && (
                      <button
                        type="button"
                        onClick={() => onApplyAdvance(adv)}
                        className="rounded px-2.5 py-1 text-xs font-bold text-blue-700 hover:bg-blue-100"
                      >
                        تسوية بالفاتورة
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}

      {legacyCosts.length > 0 && (
        <div className="mt-8 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-bold text-slate-700">التكاليف التشغيلية السابقة (Legacy Costs)</h4>
            <span className="text-xs font-semibold text-slate-500">سجلات إدارية قديمة</span>
          </div>
          <p className="mb-3 text-xs text-slate-500">
            ملاحظة: هذه السجلات القديمة لا ينشأ عنها قيود محاسبية تلقائية ولا تدخل ضمن رصيد ذمم الموردين المحاسبي (حساب 211).
          </p>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('common.date')}</Th>
                <Th>{t('vendors.work')}</Th>
                <Th>{t('common.amount')}</Th>
                <Th>{t('common.status')}</Th>
              </tr>
            </thead>
            <tbody>
              {legacyCosts.map((cost) => (
                <tr key={cost.id}>
                  <Td className="whitespace-nowrap text-slate-500">{formatDate(cost.date, locale)}</Td>
                  <Td className="text-slate-600">{cost.description || vendorTypeLabel(cost.type, t)}</Td>
                  <Td className="num text-slate-700">{formatMoney(cost.amount)}</Td>
                  <Td>
                    <Badge tone={cost.paid ? 'green' : 'amber'}>
                      {cost.paid ? t('vendors.settled') : t('vendors.unpaid')}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}
    </Modal>
  )
}

function PurchaseReturnModal({ open, initialInvoice, purchaseInvoices, busy, onClose }) {
  const [invoiceId, setInvoiceId] = useState('')
  const [returnDate, setReturnDate] = useState(todayISO())
  const [subtotal, setSubtotal] = useState('')
  const [taxAmount, setTaxAmount] = useState('0')
  const [reason, setReason] = useState('')
  const [errorMsg, setErrorMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  const selectedInvoice = useMemo(() => {
    return purchaseInvoices.find((i) => i.id === invoiceId)
  }, [purchaseInvoices, invoiceId])

  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== (initialInvoice?.id || 'new')) {
    setLastKey(initialInvoice?.id || 'new')
    const inv = initialInvoice?.id ? initialInvoice : purchaseInvoices[0]
    setInvoiceId(inv?.id || '')
    setReturnDate(todayISO())
    setSubtotal('')
    setTaxAmount('0')
    setReason('')
    setErrorMsg(null)
  }

  const subNum = toNumber(subtotal)
  const taxNum = toNumber(taxAmount)
  const totalNum = round2(subNum + taxNum)

  async function submit() {
    if (!invoiceId || subNum <= 0) {
      setErrorMsg('يرجى اختيار الفاتورة وتحديد مبلغ المردود الصافي')
      return
    }

    setSaving(true)
    setErrorMsg(null)
    try {
      await createPurchaseReturnClientSide({
        payload: {
          vendorId: selectedInvoice?.vendorId,
          purchaseInvoiceId: invoiceId,
          number: `PR-${Date.now().toString().slice(-6)}`,
          date: returnDate,
          subtotal: subNum,
          taxAmount: taxNum,
          total: round2(subNum + taxNum),
          notes: reason,
        },
      })
      onClose()
    } catch (err) {
      setErrorMsg(err.message || 'فشل تسجيل مردود المشتريات')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="إثبات مردود مشتريات (Purchase Return)"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={saving || busy}>
            {saving ? 'جاري الترحيل...' : 'إثبات وترحيل المردود'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorMsg && (
          <div className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">
            {errorMsg}
          </div>
        )}

        <Field label="فاتورة الشراء الأصلية">
          <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            {purchaseInvoices.filter((i) => !i.cancelled).map((i) => (
              <option key={i.id} value={i.id}>
                #{i.number || i.invoiceNumber || i.id.slice(0, 6)} - إجمالي: {formatMoney(i.total)} (صافي المردود المتاح: {formatMoney(i.total - (i.returnedAmount || 0))})
              </option>
            ))}
          </Select>
        </Field>

        <Field label="تاريخ المردود">
          <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="الصافي المرتجع">
            <Input numeric value={subtotal} onChange={(e) => setSubtotal(e.target.value)} placeholder="0" />
          </Field>
          <Field label="ضريبة المردود">
            <Input numeric value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field label="إجمالي المردود">
            <div className="flex h-10 items-center rounded-xl bg-slate-100 px-3 font-bold text-slate-900 num">
              {formatMoney(totalNum)}
            </div>
          </Field>
        </div>

        <Field label="سبب المردود">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="سبب إرجاع البضاعة أو الخدمة..." />
        </Field>
      </div>
    </Modal>
  )
}

function SupplierCreditNoteModal({ open, initialVendorId, vendors, purchaseInvoices, busy, onClose }) {
  const [vendorId, setVendorId] = useState('')
  const [purchaseInvoiceId, setPurchaseInvoiceId] = useState('')
  const [creditNoteDate, setCreditNoteDate] = useState(todayISO())
  const [subtotal, setSubtotal] = useState('')
  const [taxAmount, setTaxAmount] = useState('0')
  const [reason, setReason] = useState('')
  const [errorMsg, setErrorMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== (initialVendorId || 'new')) {
    setLastKey(initialVendorId || 'new')
    setVendorId(initialVendorId || vendors[0]?.id || '')
    setPurchaseInvoiceId('')
    setCreditNoteDate(todayISO())
    setSubtotal('')
    setTaxAmount('0')
    setReason('')
    setErrorMsg(null)
  }

  const vendorInvoices = useMemo(() => {
    return purchaseInvoices.filter((i) => i.vendorId === vendorId && !i.cancelled)
  }, [purchaseInvoices, vendorId])

  const subNum = toNumber(subtotal)
  const taxNum = toNumber(taxAmount)
  const totalNum = round2(subNum + taxNum)

  async function submit() {
    if (!vendorId || subNum <= 0) {
      setErrorMsg('يرجى اختيار المورد وتحديد مبلغ الإشعار الصافي')
      return
    }

    setSaving(true)
    setErrorMsg(null)
    try {
      await createSupplierCreditNoteClientSide({
        payload: {
          vendorId,
          purchaseInvoiceId: purchaseInvoiceId || undefined,
          date: creditNoteDate,
          subtotal: subNum,
          taxAmount: taxNum,
          total: round2(subNum + taxNum),
          notes: reason,
        },
      })
      onClose()
    } catch (err) {
      setErrorMsg(err.message || 'فشل إنشاء الإشعار الدائن للمورد')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="إصدار إشعار دائن للمورد (Supplier Credit Note)"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={saving || busy}>
            {saving ? 'جاري الترحيل...' : 'إصدار وترحيل الإشعار'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorMsg && (
          <div className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">
            {errorMsg}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="المورد">
            <SearchableSelect
              options={vendors}
              value={vendorId}
              placeholder="اختر المورد..."
              searchPlaceholder="ابحث باسم المورد أو الهاتف..."
              onChange={(val) => setVendorId(val)}
            />
          </Field>

          <Field label="ربط بفاتورة شراء (اختياري)">
            <Select value={purchaseInvoiceId} onChange={(e) => setPurchaseInvoiceId(e.target.value)}>
              <option value="">-- غير مربوط بفاتورة محدودة --</option>
              {vendorInvoices.map((i) => (
                <option key={i.id} value={i.id}>
                  #{i.number || i.invoiceNumber || i.id.slice(0, 6)} - إجمالي: {formatMoney(i.total)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="تاريخ الإشعار الدائن">
          <Input type="date" value={creditNoteDate} onChange={(e) => setCreditNoteDate(e.target.value)} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="الصافي (Subtotal)">
            <Input numeric value={subtotal} onChange={(e) => setSubtotal(e.target.value)} placeholder="0" />
          </Field>
          <Field label="الضريبة المخصومة (VAT)">
            <Input numeric value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field label="إجمالي الإشعار (Total)">
            <div className="flex h-10 items-center rounded-xl bg-slate-100 px-3 font-bold text-slate-900 num">
              {formatMoney(totalNum)}
            </div>
          </Field>
        </div>

        <Field label="سبب الإشعار الدائن">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="تسوية فروق أسعار، خصم مكتسب،..." />
        </Field>
      </div>
    </Modal>
  )
}

function VendorAdvanceModal({ open, initialVendorId, vendors, paymentMethods, busy, onClose }) {
  const [vendorId, setVendorId] = useState('')
  const [amount, setAmount] = useState('')
  const [methodId, setMethodId] = useState('')
  const [advanceDate, setAdvanceDate] = useState(todayISO())
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [errorMsg, setErrorMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== (initialVendorId || 'new')) {
    setLastKey(initialVendorId || 'new')
    setVendorId(initialVendorId || vendors[0]?.id || '')
    setAmount('')
    setMethodId(paymentMethods[0]?.id || '')
    setAdvanceDate(todayISO())
    setReference('')
    setNotes('')
    setErrorMsg(null)
  }

  async function submit() {
    const amtNum = toNumber(amount)
    if (!vendorId || !methodId || amtNum <= 0) {
      setErrorMsg('يرجى اختيار المورد وطريقة الدفع وتحديد مبلغ الدفعة المقدمة')
      return
    }

    setSaving(true)
    setErrorMsg(null)
    try {
      await createVendorAdvanceClientSide({
        payload: {
          vendorId,
          amount: amtNum,
          methodId,
          date: advanceDate,
          notes: `${reference ? `مرجع: ${reference} | ` : ''}${notes || ''}`,
        },
      })
      onClose()
    } catch (err) {
      setErrorMsg(err.message || 'فشل إثبات الدفعة المقدمة للمورد')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="إثبات دفعة مقدمة للمورد (Vendor Advance - أصل متداول)"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={saving || busy}>
            {saving ? 'جاري الترحيل...' : 'إثبات وترحيل الدفعة المقدمة'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorMsg && (
          <div className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">
            {errorMsg}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="المورد">
            <SearchableSelect
              options={vendors}
              value={vendorId}
              placeholder="اختر المورد..."
              searchPlaceholder="ابحث باسم المورد أو الهاتف..."
              onChange={(val) => setVendorId(val)}
            />
          </Field>

          <Field label="طريقة الدفع / الخزينة (من حساب الخزينة/البنك)">
            <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
              {paymentMethods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="مبلغ الدفعة المقدمة">
            <Input numeric value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5000" />
          </Field>

          <Field label="تاريخ الدفعة">
            <Input type="date" value={advanceDate} onChange={(e) => setAdvanceDate(e.target.value)} />
          </Field>
        </div>

        <Field label="رقم المرجع / التحويل">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="رقم إيصال التحويل، الشيك،..." />
        </Field>

        <Field label="ملاحظات">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="سبب دفعة مقدمة قبل استلام الفاتورة..." />
        </Field>
      </div>
    </Modal>
  )
}

function ApplyVendorAdvanceModal({ open, advance, purchaseInvoices, busy, onClose }) {
  const [invoiceId, setInvoiceId] = useState('')
  const [amount, setAmount] = useState('')
  const [applyDate, setApplyDate] = useState(todayISO())
  const [errorMsg, setErrorMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  const vendorInvoices = useMemo(() => {
    if (!advance) return []
    return purchaseInvoices.filter((i) => i.vendorId === advance.vendorId && !i.cancelled && i.remainingAmount > 0)
  }, [purchaseInvoices, advance])

  const selectedInvoice = useMemo(() => {
    return vendorInvoices.find((i) => i.id === invoiceId)
  }, [vendorInvoices, invoiceId])

  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== advance?.id) {
    setLastKey(advance?.id)
    const inv = vendorInvoices[0]
    setInvoiceId(inv?.id || '')
    const maxPossible = Math.min(advance?.remainingAmount || 0, inv?.remainingAmount || 0)
    setAmount(maxPossible > 0 ? String(maxPossible) : '')
    setApplyDate(todayISO())
    setErrorMsg(null)
  }

  async function submit() {
    const appNum = toNumber(amount)
    if (!advance || !invoiceId || appNum <= 0) {
      setErrorMsg('يرجى اختيار الفاتورة وتحديد مبلغ التسوية')
      return
    }

    setSaving(true)
    setErrorMsg(null)
    try {
      await applyVendorAdvanceClientSide({
        payload: {
          advanceId: advance.id,
          purchaseInvoiceId: invoiceId,
          amount: appNum,
          applyDate,
        },
      })
      onClose()
    } catch (err) {
      setErrorMsg(err.message || 'فشل تسوية الدفعة المقدمة مع فاتورة الشراء')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="تسوية دفعة مقدمة مع فاتورة شراء (Apply Advance)"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={saving || busy}>
            {saving ? 'جاري الترحيل...' : 'إثبات وتسوية الدفعة'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorMsg && (
          <div className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">
            {errorMsg}
          </div>
        )}

        <div className="rounded-xl bg-slate-50 p-3 text-xs space-y-1">
          <div>المبلغ المتبقي بالدفعة المقدمة (حساب 115): <span className="font-bold num text-brand-700">{formatMoney(advance?.remainingAmount)}</span></div>
          {selectedInvoice && (
            <div>المتبقي المستحق بالفاتورة (حساب 211): <span className="font-bold num text-amber-700">{formatMoney(selectedInvoice.remainingAmount)}</span></div>
          )}
        </div>

        <Field label="اختر فاتورة الشراء المستحقة">
          <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            {vendorInvoices.map((i) => (
              <option key={i.id} value={i.id}>
                #{i.number || i.invoiceNumber || i.id.slice(0, 6)} - المتبقي: {formatMoney(i.remainingAmount)} EGP
              </option>
            ))}
          </Select>
        </Field>

        <Field label="مبلغ التسوية والتخصيص">
          <Input numeric value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </Field>

        <Field label="تاريخ التسوية">
          <Input type="date" value={applyDate} onChange={(e) => setApplyDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

