import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection } from '../lib/db'
import { dryRunEmployeeMigration, executeEmployeeMigration } from '../lib/hr'
import {
  Button,
  Loading,
  PageHeader,
  Select,
  StatCard,
} from '../components/ui'

export default function EmployeeMigration() {
  const { t } = useI18n()
  const { role } = useAuth()
  const canModify = role === 'admin' || role === 'accountant'

  const { rows: employees, loading: loadingEmps } = useCollection(COL.employees, 'name', 'asc')

  const dryRun = useMemo(() => dryRunEmployeeMigration(employees), [employees])
  const [selectedMap, setSelectedMap] = useState({})
  const [statusMap, setStatusMap] = useState({})
  const [busy, setBusy] = useState(false)
  const [successMsg, setSuccessMsg] = useState(null)

  const unnumberedItems = useMemo(
    () => dryRun.items.filter((i) => i.needsCode || i.needsStatus),
    [dryRun.items]
  )

  function toggleSelect(id) {
    setSelectedMap((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function handleStatusChange(id, status) {
    setStatusMap((prev) => ({ ...prev, [id]: status }))
  }

  async function handleExecute() {
    const selectedItems = unnumberedItems.filter((item) => selectedMap[item.id] !== false)
    if (selectedItems.length === 0 || !canModify) return

    setBusy(true)
    setSuccessMsg(null)
    try {
      const res = await executeEmployeeMigration(selectedItems, statusMap)
      setSuccessMsg(t('migration.success', { count: res.updatedCount }))
    } catch (err) {
      console.error('Error executing migration:', err)
    } finally {
      setBusy(false)
    }
  }

  if (loadingEmps) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('migration.title')}
        subtitle={t('migration.subtitle')}
      >
        {canModify && (
          <Button
            variant="primary"
            onClick={handleExecute}
            disabled={busy || unnumberedItems.length === 0}
          >
            {busy ? t('migration.executing') : t('migration.execute')}
          </Button>
        )}
      </PageHeader>

      {/* Dry-Run Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('migration.totalEmployees')}
          value={dryRun.scannedCount}
        />
        <StatCard
          label={t('migration.missingCode')}
          value={dryRun.missingCodeCount}
          tone="text-amber-700 bg-amber-50"
        />
        <StatCard
          label={t('migration.missingStatus')}
          value={dryRun.missingStatusCount}
          tone="text-sky-700 bg-sky-50"
        />
      </div>

      {/* Success Notification Banner */}
      {successMsg && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800 shadow-xs">
          ✓ {successMsg}
        </div>
      )}

      {/* List Card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
        <h3 className="text-sm font-bold text-slate-800">
          {t('migration.listTitle', { count: unnumberedItems.length })}
        </h3>

        {unnumberedItems.length === 0 ? (
          <div className="py-12 text-center text-sm font-semibold text-emerald-600">
            ✓ {t('migration.allDone')}
          </div>
        ) : (
          <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
            {unnumberedItems.map((item) => {
              const isSelected = selectedMap[item.id] !== false
              const currentStatus = statusMap[item.id] || item.suggestedStatus

              return (
                <div key={item.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between text-sm hover:bg-slate-50/50 px-2 rounded-xl transition-colors">
                  <label className="flex items-center gap-3 cursor-pointer">
                    {canModify && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(item.id)}
                        className="h-4 w-4 rounded-sm border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                    )}
                    <div>
                      <span className="font-bold text-slate-900">{item.name}</span>
                      <span className="ms-2 font-mono text-xs text-slate-500">
                        {item.employeeCode || t('migration.unassigned')}
                      </span>
                    </div>
                  </label>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">{t('migration.explicitStatus')}</span>
                    <Select
                      value={currentStatus}
                      onChange={(e) => handleStatusChange(item.id, e.target.value)}
                      disabled={!canModify}
                      className="py-1 text-xs w-48"
                    >
                      <option value="active">{t('migration.statusActive')}</option>
                      <option value="on_leave">{t('migration.statusLeave')}</option>
                      <option value="suspended">{t('migration.statusSuspended')}</option>
                      <option value="terminated">{t('migration.statusTerminated')}</option>
                      <option value="archived">{t('migration.statusArchived')}</option>
                    </Select>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
