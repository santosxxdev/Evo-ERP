import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { COL, createDoc, deleteDocById, updateDocById, useCollection, useSettings } from '../lib/db'
import {
  ASSETS_COL,
  ASSET_CATEGORY_DEFAULTS,
  ASSET_KINDS,
  ASSET_LOCATION_DEFAULTS,
  ASSET_STATUSES,
  ASSET_USAGE_COL,
  DEP_METHODS,
  MAINTENANCE_COL,
  assetTotals,
  assetCategoryLabel,
  depreciation,
  dueMaintenance,
} from '../lib/assets'
import { ACCOUNTS_COL, accountLabel } from '../lib/accounts'
import { taxLabelOf } from '../lib/invoice'
import ManagedSelect from '../components/ManagedSelect'
import SearchableSelect from '../components/SearchableSelect'
import { formatDate, formatMoney, todayISO, toNumber } from '../lib/format'
import { VENDORS_COL } from './Vendors'
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
import { IconServices, IconExpenses, IconTrendUp } from '../components/Icons'

const STATUS_TONES = { active: 'green', repair: 'amber', sold: 'slate', retired: 'red' }

export default function Assets() {
  const { t, locale } = useI18n()
  const today = todayISO()

  const { settings } = useSettings()
  const { rows: assets, loading } = useCollection(ASSETS_COL, 'name', 'asc')
  const { rows: maintenance } = useCollection(MAINTENANCE_COL, 'date', 'desc')
  const { rows: usage } = useCollection(ASSET_USAGE_COL, 'date', 'desc')
  const { rows: employees } = useCollection(COL.employees, 'name', 'asc')
  const { rows: vendors } = useCollection(VENDORS_COL, 'name', 'asc')
  const { rows: accounts } = useCollection(ACCOUNTS_COL, 'code', 'asc')

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [usageViewing, setUsageViewing] = useState(null)
  const [busy, setBusy] = useState(false)

  const totals = useMemo(
    () => assetTotals(assets, maintenance, today, usage),
    [assets, maintenance, today, usage],
  )
  const overdue = useMemo(() => dueMaintenance(maintenance, today), [maintenance, today])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return assets
    return assets.filter((asset) =>
      [asset.name, asset.serial, asset.category].some((value) =>
        String(value ?? '').toLowerCase().includes(needle),
      ),
    )
  }, [assets, query])

  async function save(values) {
    setBusy(true)
    if (editing?.id) await updateDocById(ASSETS_COL, editing.id, values)
    else await createDoc(ASSETS_COL, values)
    setBusy(false)
    setEditing(null)
  }

  async function remove() {
    setBusy(true)
    await deleteDocById(ASSETS_COL, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('assets.title')} subtitle={t('assets.subtitle')}>
        <Button onClick={() => setEditing({})}>+ {t('assets.add')}</Button>
      </PageHeader>

      {assets.length > 0 && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('assets.count')} value={totals.count} Icon={IconServices} />
          <StatCard
            label={t('assets.totalCost')}
            value={formatMoney(totals.cost)}
            suffix={t('common.currency')}
            Icon={IconExpenses}
          />
          <StatCard
            label={t('assets.accumulated')}
            value={formatMoney(totals.accumulated)}
            suffix={t('common.currency')}
            tone="text-rose-600 bg-rose-50"
            Icon={IconExpenses}
          />
          <StatCard
            label={t('assets.bookValue')}
            value={formatMoney(totals.bookValue)}
            suffix={t('common.currency')}
            tone="text-emerald-600 bg-emerald-50"
            Icon={IconTrendUp}
          />
        </div>
      )}

      {overdue.length > 0 && (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-bold text-amber-900">{t('assets.dueTitle', { count: overdue.length })}</p>
          <ul className="mt-2 space-y-1">
            {overdue.slice(0, 5).map((row) => (
              <li key={row.id} className="text-xs font-semibold text-amber-800">
                {row.assetName} — {row.description || t('assets.maintenance')} ·{' '}
                <span className="num">{formatDate(row.nextDueDate, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {assets.length === 0 ? (
        <EmptyState
          title={t('assets.empty')}
          message={t('assets.emptyHint')}
          action={<Button onClick={() => setEditing({})}>+ {t('assets.add')}</Button>}
        />
      ) : (
        <>
          <div className="mb-4">
            <SearchInput value={query} onChange={setQuery} placeholder={t('assets.search')} />
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('assets.name')}</Th>
                <Th>{t('common.category')}</Th>
                <Th>{t('assets.kind')}</Th>
                <Th>{t('assets.depMethod')}</Th>
                <Th>{t('assets.purchaseDate')}</Th>
                <Th>{t('assets.purchaseCost')}</Th>
                <Th>{t('assets.accumulated')}</Th>
                <Th>{t('assets.bookValue')}</Th>
                <Th>{t('common.status')}</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((asset) => {
                const plan = depreciation(asset, today, usage)
                const kind = asset.kind ?? 'depreciable'
                const method = kind === 'land' ? 'none' : asset.depMethod ?? 'straight'
                return (
                  <tr key={asset.id}>
                    <Td>
                      <span className="font-semibold text-slate-800">{asset.name}</span>
                      {asset.serial && <p className="num text-xs text-slate-400">{asset.serial}</p>}
                    </Td>
                    <Td>
                      <Badge tone="brand">{assetCategoryLabel(asset.category, t)}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={kind === 'land' ? 'amber' : kind === 'fixed' ? 'sky' : 'slate'}>
                        {t(`assets.kind.${kind}`)}
                      </Badge>
                    </Td>
                    <Td className="text-xs text-slate-500">{t(`assets.depMethod.${method}`)}</Td>
                    <Td className="whitespace-nowrap text-slate-600">{formatDate(asset.purchaseDate, locale)}</Td>
                    <Td>
                      <span className="num text-slate-700">{formatMoney(asset.purchaseCost)}</span>
                    </Td>
                    <Td>
                      <span className="num text-rose-600">{formatMoney(plan.accumulated)}</span>
                    </Td>
                    <Td>
                      <span className="num font-bold text-emerald-600">{formatMoney(plan.bookValue)}</span>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONES[asset.status] ?? 'slate'}>
                        {t(`assets.status.${asset.status ?? 'active'}`)}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setViewing(asset)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                        >
                          {t('assets.maintenance')}
                        </button>
                        {method === 'units' && (
                          <button
                            type="button"
                            onClick={() => setUsageViewing(asset)}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50"
                          >
                            {t('assets.usageLog')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditing(asset)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoving(asset)}
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

      <AssetForm
        open={Boolean(editing)}
        row={editing}
        employees={employees}
        accounts={accounts}
        settings={settings}
        usage={usage}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={save}
      />

      <MaintenanceLog
        open={Boolean(viewing)}
        asset={viewing}
        rows={maintenance.filter((row) => row.assetId === viewing?.id)}
        vendors={vendors}
        locale={locale}
        onClose={() => setViewing(null)}
      />

      <UsageLog
        open={Boolean(usageViewing)}
        asset={usageViewing}
        rows={usage.filter((row) => row.assetId === usageViewing?.id)}
        locale={locale}
        onClose={() => setUsageViewing(null)}
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

const emptyComponent = () => ({ name: '', serial: '', cost: '' })

function AssetForm({ open, row, employees, accounts = [], settings = {}, usage = [], busy, onClose, onSave }) {
  const { t, lang } = useI18n()
  const [form, setForm] = useState({})
  const [components, setComponents] = useState([])
  const [touched, setTouched] = useState(false)

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      name: row?.name ?? '',
      category: row?.category ?? '',
      serial: row?.serial ?? '',
      kind: row?.kind ?? 'depreciable',
      location: row?.location ?? '',
      quantity: row?.quantity ?? 1,
      purchaseDate: row?.purchaseDate ?? todayISO(),
      purchaseCost: row?.purchaseCost ?? '',
      usefulLifeMonths: row?.usefulLifeMonths ?? 36,
      salvageValue: row?.salvageValue ?? '',
      depMethod: row?.depMethod ?? 'straight',
      decliningRate: row?.decliningRate ?? '',
      totalUnits: row?.totalUnits ?? '',
      status: row?.status ?? 'active',
      acquisition: row?.acquisition ?? 'cash',
      acquisitionAccountId: row?.acquisitionAccountId ?? '',
      assetAccountId: row?.assetAccountId ?? '',
      taxKind: row?.taxKind ?? 'none',
      accumDepAccountId: row?.accumDepAccountId ?? '',
      depExpenseAccountId: row?.depExpenseAccountId ?? '',
      assignedTo: row?.assignedTo ?? '',
      notes: row?.notes ?? '',
    })
    setComponents(row?.components?.length ? row.components.map((c) => ({ ...c })) : [])
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const invalid = !form.name?.trim() || toNumber(form.purchaseCost) <= 0

  const postable = accounts.filter((account) => !account.isGroup)
  const kind = form.kind ?? 'depreciable'
  const method = kind === 'land' ? 'none' : form.depMethod ?? 'straight'
  const depreciable = kind === 'depreciable' && method !== 'none'

  const preview = depreciation(
    {
      id: row?.id ?? '__preview__',
      kind,
      depMethod: method,
      purchaseCost: form.purchaseCost,
      salvageValue: form.salvageValue,
      usefulLifeMonths: form.usefulLifeMonths,
      decliningRate: form.decliningRate,
      totalUnits: form.totalUnits,
      purchaseDate: form.purchaseDate,
    },
    todayISO(),
    usage,
  )

  function setComponent(index, patch) {
    setComponents((current) => current.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  function submit() {
    setTouched(true)
    if (invalid) return
    const cleanComponents = components
      .map((c) => ({ name: c.name?.trim() ?? '', serial: c.serial?.trim() ?? '', cost: toNumber(c.cost) }))
      .filter((c) => c.name || c.cost)
    onSave({
      name: form.name.trim(),
      category: form.category,
      serial: form.serial?.trim() ?? '',
      kind,
      location: form.location ?? '',
      quantity: Math.max(1, Math.round(toNumber(form.quantity) || 1)),
      purchaseDate: form.purchaseDate,
      purchaseCost: toNumber(form.purchaseCost),
      usefulLifeMonths: Math.round(toNumber(form.usefulLifeMonths)),
      salvageValue: toNumber(form.salvageValue),
      depMethod: method,
      decliningRate: toNumber(form.decliningRate),
      totalUnits: Math.round(toNumber(form.totalUnits)),
      status: form.status,
      acquisition: form.acquisition === 'credit' ? 'credit' : 'cash',
      acquisitionAccountId: form.acquisitionAccountId || null,
      assetAccountId: form.assetAccountId || null,
      taxKind: form.taxKind === 'tax1' || form.taxKind === 'tax2' ? form.taxKind : 'none',
      accumDepAccountId: form.accumDepAccountId || null,
      depExpenseAccountId: form.depExpenseAccountId || null,
      components: cleanComponents,
      assignedTo: form.assignedTo || null,
      notes: form.notes?.trim() ?? '',
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={row?.id ? t('assets.edit') : t('assets.add')}
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
        <Field label={t('assets.name')} error={touched && !form.name?.trim() ? t('common.required') : null}>
          <Input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} />
        </Field>

        <Field label={t('common.category')}>
          <ManagedSelect
            collectionName="assetCategories"
            value={form.category}
            onChange={(next) => set('category', next)}
            defaults={ASSET_CATEGORY_DEFAULTS}
          />
        </Field>

        <Field label={t('assets.kind')} hint={t('assets.kindHint')}>
          <Select value={form.kind ?? 'depreciable'} onChange={(event) => set('kind', event.target.value)}>
            {ASSET_KINDS.map((item) => (
              <option key={item} value={item}>
                {t(`assets.kind.${item}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('assets.location')}>
          <ManagedSelect
            collectionName="assetLocations"
            value={form.location}
            onChange={(next) => set('location', next)}
            defaults={ASSET_LOCATION_DEFAULTS}
          />
        </Field>

        <Field label={t('assets.quantity')}>
          <Input numeric value={form.quantity ?? ''} onChange={(event) => set('quantity', event.target.value)} />
        </Field>

        <Field label={`${t('assets.serial')} (${t('common.optional')})`}>
          <Input dir="ltr" value={form.serial ?? ''} onChange={(event) => set('serial', event.target.value)} />
        </Field>

        <Field label={t('common.status')}>
          <Select value={form.status} onChange={(event) => set('status', event.target.value)}>
            {ASSET_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`assets.status.${status}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('assets.purchaseDate')}>
          <Input
            type="date"
            value={form.purchaseDate ?? ''}
            onChange={(event) => set('purchaseDate', event.target.value)}
          />
        </Field>

        <Field
          label={t('assets.purchaseCost')}
          error={touched && toNumber(form.purchaseCost) <= 0 ? t('common.required') : null}
        >
          <Input
            numeric
            value={form.purchaseCost ?? ''}
            onChange={(event) => set('purchaseCost', event.target.value)}
          />
        </Field>

        <Field label={t('assets.acquisitionAccount')} hint={t('assets.acquisitionAccountHint')}>
          <Select
            value={form.acquisitionAccountId ?? ''}
            onChange={(event) => set('acquisitionAccountId', event.target.value)}
          >
            <option value="">{t('assets.acquisition.cash')}</option>
            {postable.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {accountLabel(account, lang)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('assets.assetAccount')} hint={t('assets.assetAccountHint')}>
          <Select
            value={form.assetAccountId ?? ''}
            onChange={(event) => set('assetAccountId', event.target.value)}
          >
            <option value="">{t('assets.accountDefault')}</option>
            {postable.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {accountLabel(account, lang)}
              </option>
            ))}
          </Select>
        </Field>

        {settings.taxEnabled && (
          <Field label={t('assets.taxKind')}>
            <Select value={form.taxKind ?? 'none'} onChange={(event) => set('taxKind', event.target.value)}>
              <option value="none">{t('invoices.taxKind.none')}</option>
              <option value="tax1">{taxLabelOf(settings, 'tax1')}</option>
              <option value="tax2">{taxLabelOf(settings, 'tax2')}</option>
            </Select>
          </Field>
        )}

        {kind !== 'land' && (
          <Field label={t('assets.depMethod')} hint={t('assets.depMethodHint')}>
            <Select value={form.depMethod ?? 'straight'} onChange={(event) => set('depMethod', event.target.value)}>
              {DEP_METHODS.map((item) => (
                <option key={item} value={item}>
                  {t(`assets.depMethod.${item}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {depreciable && method !== 'units' && (
          <Field label={t('assets.life')} hint={t('assets.lifeHint')}>
            <Input
              numeric
              value={form.usefulLifeMonths ?? ''}
              onChange={(event) => set('usefulLifeMonths', event.target.value)}
            />
          </Field>
        )}

        {depreciable && method === 'declining' && (
          <Field label={t('assets.decliningRate')} hint={t('assets.decliningRateHint')}>
            <Input
              numeric
              value={form.decliningRate ?? ''}
              onChange={(event) => set('decliningRate', event.target.value)}
              placeholder={t('assets.decliningAuto')}
            />
          </Field>
        )}

        {depreciable && method === 'units' && (
          <Field label={t('assets.totalUnits')} hint={t('assets.totalUnitsHint')}>
            <Input
              numeric
              value={form.totalUnits ?? ''}
              onChange={(event) => set('totalUnits', event.target.value)}
            />
          </Field>
        )}

        {depreciable && (
          <Field label={t('assets.salvage')} hint={t('assets.salvageHint')}>
            <Input
              numeric
              value={form.salvageValue ?? ''}
              onChange={(event) => set('salvageValue', event.target.value)}
            />
          </Field>
        )}

        {depreciable && (
          <>
            <Field label={t('assets.depExpenseAccount')}>
              <Select
                value={form.depExpenseAccountId ?? ''}
                onChange={(event) => set('depExpenseAccountId', event.target.value)}
              >
                <option value="">{t('assets.accountDefault')}</option>
                {postable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {accountLabel(account, lang)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('assets.accumDepAccount')}>
              <Select
                value={form.accumDepAccountId ?? ''}
                onChange={(event) => set('accumDepAccountId', event.target.value)}
              >
                <option value="">{t('assets.accountDefault')}</option>
                {postable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {accountLabel(account, lang)}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}

        <Field label={`${t('assets.assignedTo')} (${t('common.optional')})`}>
          <SearchableSelect
            options={employees}
            value={form.assignedTo ?? ''}
            placeholder={t('common.none')}
            searchPlaceholder="ابحث باسم الموظف..."
            onChange={(val) => set('assignedTo', val)}
          />
        </Field>

        <Field label={`${t('common.notes')} (${t('common.optional')})`}>
          <Input value={form.notes ?? ''} onChange={(event) => set('notes', event.target.value)} />
        </Field>
      </div>

      {kind === 'depreciable' && (
        <div className="mt-5 rounded-2xl border border-slate-200 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-bold text-slate-900">{t('assets.components')}</h4>
            <Button variant="soft" onClick={() => setComponents((c) => [...c, emptyComponent()])}>
              + {t('common.add')}
            </Button>
          </div>
          {components.length === 0 ? (
            <p className="text-xs text-slate-400">{t('assets.componentsHint')}</p>
          ) : (
            <div className="space-y-2">
              {components.map((component, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_120px_auto]">
                  <Input
                    value={component.name ?? ''}
                    placeholder={t('assets.componentName')}
                    onChange={(event) => setComponent(index, { name: event.target.value })}
                  />
                  <Input
                    dir="ltr"
                    value={component.serial ?? ''}
                    placeholder={t('assets.serial')}
                    onChange={(event) => setComponent(index, { serial: event.target.value })}
                  />
                  <Input
                    numeric
                    value={component.cost ?? ''}
                    placeholder={t('common.price')}
                    onChange={(event) => setComponent(index, { cost: event.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => setComponents((c) => c.filter((_, i) => i !== index))}
                    className="rounded-lg px-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {toNumber(form.purchaseCost) > 0 && depreciable && (
        <div className="mt-5 grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-3">
          <Tile label={t('assets.monthlyDep')} value={preview.monthly} />
          <Tile label={t('assets.accumulated')} value={preview.accumulated} tone="text-rose-600" />
          <Tile label={t('assets.bookValue')} value={preview.bookValue} tone="text-emerald-600" />
        </div>
      )}
    </Modal>
  )
}

/** سجل استهلاك الوحدات — أساس إهلاك «وحدات الإنتاج» */
function UsageLog({ open, asset, rows, locale, onClose }) {
  const { t } = useI18n()
  const [form, setForm] = useState({ date: todayISO(), units: '', note: '' })
  const [busy, setBusy] = useState(false)

  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setForm({ date: todayISO(), units: '', note: '' })
  }
  if (!open && wasOpen) setWasOpen(false)

  if (!asset) return null

  const total = rows.reduce((sum, row) => sum + toNumber(row.units), 0)
  const plan = depreciation(asset, todayISO(), rows)

  async function add() {
    if (toNumber(form.units) <= 0) return
    setBusy(true)
    await createDoc(ASSET_USAGE_COL, {
      assetId: asset.id,
      assetName: asset.name,
      date: form.date,
      units: toNumber(form.units),
      note: form.note?.trim() ?? '',
    })
    setForm({ date: todayISO(), units: '', note: '' })
    setBusy(false)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`${t('assets.usageLog')} — ${asset.name}`}
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Tile label={t('assets.totalUnits')} value={toNumber(asset.totalUnits)} tone="text-slate-900" />
        <Tile label={t('assets.usedUnits')} value={total} tone="text-violet-600" />
        <Tile label={t('assets.accumulated')} value={plan.accumulated} tone="text-rose-600" />
      </div>

      <div className="mb-4 grid gap-2 rounded-2xl bg-slate-50 p-3 sm:grid-cols-[150px_120px_1fr_auto]">
        <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        <Input
          numeric
          placeholder={t('assets.units')}
          value={form.units}
          onChange={(e) => setForm((f) => ({ ...f, units: e.target.value }))}
        />
        <Input
          placeholder={`${t('common.notes')} (${t('common.optional')})`}
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
        />
        <Button onClick={add} disabled={busy}>
          {busy ? t('common.saving') : t('common.add')}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">{t('reports.empty')}</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.date')}</Th>
              <Th>{t('assets.units')}</Th>
              <Th>{t('common.notes')}</Th>
              <Th className="w-px" />
            </tr>
          </thead>
          <tbody>
            {rows
              .slice()
              .sort((a, b) => String(b.date).localeCompare(String(a.date)))
              .map((row) => (
                <tr key={row.id}>
                  <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                  <Td>
                    <span className="num font-bold text-slate-800">{row.units}</span>
                  </Td>
                  <Td className="text-slate-600">{row.note || '—'}</Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => deleteDocById(ASSET_USAGE_COL, row.id)}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      {t('common.delete')}
                    </button>
                  </Td>
                </tr>
              ))}
          </tbody>
        </TableWrap>
      )}
    </Modal>
  )
}

function Tile({ label, value, tone = 'text-slate-900' }) {
  const { t } = useI18n()
  return (
    <div>
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={`num mt-1 text-lg font-extrabold ${tone}`}>
        {formatMoney(value)}
        <span className="ms-1 text-[11px] font-semibold text-slate-400">{t('common.currency')}</span>
      </p>
    </div>
  )
}

function MaintenanceLog({ open, asset, rows, vendors, locale, onClose }) {
  const { t } = useI18n()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!asset) return null

  const total = rows.reduce((sum, row) => sum + toNumber(row.cost), 0)

  async function save(values) {
    setBusy(true)
    await createDoc(MAINTENANCE_COL, { ...values, assetId: asset.id, assetName: asset.name })
    setBusy(false)
    setAdding(false)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`${t('assets.maintenance')} — ${asset.name}`}
      footer={<Button onClick={() => setAdding(true)}>+ {t('assets.addMaintenance')}</Button>}
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Tile label={t('assets.maintenanceTotal')} value={total} tone="text-rose-600" />
        <Tile label={t('assets.bookValue')} value={depreciation(asset, todayISO()).bookValue} tone="text-emerald-600" />
      </div>

      {(asset.location || toNumber(asset.quantity) > 1 || asset.components?.length > 0) && (
        <div className="mb-4 rounded-2xl bg-slate-50 p-3 text-xs text-slate-600">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {asset.location && (
              <span>
                {t('assets.location')}: <b className="text-slate-800">{asset.location}</b>
              </span>
            )}
            {toNumber(asset.quantity) > 1 && (
              <span>
                {t('assets.quantity')}: <b className="num text-slate-800">{asset.quantity}</b>
              </span>
            )}
          </div>
          {asset.components?.length > 0 && (
            <div className="mt-2">
              <span className="font-semibold text-slate-700">{t('assets.components')}:</span>
              <ul className="mt-1 space-y-0.5">
                {asset.components.map((component, index) => (
                  <li key={index}>
                    • {component.name}
                    {component.serial ? ` — ${component.serial}` : ''}
                    {toNumber(component.cost) > 0 ? ` — ${formatMoney(component.cost)}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          {t('assets.noMaintenance')}
        </p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('common.date')}</Th>
              <Th>{t('common.description')}</Th>
              <Th>{t('assets.workshop')}</Th>
              <Th>{t('common.amount')}</Th>
              <Th>{t('assets.nextDue')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date, locale)}</Td>
                <Td className="text-slate-700">{row.description || '—'}</Td>
                <Td className="text-slate-600">
                  {vendors.find((vendor) => vendor.id === row.vendorId)?.name ?? row.workshop ?? '—'}
                </Td>
                <Td>
                  <span className="num font-bold text-rose-600">{formatMoney(row.cost)}</span>
                </Td>
                <Td>
                  {row.nextDueDate ? (
                    <span className="num text-slate-600">{formatDate(row.nextDueDate, locale)}</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <MaintenanceForm
        open={adding}
        vendors={vendors}
        busy={busy}
        onClose={() => setAdding(false)}
        onSave={save}
      />
    </Modal>
  )
}

function MaintenanceForm({ open, vendors, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setForm({ date: todayISO(), description: '', cost: '', vendorId: '', workshop: '', nextDueDate: '' })
    setTouched(false)
  }
  if (!open && wasOpen) setWasOpen(false)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const invalid = toNumber(form.cost) <= 0 || !form.description?.trim()

  function submit() {
    setTouched(true)
    if (invalid) return
    onSave({
      date: form.date,
      description: form.description.trim(),
      cost: toNumber(form.cost),
      vendorId: form.vendorId || null,
      workshop: form.workshop?.trim() ?? '',
      nextDueDate: form.nextDueDate || null,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('assets.addMaintenance')}
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
          label={t('common.description')}
          className="sm:col-span-2"
          error={touched && !form.description?.trim() ? t('common.required') : null}
        >
          <Input value={form.description ?? ''} onChange={(event) => set('description', event.target.value)} />
        </Field>

        <Field label={t('common.date')}>
          <Input type="date" value={form.date ?? ''} onChange={(event) => set('date', event.target.value)} />
        </Field>

        <Field label={t('common.amount')} error={touched && toNumber(form.cost) <= 0 ? t('common.required') : null}>
          <Input numeric value={form.cost ?? ''} onChange={(event) => set('cost', event.target.value)} />
        </Field>

        <Field label={`${t('assets.workshop')} (${t('common.optional')})`}>
          <Input value={form.workshop ?? ''} onChange={(event) => set('workshop', event.target.value)} />
        </Field>

        <Field label={t('assets.nextDue')} hint={t('assets.nextDueHint')}>
          <Input
            type="date"
            value={form.nextDueDate ?? ''}
            onChange={(event) => set('nextDueDate', event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
