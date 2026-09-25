import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import {
  COL,
  createDoc,
  deleteDocById,
  nextInvoiceNumber,
  recalcClientTotals,
  updateDocById,
  useCollection,
  useLookup,
  useSettings,
} from '../lib/db'
import { computeTotals, isClientFunded, taxLabelOf } from '../lib/invoice'
import { expectedCostOfItems, planCommission } from '../lib/costing'
import { JOB_COSTS_COL } from './Vendors'
import { useAuth } from '../context/AuthContext'
import { createInvoiceClientSide, editInvoiceClientSide } from '../lib/clientInvoices'
import { canSeeMoneyInternals } from '../lib/roles'
import {
  CAMPAIGNS_COL,
  campaignBreakdown,
  campaignDailyRate,
  campaignDaysProgress,
  campaignEndDate,
  campaignFee,
  campaignInvoiceItems,
  campaignSpend,
  campaignStatus,
} from '../lib/campaigns'
import { formatDate, formatMoney, round2, todayISO, toNumber } from '../lib/format'
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
import ItemsEditor, { emptyItem, toStoredItems } from '../components/ItemsEditor'
import SearchableSelect from '../components/SearchableSelect'

const STATUS_TONES = { planned: 'sky', running: 'green', ended: 'slate', cancelled: 'red' }

export default function Campaigns() {
  const { t, locale } = useI18n()
  const { settings } = useSettings()
  const { user, role } = useAuth()
  const finance = canSeeMoneyInternals(role)

  const { rows: campaigns, loading } = useCollection(CAMPAIGNS_COL, 'startDate', 'desc')
  const { rows: clients } = useCollection(COL.clients, 'name', 'asc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: services } = useCollection(COL.services, 'name', 'asc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: expenses } = useCollection(COL.expenses, 'date', 'desc', finance)
  const { rows: expenseCategories } = useCollection(COL.expenseCategories, 'name', 'asc')

  const categoryMap = useLookup(expenseCategories)
  const clientFunded = (expense) => isClientFunded(expense, categoryMap)
  const adServiceId = services.find((s) => s.isAdBudget)?.id ?? null

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return campaigns
    return campaigns.filter((c) =>
      [c.name, c.clientName].filter(Boolean).join(' ').toLowerCase().includes(term),
    )
  }, [campaigns, search])

  const running = campaigns.filter((c) => campaignStatus(c) === 'running')
  const totalBudget = running.reduce((sum, c) => sum + toNumber(c.budget), 0)
  const totalFee = campaigns.reduce((sum, c) => sum + campaignFee(c), 0)

  async function save(values) {
    setBusy(true)
    try {
      if (editing?.id) {
        await updateDocById(CAMPAIGNS_COL, editing.id, values)

        /* إذا كانت الحملة مرتبطة بفاتورة سابقة غير ملغاة، نحدث الفاتورة تلقائياً بالتعديلات الجديدة */
        if (editing.invoiceId) {
          const linkedInvoice = invoices.find((inv) => inv.id === editing.invoiceId && !inv.cancelled)
          if (linkedInvoice) {
            const updatedCampaign = { ...editing, ...values }
            const items = campaignInvoiceItems(updatedCampaign, adServiceId)
            const campaignTaxKind = updatedCampaign.taxKind ?? (settings.taxEnabled ? 'tax1' : 'none')
            const isTaxActive = Boolean(settings.taxEnabled && campaignTaxKind !== 'none')
            const taxRate = isTaxActive ? toNumber(settings.taxRate1 ?? settings.taxRate) : 0
            const totals = computeTotals({ items, discount: 0, taxRate, taxEnabled: isTaxActive })
            const client = clients.find((c) => c.id === updatedCampaign.clientId)
            const effectiveEmployeeId = updatedCampaign.employeeId || client?.employeeId || null
            const employee = employees.find((e) => e.id === effectiveEmployeeId)
            const exp = expectedCostOfItems(items, new Map(services.map((s) => [s.id, s])))

            const updatedInvoiceValues = {
              clientId: updatedCampaign.clientId,
              clientName: client?.name ?? updatedCampaign.clientName ?? '',
              employeeId: effectiveEmployeeId,
              employeeName: employee?.name ?? '',
              date: updatedCampaign.startDate || todayISO(),
              items,
              subtotal: totals.subtotal,
              feesTotal: totals.feesTotal,
              adBudgetTotal: totals.adBudgetTotal,
              taxKind: campaignTaxKind,
              taxEnabled: isTaxActive,
              taxRate: isTaxActive ? taxRate : 0,
              taxAmount: totals.taxAmount,
              total: totals.total,
              notes: `${t('campaigns.fromCampaign')}: ${updatedCampaign.name}`,
              expectedCost: exp.total,
              expectedCostDirect: exp.direct,
              expectedCostIndirect: exp.indirect,
              expectedCostBreakdown: exp.lines,
            }

            await editInvoiceClientSide({
              invoiceId: editing.invoiceId,
              values: updatedInvoiceValues,
              uid: user?.uid,
            })

            const existing = jobCosts.find((cost) => cost.invoiceId === editing.invoiceId && cost.auto === AUTO_COMMISSION)
            const plan = planCommission({ invoice: { ...updatedInvoiceValues, id: editing.invoiceId }, employee, existing, monthInvoices: invoices })
            if (plan.action === 'create') {
              await createDoc(JOB_COSTS_COL, { ...plan.data, invoiceId: editing.invoiceId, clientId: updatedCampaign.clientId })
            } else if (plan.action === 'update') {
              await updateDocById(JOB_COSTS_COL, plan.id, plan.data)
            } else if (plan.action === 'delete') {
              await deleteDocById(JOB_COSTS_COL, plan.id)
            }

            await recalcClientTotals(updatedCampaign.clientId, invoices)
          }
        }
      } else {
        await createDoc(CAMPAIGNS_COL, { ...values, invoiceId: null })
      }
    } catch (err) {
      console.error(err)
      alert(`حدث خطأ أثناء حفظ تعديلات الحملة:\n\n${err?.message || 'خطأ غير معروف'}`)
    } finally {
      setBusy(false)
      setEditing(null)
    }
  }

  async function remove() {
    setBusy(true)
    await deleteDocById(CAMPAIGNS_COL, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  /** فاتورة الحملة: بند عهدة إعلانات + بند أتعاب إدارة (بضريبة حسب الإعداد) */
  async function makeInvoice(campaign) {
    setBusy(true)
    const items = campaignInvoiceItems(campaign, adServiceId)
    const campaignTaxKind = campaign.taxKind ?? (settings.taxEnabled ? 'tax1' : 'none')
    const isTaxActive = Boolean(settings.taxEnabled && campaignTaxKind !== 'none')
    const taxRate = isTaxActive ? toNumber(settings.taxRate1 ?? settings.taxRate) : 0
    const totals = computeTotals({ items, discount: 0, taxRate, taxEnabled: isTaxActive })
    const number = await nextInvoiceNumber(settings.invoicePrefix)
    const client = clients.find((c) => c.id === campaign.clientId)
    const effectiveEmployeeId = campaign.employeeId || client?.employeeId || null
    const employee = employees.find((e) => e.id === effectiveEmployeeId)
    const exp = expectedCostOfItems(items, new Map(services.map((s) => [s.id, s])))

    const invoice = {
      number,
      clientId: campaign.clientId,
      clientName: campaign.clientName,
      employeeId: effectiveEmployeeId,
      employeeName: campaign.employeeName || employee?.name || '',
      date: campaign.startDate || todayISO(),
      items,
      subtotal: totals.subtotal,
      feesTotal: totals.feesTotal,
      adBudgetTotal: totals.adBudgetTotal,
      discount: 0,
      taxKind: campaignTaxKind,
      taxEnabled: isTaxActive,
      taxRate: isTaxActive ? taxRate : 0,
      taxAmount: totals.taxAmount,
      total: totals.total,
      paidAmount: 0,
      nextPaymentDate: null,
      notes: `${t('campaigns.fromCampaign')}: ${campaign.name}`,
      cancelled: false,
      campaignId: campaign.id,
      expectedCost: exp.total,
      expectedCostDirect: exp.direct,
      expectedCostIndirect: exp.indirect,
      expectedCostBreakdown: exp.lines,
    }

    const res = await createInvoiceClientSide({ values: invoice, number: invoice.number, payment: null, uid: user?.uid })
    const createdId = res.invoiceId
    
    await updateDocById(CAMPAIGNS_COL, campaign.id, { invoiceId: createdId })

    const plan = planCommission({ invoice: { ...invoice, id: createdId }, employee, existing: null, monthInvoices: invoices })
    if (plan.action === 'create') {
      await createDoc(JOB_COSTS_COL, { ...plan.data, invoiceId: createdId, clientId: campaign.clientId })
    }
    await recalcClientTotals(campaign.clientId, [...invoices, { ...invoice, id: createdId }])

    setBusy(false)
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('campaigns.title')} subtitle={t('campaigns.subtitle')}>
        <Button onClick={() => setEditing({})} disabled={clients.length === 0}>
          + {t('campaigns.add')}
        </Button>
      </PageHeader>

      {campaigns.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-3">
          <StatCard label={t('campaigns.runningCount')} value={running.length} Icon={IconInvoices} />
          <StatCard
            label={t('campaigns.runningBudget')}
            value={formatMoney(totalBudget)}
            suffix={t('common.currency')}
            tone="text-amber-600 bg-amber-50"
            Icon={IconInvoices}
          />
          <StatCard
            label={t('campaigns.totalFee')}
            value={formatMoney(totalFee)}
            suffix={t('common.currency')}
            tone="text-emerald-600 bg-emerald-50"
            Icon={IconTrendUp}
          />
        </div>
      )}

      {campaigns.length === 0 ? (
        <EmptyState
          title={t('campaigns.empty')}
          message={t('campaigns.emptyHint')}
          action={
            <Button onClick={() => setEditing({})} disabled={clients.length === 0}>
              + {t('campaigns.add')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4">
            <SearchInput value={search} onChange={setSearch} placeholder={t('campaigns.search')} />
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('campaigns.name')}</Th>
                <Th>{t('common.client')}</Th>
                <Th>{t('campaigns.budget')}</Th>
                <Th>{t('campaigns.fee')}</Th>
                <Th>{t('campaigns.dailyRate')}</Th>
                <Th>{t('common.status')}</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const state = campaignStatus(c)
                const b = campaignBreakdown(c)
                const linkedInvoice = c.invoiceId ? invoices.find((inv) => inv.id === c.invoiceId && !inv.cancelled) : null

                return (
                  <tr key={c.id}>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setViewing(c)}
                        className="text-start font-semibold text-slate-800 hover:text-brand-600"
                      >
                        {c.name}
                      </button>
                      <p className="text-xs text-slate-400">
                        {formatDate(c.startDate, locale)} · {c.days} {t('campaigns.days')}
                      </p>
                    </Td>
                    <Td className="text-slate-700">{c.clientName}</Td>
                    <Td>
                      <span className="num font-bold text-slate-800">{formatMoney(c.budget)}</span>
                    </Td>
                    <Td>
                      <span className="num font-semibold text-emerald-600">{formatMoney(b.fee)}</span>
                      <span className="ms-1 text-[11px] text-slate-400">
                        {c.feeMode === 'percent' ? `${toNumber(c.feePct)}%` : t('campaigns.fixed')}
                        {' · '}
                        {c.feeFrom === 'onTop' ? t('campaigns.onTopShort') : t('campaigns.fromBudgetShort')}
                      </span>
                    </Td>
                    <Td>
                      <span className="num text-slate-600">{formatMoney(campaignDailyRate(c))}</span>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONES[state]}>{t(`campaigns.status.${state}`)}</Badge>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {!linkedInvoice ? (
                          <button
                            type="button"
                            onClick={() => makeInvoice(c)}
                            disabled={busy}
                            className="rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs font-bold text-brand-700 hover:bg-brand-100 disabled:opacity-50"
                          >
                            {t('campaigns.makeInvoice')}
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-bold text-emerald-700">
                            <span>فاتورة: {linkedInvoice.number}</span>
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditing(c)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoving(c)}
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
        </>
      )}

      <CampaignForm
        open={Boolean(editing)}
        row={editing}
        clients={clients}
        employees={employees}
        settings={settings}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={save}
      />

      <CampaignDetail
        open={Boolean(viewing)}
        campaign={viewing}
        expenses={expenses}
        invoices={invoices}
        clientFunded={clientFunded}
        settings={settings}
        locale={locale}
        onClose={() => setViewing(null)}
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

/* ------------------------------------------------------------------ */

function CampaignForm({ open, row, clients, employees, settings, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      name: row?.name ?? '',
      clientId: row?.clientId ?? '',
      employeeId: row?.employeeId ?? '',
      budget: row?.budget ?? '',
      feeMode: row?.feeMode ?? 'percent',
      feePct: row?.feePct ?? 15,
      feeFixed: row?.feeFixed ?? '',
      feeFrom: row?.feeFrom ?? 'fromBudget',
      taxKind: row?.taxKind ?? (settings.taxEnabled ? 'tax1' : 'none'),
      startDate: row?.startDate ?? todayISO(),
      days: row?.days ?? 30,
      status: row?.status ?? 'planned',
      notes: row?.notes ?? '',
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const invalid = !form.name?.trim() || !form.clientId || toNumber(form.budget) <= 0

  const preview = campaignBreakdown({
    budget: form.budget,
    feeMode: form.feeMode,
    feePct: form.feePct,
    feeFixed: form.feeFixed,
    feeFrom: form.feeFrom,
  })
  const isTaxActive = Boolean(settings.taxEnabled && (form.taxKind ?? (settings.taxEnabled ? 'tax1' : 'none')) !== 'none')
  const feeTax = isTaxActive ? round2(preview.fee * toNumber(settings.taxRate1 ?? settings.taxRate) / 100) : 0
  const dailyRate = campaignDailyRate({ ...form })

  function submit() {
    setTouched(true)
    if (invalid) return
    const client = clients.find((c) => c.id === form.clientId)
    const employee = employees.find((e) => e.id === form.employeeId)
    onSave({
      name: form.name.trim(),
      clientId: form.clientId,
      clientName: client?.name ?? '',
      employeeId: form.employeeId || null,
      employeeName: employee?.name ?? '',
      budget: toNumber(form.budget),
      feeMode: form.feeMode === 'fixed' ? 'fixed' : 'percent',
      feePct: toNumber(form.feePct),
      feeFixed: toNumber(form.feeFixed),
      feeFrom: form.feeFrom === 'onTop' ? 'onTop' : 'fromBudget',
      taxKind: form.taxKind ?? (settings.taxEnabled ? 'tax1' : 'none'),
      startDate: form.startDate,
      days: Math.max(1, Math.round(toNumber(form.days))),
      endDate: campaignEndDate(form.startDate, form.days),
      status: form.status,
      notes: form.notes?.trim() ?? '',
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={row?.id ? t('campaigns.edit') : t('campaigns.add')}
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
        <Field label={t('campaigns.name')} error={touched && !form.name?.trim() ? t('common.required') : null}>
          <Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
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

        <Field label={t('campaigns.budget')} error={touched && toNumber(form.budget) <= 0 ? t('common.required') : null}>
          <Input numeric value={form.budget ?? ''} onChange={(e) => set('budget', e.target.value)} />
        </Field>

        <Field label={t('campaigns.feeMode')}>
          <Select value={form.feeMode} onChange={(e) => set('feeMode', e.target.value)}>
            <option value="percent">{t('campaigns.feeMode.percent')}</option>
            <option value="fixed">{t('campaigns.feeMode.fixed')}</option>
          </Select>
        </Field>

        {form.feeMode === 'fixed' ? (
          <Field label={t('campaigns.feeFixed')}>
            <Input numeric value={form.feeFixed ?? ''} onChange={(e) => set('feeFixed', e.target.value)} />
          </Field>
        ) : (
          <Field label={t('campaigns.feePct')}>
            <Input numeric value={form.feePct ?? ''} onChange={(e) => set('feePct', e.target.value)} />
          </Field>
        )}

        <Field label={t('campaigns.feeFrom')} hint={t('campaigns.feeFromHint')}>
          <Select value={form.feeFrom} onChange={(e) => set('feeFrom', e.target.value)}>
            <option value="fromBudget">{t('campaigns.feeFrom.fromBudget')}</option>
            <option value="onTop">{t('campaigns.feeFrom.onTop')}</option>
          </Select>
        </Field>

        {settings.taxEnabled && (
          <Field label={t('invoices.taxKind')}>
            <Select
              value={form.taxKind ?? (settings.taxEnabled ? 'tax1' : 'none')}
              onChange={(e) => set('taxKind', e.target.value)}
            >
              <option value="tax1">
                {taxLabelOf(settings, 'tax1')} ({toNumber(settings.taxRate1 ?? settings.taxRate)}%)
              </option>
              <option value="none">{t('invoices.taxKind.none')}</option>
            </Select>
          </Field>
        )}

        <Field label={t('campaigns.startDate')}>
          <Input type="date" value={form.startDate ?? ''} onChange={(e) => set('startDate', e.target.value)} />
        </Field>

        <Field label={t('campaigns.days')}>
          <Input numeric value={form.days ?? ''} onChange={(e) => set('days', e.target.value)} />
        </Field>

        <Field label={`${t('common.notes')} (${t('common.optional')})`} className="sm:col-span-2">
          <Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>

      <div className="mt-5 grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-4">
        <Tile label={t('campaigns.toPlatforms')} value={preview.toPlatforms} />
        <Tile label={t('campaigns.fee')} value={preview.fee} tone="text-emerald-600" />
        <Tile label={t('campaigns.dailyRate')} value={dailyRate} />
        <Tile
          label={t('campaigns.clientPays')}
          value={preview.clientPaysExTax + feeTax}
          tone="text-slate-900"
          strong
        />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        {form.feeFrom === 'onTop' ? t('campaigns.onTopNote') : t('campaigns.fromBudgetNote')}
        {feeTax > 0 && ` — ${t('campaigns.feeTaxNote', { amount: formatMoney(feeTax) })}`}
      </p>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */

function CampaignDetail({ open, campaign, expenses, invoices, clientFunded, settings, locale, onClose }) {
  const { t } = useI18n()
  if (!campaign) return null

  const b = campaignBreakdown(campaign)
  const spent = campaignSpend(campaign, expenses, clientFunded)
  const remaining = round2(b.toPlatforms - spent)
  const progress = campaignDaysProgress(campaign)
  const daily = campaignDailyRate(campaign)
  const actualDaily = progress.elapsed > 0 ? round2(spent / progress.elapsed) : 0
  const invoice = invoices.find((i) => i.id === campaign.invoiceId && !i.cancelled)
  const end = campaignEndDate(campaign.startDate, campaign.days)
  const pacePct = b.toPlatforms > 0 ? Math.min(100, Math.round((spent / b.toPlatforms) * 100)) : 0

  return (
    <Modal open={open} onClose={onClose} wide title={campaign.name}>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
        <Badge tone={STATUS_TONES[campaignStatus(campaign)]}>{t(`campaigns.status.${campaignStatus(campaign)}`)}</Badge>
        <span>{campaign.clientName}</span>
        <span>·</span>
        <span className="num">{formatDate(campaign.startDate, locale)} ← {formatDate(end, locale)}</span>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Tile label={t('campaigns.budget')} value={b.budget} />
        <Tile label={t('campaigns.fee')} value={b.fee} tone="text-emerald-600" />
        <Tile label={t('campaigns.toPlatforms')} value={b.toPlatforms} />
        <Tile label={t('campaigns.clientPays')} value={b.clientPaysExTax} strong />
      </div>

      <div className="mb-5 rounded-2xl border border-slate-200 p-4">
        <div className="mb-2 flex items-center justify-between text-sm font-bold text-slate-900">
          <span>{t('campaigns.spendTracking')}</span>
          <span className="num text-xs font-semibold text-slate-500">
            {progress.elapsed}/{progress.total} {t('campaigns.days')} · {progress.left} {t('campaigns.daysLeft')}
          </span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full ${pacePct >= 95 ? 'bg-rose-500' : 'bg-brand-500'}`}
            style={{ width: `${pacePct}%` }}
          />
        </div>
        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-4">
          <span>{t('campaigns.plannedDaily')}: <b className="num">{formatMoney(daily)}</b></span>
          <span>{t('campaigns.actualDaily')}: <b className="num">{formatMoney(actualDaily)}</b></span>
          <span>{t('campaigns.spent')}: <b className="num text-rose-600">{formatMoney(spent)}</b></span>
          <span>{t('campaigns.remaining')}: <b className={`num ${remaining < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatMoney(remaining)}</b></span>
        </div>
      </div>

      {invoice ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          {t('campaigns.invoiced', { number: invoice.number, total: formatMoney(invoice.total) })}
        </p>
      ) : (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700">
          {t('campaigns.notInvoiced')}
        </p>
      )}

      {campaign.notes && <p className="mt-3 text-sm text-slate-600">{campaign.notes}</p>}
    </Modal>
  )
}

function Tile({ label, value, tone = 'text-slate-900', strong = false }) {
  const { t } = useI18n()
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-semibold text-slate-500">{label}</p>
      <p className={`num mt-0.5 ${strong ? 'text-base font-extrabold' : 'text-sm font-bold'} ${tone}`}>
        {formatMoney(value)}
        <span className="ms-1 text-[10px] font-semibold text-slate-400">{t('common.currency')}</span>
      </p>
    </div>
  )
}
