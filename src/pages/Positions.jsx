import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection } from '../lib/db'
import { createPosition, setPositionActive, updatePosition } from '../lib/hr'
import {
  Badge,
  Button,
  Field,
  Input,
  Loading,
  PageHeader,
  SearchInput,
  Select,
  StatCard,
  TableWrap,
  Td,
  Th,
} from '../components/ui'

export default function Positions() {
  const { t } = useI18n()
  const { role } = useAuth()
  const canModify = role === 'admin' || role === 'accountant'

  const { rows: positions, loading: loadingPositions } = useCollection(COL.positions, 'name', 'asc')
  const { rows: departments, loading: loadingDepts } = useCollection(COL.departments, 'name', 'asc')

  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedDeptFilter, setSelectedDeptFilter] = useState('')

  const deptMap = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments])

  const filteredPositions = useMemo(() => {
    return positions.filter((pos) => {
      const matchesSearch =
        !search.trim() ||
        (pos.name && pos.name.toLowerCase().includes(search.toLowerCase())) ||
        (pos.code && pos.code.toLowerCase().includes(search.toLowerCase()))
      const matchesDept = !selectedDeptFilter || pos.departmentId === selectedDeptFilter
      return matchesSearch && matchesDept
    })
  }, [positions, search, selectedDeptFilter])

  const activeCount = useMemo(() => positions.filter((p) => p.active !== false).length, [positions])
  const inactiveCount = useMemo(() => positions.filter((p) => p.active === false).length, [positions])

  async function handleSave(e) {
    if (e) e.preventDefault()
    if (!name.trim() || !canModify) return
    setBusy(true)
    try {
      if (editingId) {
        await updatePosition(editingId, { name, code, departmentId })
      } else {
        await createPosition({ name, code, departmentId })
      }
      resetForm()
    } catch (err) {
      console.error('Failed to save position:', err)
    } finally {
      setBusy(false)
    }
  }

  function resetForm() {
    setName('')
    setCode('')
    setDepartmentId('')
    setEditingId(null)
  }

  function startEdit(pos) {
    setEditingId(pos.id)
    setName(pos.name || '')
    setCode(pos.code || '')
    setDepartmentId(pos.departmentId || '')
  }

  async function handleToggleActive(pos) {
    if (!canModify) return
    try {
      await setPositionActive(pos.id, pos.active === false)
    } catch (err) {
      console.error('Failed to toggle position status:', err)
    }
  }

  if (loadingPositions || loadingDepts) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('positions.title')}
        subtitle={t('positions.subtitle')}
      />

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('positions.total')}
          value={positions.length}
          subtext={t('positions.title')}
        />
        <StatCard
          label={t('positions.activeCount')}
          value={activeCount}
          subtext={t('positions.activeTag')}
        />
        <StatCard
          label={t('positions.inactiveCount')}
          value={inactiveCount}
          subtext={t('positions.disabledTag')}
        />
      </div>

      {/* Form Card for Creating / Editing Position */}
      {canModify && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs transition-all">
          <h3 className="mb-4 text-base font-bold text-slate-800">
            {editingId ? t('positions.formTitleEdit') : t('positions.formTitleNew')}
          </h3>
          <form onSubmit={handleSave} className="grid gap-4 sm:grid-cols-4 items-end">
            <Field label={t('positions.name')}>
              <Input
                placeholder={t('positions.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>

            <Field label={t('positions.code')}>
              <Input
                placeholder={t('positions.codePlaceholder')}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>

            <Field label={t('positions.department')}>
              <Select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
              >
                <option value="">{t('positions.selectDepartment')}</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !name.trim()} className="flex-1">
                {editingId ? t('positions.edit') : t('positions.add')}
              </Button>
              {editingId && (
                <Button type="button" variant="ghost" onClick={resetForm}>
                  {t('positions.cancelEdit')}
                </Button>
              )}
            </div>
          </form>
        </div>
      )}

      {/* Table & Filter Bar */}
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:w-80">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('positions.search')}
            />
          </div>
          <div className="w-full sm:w-64">
            <Select
              value={selectedDeptFilter}
              onChange={(e) => setSelectedDeptFilter(e.target.value)}
            >
              <option value="">{t('positions.allDepartments')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <TableWrap>
          <table className="w-full text-start text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <Th>{t('positions.name')}</Th>
                <Th>{t('positions.code')}</Th>
                <Th>{t('positions.department')}</Th>
                <Th>{t('positions.status')}</Th>
                {canModify && <Th className="text-end">{t('positions.actions')}</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredPositions.length === 0 ? (
                <tr>
                  <Td colSpan={canModify ? 5 : 4} className="p-8 text-center text-slate-500">
                    {t('positions.empty')}
                  </Td>
                </tr>
              ) : (
                filteredPositions.map((pos) => {
                  const isActive = pos.active !== false
                  return (
                    <tr key={pos.id} className="hover:bg-slate-50/50 transition-colors">
                      <Td className="font-bold text-slate-900">{pos.name}</Td>
                      <Td className="font-mono text-xs text-slate-600">{pos.code || '-'}</Td>
                      <Td>
                        {pos.departmentId && deptMap.has(pos.departmentId) ? (
                          <span className="inline-block rounded-md bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                            {deptMap.get(pos.departmentId)}
                          </span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </Td>
                      <Td>
                        <Badge variant={isActive ? 'emerald' : 'neutral'}>
                          {isActive ? t('positions.activeTag') : t('positions.disabledTag')}
                        </Badge>
                      </Td>
                      {canModify && (
                        <Td className="text-end">
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => handleToggleActive(pos)}
                              className="text-xs font-semibold text-slate-600 hover:text-brand-600 transition-colors"
                            >
                              {isActive ? t('positions.disable') : t('positions.active')}
                            </button>
                            <button
                              type="button"
                              onClick={() => startEdit(pos)}
                              className="text-xs font-semibold text-brand-600 hover:text-brand-800 hover:underline transition-colors"
                            >
                              {t('positions.actionEdit')}
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
