import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import {
  COL,
  createDoc,
  deleteDocById,
  nextInvoiceNumber,
  nextNumber,
  recalcClientTotals,
  updateDocById,
  useCollection,
  useSettings,
} from '../lib/db'
import { createInvoiceClientSide } from '../lib/clientInvoices'
import { computeTotals } from '../lib/invoice'
import { expectedCostOfItems, planCommission } from '../lib/costing'
import { JOB_COSTS_COL } from './Vendors'
import { formatDate, formatMoney, todayISO, toNumber } from '../lib/format'
import ItemsEditor, { emptyItem, toStoredItems, validItems } from '../components/ItemsEditor'
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
  TableWrap,
  Td,
  Textarea,
  Th,
} from '../components/ui'
import { IconInvoices, IconTrendUp } from '../components/Icons'

export const QUOTATIONS_COL = 'quotations'
export const RETAINERS_COL = 'retainers'

const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'converted']
const STATUS_TONES = {
  draft: 'slate',
  sent: 'sky',
  accepted: 'green',
  rejected: 'red',
  converted: 'brand',
}

/** شهر التاريخ الحالي بصيغة YYYY-MM */
function currentMonth() {
  return todayISO().slice(0, 7)
}

/** يضيف لقطة التكلفة المعيارية لمسودة فاتورة من بنودها وخدماتها */
function withExpectedCost(invoice, services) {
  const serviceMap = new Map(services.map((service) => [service.id, service]))
  const exp = expectedCostOfItems(invoice.items ?? [], serviceMap)
  return {
    ...invoice,
    expectedCost: exp.total,
    expectedCostDirect: exp.direct,
    expectedCostIndirect: exp.indirect,
    expectedCostBreakdown: exp.lines,
  }
}

/** ينشئ تكلفة عمولة الموظف التلقائية على فاتورة أُنشئت للتو من عرض أو باقة */
async function createCommissionFor(invoiceId, invoice, employees) {
  const employee = employees.find((item) => item.id === invoice.employeeId)
  const plan = planCommission({ invoice: { ...invoice, id: invoiceId }, employee, existing: null })
  if (plan.action === 'create') {
    await createDoc(JOB_COSTS_COL, { ...plan.data, invoiceId, clientId: invoice.clientId })
  }
}

export default function Quotations() {
  const { t } = useI18n()
  const [tab, setTab] = useState('quotes')

  return (
    <div>
      <PageHeader title={t('quotes.title')} subtitle={t('quotes.subtitle')} />

      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {['quotes', 'retainers'].map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
              tab === item
                ? 'bg-brand-600 text-white shadow-sm'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t(`quotes.tab.${item}`)}
          </button>
        ))}
      </div>

      {tab === 'quotes' ? <QuotesTab /> : <RetainersTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  عروض الأسعار                                                       */
/* ------------------------------------------------------------------ */

function QuotesTab() {
  const { t, locale } = useI18n()
  const { settings } = useSettings()

  const { rows: quotes, loading } = useCollection(QUOTATIONS_COL, 'date', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: services } = useCollection(COL.services, 'name', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')

  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const open = quotes.filter((quote) => quote.status === 'sent' || quote.status === 'draft')
  const openValue = open.reduce((sum, quote) => sum + toNumber(quote.total), 0)
  const won = quotes.filter((quote) => quote.status === 'accepted' || quote.status === 'converted')

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return quotes.filter((quote) => {
      if (statusFilter && quote.status !== statusFilter) return false
      if (!term) return true
      return [quote.number, quote.clientName].filter(Boolean).join(' ').toLowerCase().includes(term)
    })
  }, [quotes, search, statusFilter])

  async function save(values) {
    setBusy(true)
    if (editing?.id) {
      await updateDocById(QUOTATIONS_COL, editing.id, values)
    } else {
      const number = await nextNumber('quotations', 'QT')
      await createDoc(QUOTATIONS_COL, { ...values, number, status: 'draft' })
    }
    setBusy(false)
    setEditing(null)
  }

  async function setStatus(quote, status) {
    await updateDocById(QUOTATIONS_COL, quote.id, { status })
  }

  /** تحويل العرض لفاتورة: نفس البنود والأرقام، ويُوسم العرض كمحوَّل */
  async function convert(quote) {
    setBusy(true)
    const number = await nextInvoiceNumber(settings.invoicePrefix)

    const invoice = withExpectedCost({
      number,
      clientId: quote.clientId,
      clientName: quote.clientName,
      employeeId: quote.employeeId ?? null,
      employeeName: quote.employeeName ?? '',
      date: todayISO(),
      items: quote.items ?? [],
      subtotal: quote.subtotal,
      feesTotal: quote.feesTotal,
      adBudgetTotal: quote.adBudgetTotal,
      discount: quote.discount,
      discountMode: quote.discountMode ?? 'amount',
      discountValue: quote.discountValue ?? quote.discount,
      taxEnabled: quote.taxEnabled,
      taxRate: quote.taxRate,
      taxAmount: quote.taxAmount,
      total: quote.total,
      paidAmount: 0,
      nextPaymentDate: null,
      notes: quote.notes ?? '',
      fromQuotation: quote.number,
    }, services)

    const result = await createInvoiceClientSide({ values: invoice, number })
    const createdId = result.invoiceId

    await updateDocById(QUOTATIONS_COL, quote.id, { status: 'converted', invoiceId: createdId })
    await createCommissionFor(createdId, invoice, employees)
    await recalcClientTotals(quote.clientId, [...invoices, { ...invoice, id: createdId }])

    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    await deleteDocById(QUOTATIONS_COL, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  if (loading) return <Loading />

  return (
    <div>
      <div className="mb-5 flex justify-end">
        <Button onClick={() => setEditing({})} disabled={clients.length === 0}>
          + {t('quotes.add')}
        </Button>
      </div>

      {quotes.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-3">
          <StatCard label={t('quotes.openCount')} value={open.length} Icon={IconInvoices} />
          <StatCard
            label={t('quotes.openValue')}
            value={formatMoney(openValue)}
            suffix={t('common.currency')}
            tone="text-amber-600 bg-amber-50"
            Icon={IconInvoices}
          />
          <StatCard
            label={t('quotes.winRate')}
            value={quotes.length > 0 ? `${Math.round((won.length / quotes.length) * 100)}%` : '0%'}
            tone="text-emerald-600 bg-emerald-50"
            Icon={IconTrendUp}
          />
        </div>
      )}

      {quotes.length === 0 ? (
        <EmptyState
          title={t('quotes.empty')}
          message={t('quotes.emptyHint')}
          action={
            <Button onClick={() => setEditing({})} disabled={clients.length === 0}>
              + {t('quotes.add')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <SearchInput value={search} onChange={setSearch} placeholder={t('quotes.search')} />
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="w-auto">
              <option value="">{t('common.all')}</option>
              {QUOTE_STATUSES.map((item) => (
                <option key={item} value={item}>
                  {t(`quotes.status.${item}`)}
                </option>
              ))}
            </Select>
            {(search || statusFilter) && (
              <Button variant="ghost" onClick={() => { setSearch(''); setStatusFilter('') }}>
                {t('common.reset')}
              </Button>
            )}
          </div>

          {filtered.length === 0 ? (
            <p className="card px-4 py-10 text-center text-sm text-slate-400">{t('reports.empty')}</p>
          ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('quotes.number')}</Th>
              <Th>{t('common.client')}</Th>
              <Th>{t('common.date')}</Th>
              <Th>{t('quotes.validUntil')}</Th>
              <Th>{t('invoices.total')}</Th>
              <Th>{t('common.status')}</Th>
              <Th className="w-px">{t('common.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((quote) => {
              const expired = quote.validUntil && quote.validUntil < todayISO() && quote.status === 'sent'
              return (
                <tr key={quote.id}>
                  <Td>
                    <span className="num font-bold text-slate-800">{quote.number}</span>
                  </Td>
                  <Td className="text-slate-700">{quote.clientName}</Td>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(quote.date, locale)}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="text-slate-600">{formatDate(quote.validUntil, locale)}</span>
                    {expired && (
                      <span className="ms-1.5">
                        <Badge tone="red">{t('quotes.expired')}</Badge>
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="num font-bold text-slate-800">{formatMoney(quote.total)}</span>
                  </Td>
                  <Td>
                    <StatusSelect
                      value={quote.status}
                      onChange={(value) => setStatus(quote, value)}
                      disabled={quote.status === 'converted'}
                    />
                  </Td>
                  <Td>
                    <div className="flex gap-1.5">
                      {quote.status !== 'converted' && (
                        <button
                          type="button"
                          onClick={() => convert(quote)}
                          disabled={busy}
                          className="rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs font-bold text-brand-700 hover:bg-brand-100 disabled:opacity-50"
                        >
                          {t('quotes.convert')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditing(quote)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemoving(quote)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
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
          )}
        </>
      )}

      <QuoteForm
        open={Boolean(editing)}
        row={editing}
        clients={clients}
        employees={employees}
        services={services}
        settings={settings}
        busy={busy}
        onClose={() => setEditing(null)}
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

function QuoteForm({ open, row, clients, employees, services, settings, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [items, setItems] = useState([emptyItem()])
  const [touched, setTouched] = useState(false)

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      clientId: row?.clientId ?? '',
      employeeId: row?.employeeId ?? '',
      date: row?.date || todayISO(),
      validUntil: row?.validUntil ?? '',
      discount: row?.discount ?? '',
      notes: row?.notes ?? '',
    })
    setItems(row?.items?.length ? row.items.map((item) => ({ ...item })) : [emptyItem()])
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  const taxEnabled = Boolean(settings.taxEnabled)
  const taxRate = toNumber(settings.taxRate)
  const totals = computeTotals({ items, discount: form.discount, taxRate, taxEnabled })
  const ready = validItems(items)

  function submit() {
    setTouched(true)
    if (!form.clientId || ready.length === 0) return

    const client = clients.find((item) => item.id === form.clientId)
    const employee = employees.find((item) => item.id === form.employeeId)

    onSave({
      clientId: form.clientId,
      clientName: client?.name ?? '',
      employeeId: form.employeeId || null,
      employeeName: employee?.name ?? '',
      date: form.date,
      validUntil: form.validUntil || null,
      items: toStoredItems(items),
      subtotal: totals.subtotal,
      feesTotal: totals.feesTotal,
      adBudgetTotal: totals.adBudgetTotal,
      discount: totals.discount,
      taxEnabled,
      taxRate,
      taxAmount: totals.taxAmount,
      total: totals.total,
      notes: form.notes?.trim() ?? '',
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={row?.id ? t('quotes.edit') : t('quotes.add')}
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
        <Field
          label={t('common.client')}
          error={touched && !form.clientId ? t('invoices.needClient') : null}
        >
          <SearchableSelect
            options={clients}
            value={form.clientId ?? ''}
            placeholder={t('common.client')}
            searchPlaceholder="ابحث باسم العميل أو الهاتف..."
            onChange={(val) => set('clientId', val)}
          />
        </Field>

        <Field label={t('common.employee')}>
          <SearchableSelect
            options={employees}
            value={form.employeeId ?? ''}
            placeholder={t('common.none')}
            searchPlaceholder="ابحث باسم الموظف..."
            onChange={(val) => set('employeeId', val)}
          />
        </Field>

        <Field label={t('common.date')}>
          <Input type="date" value={form.date ?? ''} onChange={(event) => set('date', event.target.value)} />
        </Field>

        <Field label={t('quotes.validUntil')} hint={t('quotes.validHint')}>
          <Input
            type="date"
            value={form.validUntil ?? ''}
            onChange={(event) => set('validUntil', event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-5">
        <ItemsEditor
          items={items}
          setItems={setItems}
          services={services}
          error={touched && ready.length === 0 ? t('invoices.needItems') : null}
        />
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label={t('invoices.discount')}>
          <Input numeric value={form.discount ?? ''} onChange={(event) => set('discount', event.target.value)} />
        </Field>

        <div className="rounded-2xl bg-slate-50 p-4">
          <Row label={t('invoices.subtotal')} value={totals.subtotal} />
          <Row label={t('invoices.discount')} value={-totals.discount} />
          {taxEnabled && <Row label={`${t('invoices.tax')} ${taxRate}%`} value={totals.taxAmount} />}
          <div className="mt-2 border-t border-slate-200 pt-2">
            <Row label={t('invoices.total')} value={totals.total} strong />
          </div>
        </div>
      </div>

      <Field label={`${t('common.notes')} (${t('common.optional')})`} className="mt-4">
        <Textarea value={form.notes ?? ''} onChange={(event) => set('notes', event.target.value)} />
      </Field>
    </Modal>
  )
}

function Row({ label, value, strong }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center justify-between py-1">
      <span className={`text-sm ${strong ? 'font-bold text-slate-900' : 'text-slate-500'}`}>{label}</span>
      <span className={`num text-sm ${strong ? 'font-extrabold text-slate-900' : 'font-semibold text-slate-700'}`}>
        {formatMoney(value)}
        <span className="ms-1 text-[11px] font-semibold text-slate-400">{t('common.currency')}</span>
      </span>
    </div>
  )
}

const STATUS_TONE_CLASSES = {
  slate: 'bg-slate-100 text-slate-600',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  brand: 'bg-brand-50 text-brand-700',
  sky: 'bg-sky-50 text-sky-700',
}

/**
 * قائمة حالة العرض بلون شارة يطابق باقي شاشات النظام، بدل قائمة رمادية
 * عادية لا تفرّق بصريًا بين الحالات ولا توضّح متى تكون مقفولة.
 * مكوّن ثابت في نطاق الملف حتى لا يعاد بناؤه مع كل إعادة رسم.
 */
function StatusSelect({ value, onChange, disabled }) {
  const { t } = useI18n()
  const tone = STATUS_TONE_CLASSES[STATUS_TONES[value]] ?? STATUS_TONE_CLASSES.slate

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={`rounded-full border-0 py-1.5 ps-3 pe-7 text-xs font-bold outline-none transition
                  focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-70 ${tone}`}
    >
      {QUOTE_STATUSES.map((status) => (
        <option key={status} value={status}>
          {t(`quotes.status.${status}`)}
        </option>
      ))}
    </select>
  )
}

/* ------------------------------------------------------------------ */
/*  الباقات الشهرية                                                    */
/* ------------------------------------------------------------------ */

function RetainersTab() {
  const { t, locale } = useI18n()
  const { settings } = useSettings()

  const { rows: retainers, loading } = useCollection(RETAINERS_COL, 'name', 'asc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: services } = useCollection(COL.services, 'name', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')

  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')

  const month = currentMonth()

  const filteredRetainers = useMemo(() => {
    if (!statusFilter) return retainers
    const wantActive = statusFilter === 'running'
    return retainers.filter((retainer) => (retainer.active !== false) === wantActive)
  }, [retainers, statusFilter])

  /* باقة مستحقة = فعّالة، بدأت، ولم تُفوتر لهذا الشهر بعد */
  const due = useMemo(
    () =>
      retainers.filter(
        (retainer) =>
          retainer.active !== false &&
          (!retainer.startDate || retainer.startDate.slice(0, 7) <= month) &&
          (!retainer.endDate || retainer.endDate.slice(0, 7) >= month) &&
          retainer.lastGeneratedMonth !== month,
      ),
    [retainers, month],
  )

  const monthlyValue = retainers
    .filter((retainer) => retainer.active !== false)
    .reduce((sum, retainer) => sum + toNumber(retainer.total), 0)

  async function save(values) {
    setBusy(true)
    if (editing?.id) await updateDocById(RETAINERS_COL, editing.id, values)
    else await createDoc(RETAINERS_COL, { ...values, lastGeneratedMonth: null })
    setBusy(false)
    setEditing(null)
  }

  /** يولّد فاتورة لكل باقة مستحقة هذا الشهر، ويمنع التكرار بوسم الشهر */
  async function generateAll() {
    setBusy(true)
    const created = []

    for (const retainer of due) {
      const number = await nextInvoiceNumber(settings.invoicePrefix)
      const day = String(Math.min(28, Math.max(1, toNumber(retainer.dayOfMonth) || 1))).padStart(2, '0')

      const invoice = withExpectedCost({
        number,
        clientId: retainer.clientId,
        clientName: retainer.clientName,
        employeeId: retainer.employeeId ?? null,
        employeeName: retainer.employeeName ?? '',
        date: `${month}-${day}`,
        items: retainer.items ?? [],
        subtotal: retainer.subtotal,
        feesTotal: retainer.feesTotal,
        adBudgetTotal: retainer.adBudgetTotal,
        discount: retainer.discount,
        discountMode: retainer.discountMode ?? 'amount',
        discountValue: retainer.discountValue ?? retainer.discount,
        taxEnabled: retainer.taxEnabled,
        taxRate: retainer.taxRate,
        taxAmount: retainer.taxAmount,
        total: retainer.total,
        paidAmount: 0,
        nextPaymentDate: null,
        notes: `${t('quotes.fromRetainer')}: ${retainer.name}`,
        retainerId: retainer.id,
      }, services)

      const result = await createInvoiceClientSide({ values: invoice, number })
      const docId = result.invoiceId
      await updateDocById(RETAINERS_COL, retainer.id, { lastGeneratedMonth: month })
      await createCommissionFor(docId, invoice, employees)
      created.push({ ...invoice, id: docId })
      await recalcClientTotals(retainer.clientId, [...invoices, { ...invoice, id: docId }])
    }

    /* إعادة حساب أرصدة العملاء المتأثرين مرة واحدة */
    const merged = [...invoices, ...created]
    for (const clientId of new Set(created.map((invoice) => invoice.clientId))) {
      await recalcClientTotals(clientId, merged)
    }

    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    await deleteDocById(RETAINERS_COL, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  if (loading) return <Loading />

  return (
    <div>
      <div className="mb-5 flex justify-end">
        <Button onClick={() => setEditing({})} disabled={clients.length === 0}>
          + {t('quotes.addRetainer')}
        </Button>
      </div>

      {retainers.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <StatCard
            label={t('quotes.monthlyValue')}
            value={formatMoney(monthlyValue)}
            suffix={t('common.currency')}
            tone="text-emerald-600 bg-emerald-50"
            Icon={IconTrendUp}
          />
          <StatCard label={t('quotes.activeCount')} value={retainers.filter((r) => r.active !== false).length} Icon={IconInvoices} />
        </div>
      )}

      {due.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div>
            <p className="text-sm font-bold text-amber-900">{t('quotes.dueTitle', { count: due.length })}</p>
            <p className="mt-1 text-xs text-amber-800">{t('quotes.dueHint')}</p>
          </div>
          <Button onClick={generateAll} disabled={busy}>
            {busy ? t('common.saving') : t('quotes.generate')}
          </Button>
        </div>
      )}

      {retainers.length === 0 ? (
        <EmptyState
          title={t('quotes.noRetainers')}
          message={t('quotes.noRetainersHint')}
          action={
            <Button onClick={() => setEditing({})} disabled={clients.length === 0}>
              + {t('quotes.addRetainer')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="w-auto">
              <option value="">{t('common.all')}</option>
              <option value="running">{t('quotes.running')}</option>
              <option value="paused">{t('quotes.paused')}</option>
            </Select>
            {statusFilter && (
              <Button variant="ghost" onClick={() => setStatusFilter('')}>
                {t('common.reset')}
              </Button>
            )}
          </div>

          {filteredRetainers.length === 0 ? (
            <p className="card px-4 py-10 text-center text-sm text-slate-400">{t('reports.empty')}</p>
          ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('quotes.retainerName')}</Th>
              <Th>{t('common.client')}</Th>
              <Th>{t('quotes.monthlyAmount')}</Th>
              <Th>{t('quotes.billingDay')}</Th>
              <Th>{t('quotes.lastBilled')}</Th>
              <Th>{t('common.status')}</Th>
              <Th className="w-px">{t('common.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRetainers.map((retainer) => (
              <tr key={retainer.id}>
                <Td className="font-semibold text-slate-800">{retainer.name}</Td>
                <Td className="text-slate-700">{retainer.clientName}</Td>
                <Td>
                  <span className="num font-bold text-slate-800">{formatMoney(retainer.total)}</span>
                </Td>
                <Td>
                  <span className="num text-slate-600">{retainer.dayOfMonth}</span>
                </Td>
                <Td>
                  <span className="num text-slate-600">{retainer.lastGeneratedMonth ?? '—'}</span>
                </Td>
                <Td>
                  <Badge tone={retainer.active === false ? 'slate' : 'green'}>
                    {t(retainer.active === false ? 'quotes.paused' : 'quotes.running')}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => updateDocById(RETAINERS_COL, retainer.id, { active: retainer.active === false })}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      {t(retainer.active === false ? 'quotes.resume' : 'quotes.pause')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(retainer)}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemoving(retainer)}
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
        </>
      )}

      <RetainerForm
        open={Boolean(editing)}
        row={editing}
        clients={clients}
        employees={employees}
        services={services}
        settings={settings}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={save}
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

function RetainerForm({ open, row, clients, employees, services, settings, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [items, setItems] = useState([emptyItem()])
  const [touched, setTouched] = useState(false)

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      name: row?.name ?? '',
      clientId: row?.clientId ?? '',
      employeeId: row?.employeeId ?? '',
      startDate: row?.startDate ?? todayISO(),
      endDate: row?.endDate ?? '',
      dayOfMonth: row?.dayOfMonth ?? 1,
      discount: row?.discount ?? '',
      active: row?.active !== false,
    })
    setItems(row?.items?.length ? row.items.map((item) => ({ ...item })) : [emptyItem()])
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  const taxEnabled = Boolean(settings.taxEnabled)
  const taxRate = toNumber(settings.taxRate)
  const totals = computeTotals({ items, discount: form.discount, taxRate, taxEnabled })
  const ready = validItems(items)
  const invalid = !form.name?.trim() || !form.clientId || ready.length === 0

  function submit() {
    setTouched(true)
    if (invalid) return

    const client = clients.find((item) => item.id === form.clientId)
    const employee = employees.find((item) => item.id === form.employeeId)

    onSave({
      name: form.name.trim(),
      clientId: form.clientId,
      clientName: client?.name ?? '',
      employeeId: form.employeeId || null,
      employeeName: employee?.name ?? '',
      startDate: form.startDate,
      endDate: form.endDate || null,
      dayOfMonth: Math.min(28, Math.max(1, Math.round(toNumber(form.dayOfMonth)) || 1)),
      items: toStoredItems(items),
      subtotal: totals.subtotal,
      feesTotal: totals.feesTotal,
      adBudgetTotal: totals.adBudgetTotal,
      discount: totals.discount,
      taxEnabled,
      taxRate,
      taxAmount: totals.taxAmount,
      total: totals.total,
      active: Boolean(form.active),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={row?.id ? t('quotes.editRetainer') : t('quotes.addRetainer')}
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
        {t('quotes.retainerHint')}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('quotes.retainerName')}
          error={touched && !form.name?.trim() ? t('common.required') : null}
        >
          <Input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} />
        </Field>

        <Field label={t('common.client')} error={touched && !form.clientId ? t('invoices.needClient') : null}>
          <SearchableSelect
            options={clients}
            value={form.clientId ?? ''}
            placeholder={t('common.client')}
            searchPlaceholder="ابحث باسم العميل أو الهاتف..."
            onChange={(val) => set('clientId', val)}
          />
        </Field>

        <Field label={t('common.employee')}>
          <SearchableSelect
            options={employees}
            value={form.employeeId ?? ''}
            placeholder={t('common.none')}
            searchPlaceholder="ابحث باسم الموظف..."
            onChange={(val) => set('employeeId', val)}
          />
        </Field>

        <Field label={t('quotes.billingDay')} hint={t('quotes.billingDayHint')}>
          <Input numeric value={form.dayOfMonth ?? ''} onChange={(event) => set('dayOfMonth', event.target.value)} />
        </Field>

        <Field label={t('quotes.startDate')}>
          <Input type="date" value={form.startDate ?? ''} onChange={(event) => set('startDate', event.target.value)} />
        </Field>

        <Field label={`${t('quotes.endDate')} (${t('common.optional')})`} hint={t('quotes.endHint')}>
          <Input type="date" value={form.endDate ?? ''} onChange={(event) => set('endDate', event.target.value)} />
        </Field>
      </div>

      <div className="mt-5">
        <ItemsEditor
          items={items}
          setItems={setItems}
          services={services}
          error={touched && ready.length === 0 ? t('invoices.needItems') : null}
        />
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label={t('invoices.discount')}>
          <Input numeric value={form.discount ?? ''} onChange={(event) => set('discount', event.target.value)} />
        </Field>

        <div className="rounded-2xl bg-slate-50 p-4">
          <Row label={t('invoices.subtotal')} value={totals.subtotal} />
          <Row label={t('invoices.discount')} value={-totals.discount} />
          {taxEnabled && <Row label={`${t('invoices.tax')} ${taxRate}%`} value={totals.taxAmount} />}
          <div className="mt-2 border-t border-slate-200 pt-2">
            <Row label={t('quotes.monthlyAmount')} value={totals.total} strong />
          </div>
        </div>
      </div>

      <label className="mt-4 flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
        <input
          type="checkbox"
          checked={Boolean(form.active)}
          onChange={(event) => set('active', event.target.checked)}
          className="h-4 w-4 accent-brand-600"
        />
        <span className="text-sm font-semibold text-slate-700">{t('quotes.activeLabel')}</span>
      </label>
    </Modal>
  )
}
