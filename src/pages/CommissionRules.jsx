import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection, useLookup, updateDocById } from '../lib/db'
import { updateDepartment } from '../lib/hr'
import { formatMoney, toNumber } from '../lib/format'
import { IconTarget } from '../components/Icons'
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader,
  SearchInput, Select, StatCard, TableWrap, Td, Th,
} from '../components/ui'

export default function CommissionRules() {
  const { t } = useI18n()
  const { role } = useAuth()
  const canModify = role === 'admin' || role === 'accountant'

  const { rows: departments, loading: loadingDepts } = useCollection(COL.departments, 'name', 'asc')
  const { rows: employees, loading: loadingEmps } = useCollection(COL.employees)

  const [search, setSearch] = useState('')
  const [editingDept, setEditingDept] = useState(null)
  
  // modal state
  const [commissionEnabled, setCommissionEnabled] = useState(false)
  const [commissionRate, setCommissionRate] = useState('')
  const [targetAmount, setTargetAmount] = useState('')
  const [requireTargetForCommission, setRequireTargetForCommission] = useState(false)
  const [overTargetCommissionEnabled, setOverTargetCommissionEnabled] = useState(false)
  const [overTargetCommissionRate, setOverTargetCommissionRate] = useState('')
  const [busy, setBusy] = useState(false)

  const filteredDepartments = useMemo(() => {
    return departments.filter((dept) => {
      return (
        !search.trim() ||
        (dept.name && dept.name.toLowerCase().includes(search.toLowerCase())) ||
        (dept.code && dept.code.toLowerCase().includes(search.toLowerCase()))
      )
    })
  }, [departments, search])

  const deptsWithCommission = useMemo(() => departments.filter(d => d.commissionEnabled).length, [departments])
  const deptsWithoutCommission = useMemo(() => departments.length - deptsWithCommission, [departments, deptsWithCommission])

  const totalCommEmps = useMemo(() => {
    const commDeptIds = new Set(departments.filter(d => d.commissionEnabled).map(d => d.id))
    return employees.filter(e => commDeptIds.has(e.departmentId)).length
  }, [departments, employees])

  function startEdit(dept) {
    setEditingDept(dept)
    setCommissionEnabled(dept.commissionEnabled || false)
    setCommissionRate(dept.commissionRate || '')
    setTargetAmount(dept.targetAmount || '')
    setRequireTargetForCommission(dept.requireTargetForCommission || false)
    setOverTargetCommissionEnabled(dept.overTargetCommissionEnabled || false)
    setOverTargetCommissionRate(dept.overTargetCommissionRate || '')
  }

  async function handleSave(e) {
    if (e) e.preventDefault()
    if (!editingDept || !canModify) return
    setBusy(true)
    try {
      await updateDepartment(editingDept.id, {
        commissionEnabled,
        commissionRate: commissionEnabled ? toNumber(commissionRate) : null,
        targetAmount: commissionEnabled ? toNumber(targetAmount) : null,
        requireTargetForCommission: commissionEnabled ? requireTargetForCommission : false,
        overTargetCommissionEnabled: commissionEnabled ? overTargetCommissionEnabled : false,
        overTargetCommissionRate: commissionEnabled && overTargetCommissionEnabled ? toNumber(overTargetCommissionRate) : null
      })
      setEditingDept(null)
    } catch (err) {
      console.error('Failed to update commission rules:', err)
    } finally {
      setBusy(false)
    }
  }

  const deptEmployees = useMemo(() => {
    if (!editingDept) return []
    return employees.filter(e => e.departmentId === editingDept.id)
  }, [editingDept, employees])

  if (loadingDepts || loadingEmps) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('commissionRules.title')}
        subtitle={t('commissionRules.subtitle')}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('commissionRules.enabledDepts')}
          value={deptsWithCommission}
        />
        <StatCard
          label={t('commissionRules.totalEmp')}
          value={totalCommEmps}
        />
        <StatCard
          label={t('commissionRules.disabledDepts')}
          value={deptsWithoutCommission}
        />
      </div>

      <div className="space-y-4">
        <div className="w-full sm:w-80">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('commissionRules.search')}
          />
        </div>

        <TableWrap>
          <table className="w-full text-start text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <Th>{t('commissionRules.deptName')}</Th>
                <Th>{t('commissionRules.code') || 'الكود'}</Th>
                <Th>{t('commissionRules.enabled')}</Th>
                <Th>{t('commissionRules.rate')}</Th>
                <Th>{t('commissionRules.target')}</Th>
                <Th>{t('commissionRules.overRate')}</Th>
                <Th>{t('commissionRules.empCount')}</Th>
                {canModify && <Th className="text-end">{t('commissionRules.actions') || 'الإجراءات'}</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredDepartments.length === 0 ? (
                <tr>
                  <Td colSpan={canModify ? 8 : 7} className="p-8 text-center text-slate-500">
                    {t('commissionRules.empty')}
                  </Td>
                </tr>
              ) : (
                filteredDepartments.map((dept) => {
                  const empCount = employees.filter(e => e.departmentId === dept.id).length
                  return (
                    <tr key={dept.id} className="hover:bg-slate-50/50 transition-colors">
                      <Td className="font-bold text-slate-900">{dept.name}</Td>
                      <Td className="font-mono text-xs text-slate-600">{dept.code || '-'}</Td>
                      <Td>
                        <Badge tone={dept.commissionEnabled ? 'green' : 'slate'}>
                          {dept.commissionEnabled ? (t('commissionRules.yes') || 'مفعل') : (t('commissionRules.no') || 'معطل')}
                        </Badge>
                      </Td>
                      <Td className="num">
                        {dept.commissionEnabled ? `${dept.commissionRate || 0}%` : '-'}
                      </Td>
                      <Td className="num">
                        {dept.commissionEnabled && dept.targetAmount ? formatMoney(dept.targetAmount) : '-'}
                      </Td>
                      <Td className="num">
                        {dept.commissionEnabled && dept.overTargetCommissionEnabled ? `${dept.overTargetCommissionRate || 0}%` : '-'}
                      </Td>
                      <Td className="num">{empCount}</Td>
                      {canModify && (
                        <Td className="text-end">
                          <button
                            type="button"
                            onClick={() => startEdit(dept)}
                            className="text-xs font-semibold text-brand-600 hover:text-brand-800 hover:underline transition-colors"
                          >
                            {t('commissionRules.edit')}
                          </button>
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

      <Modal
        open={!!editingDept}
        onClose={() => setEditingDept(null)}
        title={t('commissionRules.editTitle')}
      >
        {editingDept && (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="mb-4">
              <span className="block text-sm font-semibold text-slate-700">
                {editingDept.name}
              </span>
            </div>
            
            <label className="flex items-center gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                checked={commissionEnabled}
                onChange={(e) => setCommissionEnabled(e.target.checked)}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-600"
              />
              <span>{t('commissionRules.enabled')}</span>
            </label>

            {commissionEnabled && (
              <>
                <Field label={t('commissionRules.rate')}>
                  <Input
                    type="number"
                    placeholder="15"
                    value={commissionRate}
                    onChange={(e) => setCommissionRate(e.target.value)}
                  />
                </Field>
                <Field label={t('commissionRules.target')}>
                  <Input
                    type="number"
                    placeholder="50000"
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(e.target.value)}
                  />
                </Field>
                
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={requireTargetForCommission}
                    onChange={(e) => setRequireTargetForCommission(e.target.checked)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                  />
                  <span>Require Target For Commission</span>
                </label>

                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={overTargetCommissionEnabled}
                    onChange={(e) => setOverTargetCommissionEnabled(e.target.checked)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                  />
                  <span>Over Target Commission Enabled</span>
                </label>
                
                {overTargetCommissionEnabled && (
                  <Field label={t('commissionRules.overRate')}>
                    <Input
                      type="number"
                      placeholder="20"
                      value={overTargetCommissionRate}
                      onChange={(e) => setOverTargetCommissionRate(e.target.value)}
                    />
                  </Field>
                )}
              </>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <Button type="button" variant="ghost" onClick={() => setEditingDept(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {t('commissionRules.save')}
              </Button>
            </div>

            <div className="mt-8 border-t border-slate-200 pt-4">
              <h4 className="text-sm font-bold text-slate-800 mb-3">
                {t('commissionRules.empInDept')}
              </h4>
              <TableWrap>
                <table className="w-full text-start text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
                    <tr>
                      <Th>Employee</Th>
                      <Th>{t('commissionRules.source')}</Th>
                      <Th>{t('commissionRules.rate')}</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {deptEmployees.length === 0 ? (
                      <tr>
                        <Td colSpan={3} className="p-4 text-center text-slate-500">
                          No employees
                        </Td>
                      </tr>
                    ) : (
                      deptEmployees.map((emp) => (
                        <tr key={emp.id}>
                          <Td>{emp.name}</Td>
                          <Td>
                            <Badge variant={emp.commissionSource === 'custom' ? 'amber' : 'sky'}>
                              {emp.commissionSource === 'custom'
                                ? t('commissionRules.sourceCustom')
                                : t('commissionRules.sourceDept')}
                            </Badge>
                          </Td>
                          <Td className="num">
                            {emp.commissionSource === 'custom'
                              ? `${emp.customCommissionRate || 0}%`
                              : `${commissionEnabled ? commissionRate : 0}%`}
                          </Td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </TableWrap>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
