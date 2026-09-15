import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { COL, createDoc, deleteDocById, updateDocById, useCollection, useLookup } from '../lib/db'
import { formatMoney, toNumber } from '../lib/format'
import { DIRECT_COST_KEYS, INDIRECT_COST_KEYS, lineMargin, serviceCostBreakdown } from '../lib/costing'
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

export default function Services() {
  const { t } = useI18n()
  const { rows, loading } = useCollection(COL.services, 'name', 'asc')
  const { rows: categories } = useCollection(COL.serviceCategories, 'name', 'asc')
  const categoryMap = useLookup(categories)

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return rows
    return rows.filter((row) =>
      [row.name, row.description, row.unit].filter(Boolean).join(' ').toLowerCase().includes(term),
    )
  }, [rows, search])

  async function handleSave(values) {
    setBusy(true)
    if (editing?.id) await updateDocById(COL.services, editing.id, values)
    else await createDoc(COL.services, values)
    setBusy(false)
    setEditing(null)
  }

  async function handleDelete() {
    setBusy(true)
    await deleteDocById(COL.services, removing.id)
    setBusy(false)
    setRemoving(null)
  }

  if (loading) return <Loading />

  return (
    <div>
      <PageHeader title={t('services.title')} subtitle={t('services.subtitle')}>
        <Button onClick={() => setEditing({})}>+ {t('services.add')}</Button>
      </PageHeader>

      {rows.length === 0 ? (
        <EmptyState
          title={t('services.empty')}
          message={t('services.emptyHint')}
          action={<Button onClick={() => setEditing({})}>+ {t('services.add')}</Button>}
        />
      ) : (
        <>
          <div className="mb-4">
            <SearchInput value={search} onChange={setSearch} placeholder={t('common.search')} />
          </div>

          <TableWrap>
            <thead>
              <tr>
                <Th>{t('services.name')}</Th>
                <Th>{t('services.category')}</Th>
                <Th>{t('common.unit')}</Th>
                <Th>{t('services.price')}</Th>
                <Th>{t('services.fullCost')}</Th>
                <Th>{t('services.margin')}</Th>
                <Th>{t('common.description')}</Th>
                <Th className="w-px">{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  <Td>
                    <span className="font-semibold text-slate-800">{row.name}</span>
                    {row.isAdBudget && (
                      <span className="ms-2">
                        <Badge tone="amber">{t('services.adBudget')}</Badge>
                      </span>
                    )}
                  </Td>
                  <Td>
                    {row.categoryId && categoryMap.get(row.categoryId) ? (
                      <Badge tone="brand">{categoryMap.get(row.categoryId).name}</Badge>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </Td>
                  <Td className="text-slate-600">{row.unit || '—'}</Td>
                  <Td>
                    <span className="num font-bold text-slate-800">{formatMoney(row.price)}</span>
                    <span className="ms-1 text-xs text-slate-400">{t('common.currency')}</span>
                  </Td>
                  {(() => {
                    const b = serviceCostBreakdown(row)
                    const m = lineMargin(row.price, b.fullCost)
                    return (
                      <>
                        <Td>
                          {b.hasCosting ? (
                            <span className="num font-semibold text-rose-600">{formatMoney(b.fullCost)}</span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </Td>
                        <Td>
                          {b.hasCosting && toNumber(row.price) > 0 ? (
                            <Badge tone={m.margin >= 40 ? 'green' : m.margin >= 15 ? 'amber' : 'red'}>
                              {m.margin}%
                            </Badge>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </Td>
                      </>
                    )
                  })()}
                  <Td className="max-w-xs truncate text-slate-500">{row.description || '—'}</Td>
                  <Td>
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
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}

      <ServiceForm
        open={Boolean(editing)}
        row={editing}
        categories={categories}
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
        message={t('common.deleteMsg', { name: removing?.name ?? '' })}
      />
    </div>
  )
}

function ServiceForm({ open, row, categories, busy, onClose, onSave }) {
  const { t } = useI18n()
  const [form, setForm] = useState({})
  const [touched, setTouched] = useState(false)

  const key = row?.id ?? 'new'
  const [lastKey, setLastKey] = useState(null)
  if (open && lastKey !== key) {
    setLastKey(key)
    setForm({
      name: row?.name ?? '',
      price: row?.price ?? '',
      unit: row?.unit ?? '',
      categoryId: row?.categoryId ?? '',
      description: row?.description ?? '',
      isAdBudget: Boolean(row?.isAdBudget),
      direct: row?.costing?.direct?.length
        ? row.costing.direct.map((line) => ({ ...line }))
        : [],
      indirect: row?.costing?.indirect?.length
        ? row.costing.indirect.map((line) => ({ ...line }))
        : [],
      markupPct: row?.costing?.markupPct ?? '',
    })
    setTouched(false)
  }
  if (!open && lastKey !== null) setLastKey(null)

  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  function setLines(field, updater) {
    setForm((current) => ({ ...current, [field]: updater(current[field] ?? []) }))
  }

  const costing = {
    direct: form.direct ?? [],
    indirect: form.indirect ?? [],
    markupPct: form.markupPct,
  }
  const breakdown = serviceCostBreakdown({ costing })
  const margin = lineMargin(form.price, breakdown.fullCost)

  function submit() {
    setTouched(true)
    if (!form.name?.trim()) return
    onSave({
      name: form.name.trim(),
      price: toNumber(form.price),
      unit: form.unit?.trim() ?? '',
      categoryId: form.categoryId || null,
      description: form.description?.trim() ?? '',
      isAdBudget: Boolean(form.isAdBudget),
      costing: {
        direct: (form.direct ?? [])
          .filter((line) => line.label?.trim() || toNumber(line.amount) !== 0)
          .map((line) => ({ key: line.key ?? 'other', label: line.label?.trim() ?? '', amount: toNumber(line.amount) })),
        indirect: (form.indirect ?? [])
          .filter((line) => line.label?.trim() || toNumber(line.amount) !== 0)
          .map((line) => ({ key: line.key ?? 'other', label: line.label?.trim() ?? '', amount: toNumber(line.amount) })),
        markupPct: toNumber(form.markupPct),
      },
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={row?.id ? t('services.edit') : t('services.add')}
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
        <Field label={t('services.name')} error={touched && !form.name?.trim() ? t('common.required') : null}>
          <Input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('services.price')}>
            <Input numeric value={form.price ?? ''} onChange={(event) => set('price', event.target.value)} />
          </Field>

          <Field label={t('services.unit')} hint={t('services.unitHint')}>
            <Input value={form.unit ?? ''} onChange={(event) => set('unit', event.target.value)} />
          </Field>
        </div>

        <Field label={`${t('services.category')} (${t('common.optional')})`}>
          <Select value={form.categoryId ?? ''} onChange={(event) => set('categoryId', event.target.value)}>
            <option value="">{t('common.none')}</option>
            {categories
              .filter((category) => !category.archived)
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
          </Select>
        </Field>

        <Field label={`${t('common.description')} (${t('common.optional')})`}>
          <Textarea value={form.description ?? ''} onChange={(event) => set('description', event.target.value)} />
        </Field>

        <label className="flex items-start gap-3 rounded-xl border border-slate-200 px-4 py-3">
          <input
            type="checkbox"
            checked={Boolean(form.isAdBudget)}
            onChange={(event) => set('isAdBudget', event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-brand-600"
          />
          <span>
            <span className="block text-sm font-semibold text-slate-700">{t('services.adBudget')}</span>
            <span className="mt-0.5 block text-xs text-slate-500">{t('services.adBudgetHint')}</span>
          </span>
        </label>

        {!form.isAdBudget && (
          <div className="rounded-2xl border border-slate-200 p-4">
            <h4 className="text-sm font-bold text-slate-900">{t('services.costing')}</h4>
            <p className="mt-0.5 mb-4 text-xs leading-relaxed text-slate-500">{t('services.costingHint')}</p>

            <CostLinesEditor
              title={t('services.directCost')}
              keys={DIRECT_COST_KEYS}
              lines={form.direct ?? []}
              onChange={(updater) => setLines('direct', updater)}
            />

            <div className="mt-4">
              <CostLinesEditor
                title={t('services.indirectCost')}
                hint={t('services.indirectHint')}
                keys={INDIRECT_COST_KEYS}
                lines={form.indirect ?? []}
                onChange={(updater) => setLines('indirect', updater)}
              />
            </div>

            <div className="mt-4 max-w-xs">
              <Field label={t('services.markup')}>
                <Input
                  numeric
                  value={form.markupPct ?? ''}
                  onChange={(event) => set('markupPct', event.target.value)}
                  placeholder="0"
                />
              </Field>
            </div>

            <div className="mt-4 grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-4">
              <CostTile label={t('services.directCost')} value={breakdown.directTotal} tone="text-rose-600" />
              <CostTile label={t('services.indirectCost')} value={breakdown.indirectTotal} tone="text-rose-600" />
              <CostTile label={t('services.fullCost')} value={breakdown.fullCost} tone="text-rose-700" strong />
              <CostTile label={t('services.suggestedPrice')} value={breakdown.suggestedPrice} tone="text-emerald-600" strong />
            </div>

            {toNumber(form.price) > 0 && breakdown.hasCosting && (
              <p className="mt-2 text-xs font-semibold text-slate-600">
                {t('services.margin')}:{' '}
                <span className={margin.margin >= 15 ? 'text-emerald-600' : 'text-red-600'}>
                  {margin.margin}% ({formatMoney(margin.profit)} {t('common.currency')})
                </span>
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function CostLinesEditor({ title, hint, keys, lines, onChange }) {
  const { t } = useI18n()

  const addLine = () => onChange((current) => [...current, { key: keys[0], label: '', amount: '' }])
  const setLine = (index, patch) =>
    onChange((current) => current.map((line, position) => (position === index ? { ...line, ...patch } : line)))
  const removeLine = (index) => onChange((current) => current.filter((_, position) => position !== index))

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <span className="text-xs font-bold text-slate-700">{title}</span>
          {hint && <p className="text-[11px] leading-relaxed text-slate-400">{hint}</p>}
        </div>
        <Button variant="soft" onClick={addLine}>
          + {t('services.addCostLine')}
        </Button>
      </div>

      {lines.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-3 py-3 text-center text-xs text-slate-400">{t('settings.emptyList')}</p>
      ) : (
        <div className="space-y-2">
          {lines.map((line, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-12">
              <div className="sm:col-span-4">
                <Select value={line.key ?? keys[0]} onChange={(event) => setLine(index, { key: event.target.value })}>
                  {keys.map((key) => (
                    <option key={key} value={key}>
                      {t(`cost.key.${key}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="sm:col-span-5">
                <Input
                  value={line.label ?? ''}
                  onChange={(event) => setLine(index, { label: event.target.value })}
                  placeholder={t('common.description')}
                />
              </div>
              <div className="sm:col-span-2">
                <Input
                  numeric
                  value={line.amount ?? ''}
                  onChange={(event) => setLine(index, { amount: event.target.value })}
                  placeholder={t('common.amount')}
                />
              </div>
              <div className="flex items-center sm:col-span-1">
                <button
                  type="button"
                  onClick={() => removeLine(index)}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CostTile({ label, value, tone = 'text-slate-900', strong = false }) {
  const { t } = useI18n()
  return (
    <div>
      <p className="text-[11px] font-semibold text-slate-500">{label}</p>
      <p className={`num mt-0.5 ${strong ? 'text-base font-extrabold' : 'text-sm font-bold'} ${tone}`}>
        {formatMoney(value)}
        <span className="ms-1 text-[10px] font-semibold text-slate-400">{t('common.currency')}</span>
      </p>
    </div>
  )
}
