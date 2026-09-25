import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection } from '../lib/db'
import { createDepartment, setDepartmentActive, updateDepartment } from '../lib/hr'
import {
  Badge,
  Button,
  Field,
  Input,
  Loading,
  PageHeader,
  SearchInput,
  StatCard,
  TableWrap,
  Td,
  Th,
} from '../components/ui'

export default function Departments() {
  const { t } = useI18n()
  const { role } = useAuth()
  const canModify = role === 'admin' || role === 'accountant'

  const { rows: departments, loading: loadingDepts } = useCollection(COL.departments, 'name', 'asc')

  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [description, setDescription] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')

  // Commission settings
  const [commissionEnabled, setCommissionEnabled] = useState(false)
  const [commissionRate, setCommissionRate] = useState('')
  const [targetAmount, setTargetAmount] = useState('')
  const [requireTarget, setRequireTarget] = useState(false)
  const [overTargetEnabled, setOverTargetEnabled] = useState(false)
  const [overTargetRate, setOverTargetRate] = useState('')

  const filteredDepartments = useMemo(() => {
    return departments.filter((dept) => {
      return (
        !search.trim() ||
        (dept.name && dept.name.toLowerCase().includes(search.toLowerCase())) ||
        (dept.code && dept.code.toLowerCase().includes(search.toLowerCase()))
      )
    })
  }, [departments, search])

  const activeCount = useMemo(() => departments.filter((d) => d.active !== false).length, [departments])
  const inactiveCount = useMemo(() => departments.filter((d) => d.active === false).length, [departments])

  async function handleSave(e) {
    if (e) e.preventDefault()
    if (!name.trim() || !canModify) return
    setBusy(true)
    try {
      const payload = {
        name, code, description,
        commissionEnabled,
        commissionRate: Number(commissionRate) || 0,
        targetAmount: Number(targetAmount) || 0,
        requireTargetForCommission: requireTarget,
        overTargetCommissionEnabled: overTargetEnabled,
        overTargetCommissionRate: Number(overTargetRate) || 0,
      }
      if (editingId) {
        await updateDepartment(editingId, payload)
      } else {
        await createDepartment(payload)
      }
      resetForm()
    } catch (err) {
      console.error('Failed to save department:', err)
    } finally {
      setBusy(false)
    }
  }

  function resetForm() {
    setName('')
    setCode('')
    setDescription('')
    setEditingId(null)
    setCommissionEnabled(false)
    setCommissionRate('')
    setTargetAmount('')
    setRequireTarget(false)
    setOverTargetEnabled(false)
    setOverTargetRate('')
  }

  function startEdit(dept) {
    setEditingId(dept.id)
    setName(dept.name || '')
    setCode(dept.code || '')
    setDescription(dept.description || '')
    setCommissionEnabled(Boolean(dept.commissionEnabled))
    setCommissionRate(dept.commissionRate || '')
    setTargetAmount(dept.targetAmount || '')
    setRequireTarget(Boolean(dept.requireTargetForCommission))
    setOverTargetEnabled(Boolean(dept.overTargetCommissionEnabled))
    setOverTargetRate(dept.overTargetCommissionRate || '')
  }

  async function handleToggleActive(dept) {
    if (!canModify) return
    try {
      await setDepartmentActive(dept.id, dept.active === false)
    } catch (err) {
      console.error('Failed to toggle department status:', err)
    }
  }

  if (loadingDepts) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('departments.title')}
        subtitle={t('departments.subtitle')}
      />

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('departments.total')}
          value={departments.length}
          subtext={t('departments.title')}
        />
        <StatCard
          label={t('departments.activeCount')}
          value={activeCount}
          subtext={t('departments.activeTag')}
        />
        <StatCard
          label={t('departments.inactiveCount')}
          value={inactiveCount}
          subtext={t('departments.disabledTag')}
        />
      </div>

      {/* Form Card for Creating / Editing Department */}
      {canModify && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs transition-all">
          <h3 className="mb-4 text-base font-bold text-slate-800">
            {editingId ? t('departments.formTitleEdit') : t('departments.formTitleNew')}
          </h3>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3 items-end">
              <Field label={t('departments.name')}>
                <Input
                  placeholder={t('departments.namePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>

              <Field label={t('departments.code')}>
                <Input
                  placeholder={t('departments.codePlaceholder')}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>

              <div className="flex gap-2">
                <Button type="submit" disabled={busy || !name.trim()} className="flex-1">
                  {editingId ? t('departments.edit') : t('departments.add')}
                </Button>
                {editingId && (
                  <Button type="button" variant="ghost" onClick={resetForm}>
                    {t('departments.cancelEdit')}
                  </Button>
                )}
              </div>
            </div>

            <Field label={t('departments.description')}>
              <Input
                placeholder={t('departments.descriptionPlaceholder')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            {/* إعدادات العمولة */}
            <div className="rounded-2xl border border-sky-200 bg-sky-50/40 p-4 space-y-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={commissionEnabled}
                  onChange={(e) => setCommissionEnabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-sky-600 rounded"
                />
                <span>
                  <span className="block text-sm font-bold text-sky-950">{t('departments.commissionEnabled')}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{t('departments.commissionEnabledHint')}</span>
                </span>
              </label>

              {commissionEnabled && (
                <div className="space-y-4 pt-3 border-t border-sky-200/60">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t('departments.commissionRate')}>
                      <Input
                        numeric
                        placeholder="15"
                        value={commissionRate}
                        onChange={(e) => setCommissionRate(e.target.value)}
                      />
                    </Field>
                    <Field label={t('departments.targetAmount')}>
                      <Input
                        numeric
                        placeholder="50000"
                        value={targetAmount}
                        onChange={(e) => setTargetAmount(e.target.value)}
                      />
                    </Field>
                  </div>

                  {Number(targetAmount) > 0 && (
                    <div className="space-y-3">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={requireTarget}
                          onChange={(e) => setRequireTarget(e.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-sky-600 rounded"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-slate-800">{t('departments.requireTarget')}</span>
                          <span className="mt-0.5 block text-xs text-slate-500">{t('departments.requireTargetHint')}</span>
                        </span>
                      </label>

                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={overTargetEnabled}
                          onChange={(e) => setOverTargetEnabled(e.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-sky-600 rounded"
                        />
                        <span>
                          <span className="block text-sm font-semibold text-slate-800">{t('departments.overTargetEnable')}</span>
                          <span className="mt-0.5 block text-xs text-slate-500">{t('departments.overTargetHint')}</span>
                        </span>
                      </label>

                      {overTargetEnabled && (
                        <div className="sm:w-1/2">
                          <Field label={t('departments.overTargetRate')}>
                            <Input
                              numeric
                              placeholder="10"
                              value={overTargetRate}
                              onChange={(e) => setOverTargetRate(e.target.value)}
                            />
                          </Field>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </form>
        </div>
      )}

      {/* Table & Search Bar */}
      <div className="space-y-4">
        <div className="w-full sm:w-80">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('departments.search')}
          />
        </div>

        <TableWrap>
          <table className="w-full text-start text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <Th>{t('departments.name')}</Th>
                <Th>{t('departments.code')}</Th>
                <Th>{t('departments.description')}</Th>
                <Th>نظام العمولة</Th>
                <Th>{t('departments.status')}</Th>
                {canModify && <Th className="text-end">{t('departments.actions')}</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredDepartments.length === 0 ? (
                <tr>
                  <Td colSpan={canModify ? 6 : 5} className="p-8 text-center text-slate-500">
                    {t('departments.empty')}
                  </Td>
                </tr>
              ) : (
                filteredDepartments.map((dept) => {
                  const isActive = dept.active !== false
                  return (
                    <tr key={dept.id} className="hover:bg-slate-50/50 transition-colors">
                      <Td className="font-bold text-slate-900">{dept.name}</Td>
                      <Td className="font-mono text-xs text-slate-600">{dept.code || '-'}</Td>
                      <Td className="text-xs text-slate-500">{dept.description || '-'}</Td>
                      <Td>
                        {dept.commissionEnabled ? (
                          <div className="text-xs space-y-0.5">
                            <span className="font-bold text-sky-800">{dept.commissionRate || 0}% عمولة</span>
                            {Number(dept.targetAmount) > 0 && (
                              <span className="block text-slate-500 font-mono">تارجت: {Number(dept.targetAmount).toLocaleString()}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">بدون عمولة</span>
                        )}
                      </Td>
                      <Td>
                        <Badge variant={isActive ? 'emerald' : 'neutral'}>
                          {isActive ? t('departments.activeTag') : t('departments.disabledTag')}
                        </Badge>
                      </Td>
                      {canModify && (
                        <Td className="text-end">
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => handleToggleActive(dept)}
                              className="text-xs font-semibold text-slate-600 hover:text-brand-600 transition-colors"
                            >
                              {isActive ? t('departments.disable') : t('departments.active')}
                            </button>
                            <button
                              type="button"
                              onClick={() => startEdit(dept)}
                              className="text-xs font-semibold text-brand-600 hover:text-brand-800 hover:underline transition-colors"
                            >
                              {t('departments.actionEdit')}
                            </button>
                          </div>
                        </Td>
                      )}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </TableWrap>
      </div>
    </div>
  )
}
