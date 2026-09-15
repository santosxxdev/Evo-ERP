import { useState } from 'react'
import { useI18n } from '../i18n'
import { createDoc, deleteDocById, updateDocById, useCollection } from '../lib/db'
import { Button, Input, Modal, Select } from './ui'

/**
 * قائمة منسدلة يقدر المستخدم يضيف/يعدّل/يحذف عناصرها بنفسه.
 * تخزّن الاسم نصًّا مباشرةً (لا مُعرّف)، فتبقى القيمة مقروءة في المستند.
 * زر ⚙ جنب القائمة يفتح نافذة إدارة صغيرة.
 */
export default function ManagedSelect({
  collectionName,
  value,
  onChange,
  defaults = [],
  placeholder,
}) {
  const { t } = useI18n()
  const { rows } = useCollection(collectionName, 'name', 'asc')
  const [managing, setManaging] = useState(false)

  /* الأسماء المعروضة: من القاعدة، وإلا الافتراضية، مع ضمان ظهور القيمة الحالية */
  const names = rows.length ? rows.map((r) => r.name) : defaults
  const options = value && !names.includes(value) ? [value, ...names] : names

  return (
    <>
      <div className="flex items-stretch gap-2">
        <Select value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
          <option value="">{placeholder ?? t('common.none')}</option>
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <button
          type="button"
          onClick={() => setManaging(true)}
          title={t('managed.manage')}
          className="shrink-0 rounded-xl border border-slate-200 px-3 text-slate-500 transition hover:bg-slate-50 hover:text-brand-600"
        >
          +
        </button>
      </div>

      <ManageModal
        open={managing}
        onClose={() => setManaging(false)}
        collectionName={collectionName}
        rows={rows}
        defaults={defaults}
        onPick={(name) => {
          onChange(name)
          setManaging(false)
        }}
      />
    </>
  )
}

function ManageModal({ open, onClose, collectionName, rows, defaults, onPick }) {
  const { t } = useI18n()
  const [adding, setAdding] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  async function seedDefaults() {
    setBusy(true)
    for (const name of defaults) await createDoc(collectionName, { name })
    setBusy(false)
  }

  async function add() {
    const name = adding.trim()
    if (!name) return
    setBusy(true)
    await createDoc(collectionName, { name })
    setAdding('')
    setBusy(false)
  }

  async function rename(id) {
    const name = draft.trim()
    if (!name) return
    setBusy(true)
    await updateDocById(collectionName, id, { name })
    setEditingId(null)
    setBusy(false)
  }

  return (
    <Modal open={open} onClose={onClose} title={t('managed.title')}>
      {rows.length === 0 && defaults.length > 0 && (
        <div className="mb-4 rounded-xl bg-slate-50 px-4 py-3">
          <p className="mb-2 text-xs text-slate-500">{t('managed.seedHint')}</p>
          <Button variant="soft" onClick={seedDefaults} disabled={busy}>
            {t('managed.seed', { count: defaults.length })}
          </Button>
        </div>
      )}

      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
            {editingId === row.id ? (
              <>
                <Input value={draft} onChange={(event) => setDraft(event.target.value)} />
                <Button variant="soft" onClick={() => rename(row.id)} disabled={busy}>
                  {t('common.save')}
                </Button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onPick(row.name)}
                  className="flex-1 text-start text-sm font-semibold text-slate-800 hover:text-brand-600"
                >
                  {row.name}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(row.id)
                    setDraft(row.name)
                  }}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100"
                >
                  {t('common.edit')}
                </button>
                <button
                  type="button"
                  onClick={() => deleteDocById(collectionName, row.id)}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  {t('common.delete')}
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-stretch gap-2">
        <Input
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          placeholder={t('managed.addPlaceholder')}
          onKeyDown={(event) => event.key === 'Enter' && add()}
        />
        <Button onClick={add} disabled={busy || !adding.trim()}>
          {t('common.add')}
        </Button>
      </div>
    </Modal>
  )
}
