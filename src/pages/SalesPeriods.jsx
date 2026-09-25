import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection, updateDocById } from '../lib/db'
import { createSalesPeriod, toggleSalesPeriodStatus } from '../lib/commissions'
import { formatDate, formatMoney, toNumber, todayISO } from '../lib/format'
import {
  Badge, Button, Field, Input, Loading, PageHeader,
  SearchInput, StatCard, TableWrap, Td, Th,
} from '../components/ui'

export default function SalesPeriods() {
  const { t } = useI18n()
  const { role } = useAuth()
  const canModify = role === 'admin' || role === 'accountant'

  const { rows: periods, loading: loadingPeriods } = useCollection(COL.salesPeriods, 'startDate', 'desc')

  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState(todayISO())
  const [endDate, setEndDate] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')

  const filteredPeriods = useMemo(() => {
    return periods.filter((period) => {
      return (
        !search.trim() ||
        (period.name && period.name.toLowerCase().includes(search.toLowerCase()))
      )
    })
  }, [periods, search])

  const openCount = useMemo(() => periods.filter((p) => !p.closed).length, [periods])
  const closedCount = useMemo(() => periods.filter((p) => p.closed).length, [periods])

  async function handleSave(e) {
    if (e) e.preventDefault()
    if (!name.trim() || !startDate || !endDate || !canModify) return
    setBusy(true)
    try {
      if (editingId) {
        await updateDocById(COL.salesPeriods, editingId, { name, startDate, endDate })
      } else {
        await createSalesPeriod({ name, startDate, endDate })
      }
      resetForm()
    } catch (err) {
      console.error('Failed to save sales period:', err)
    } finally {
      setBusy(false)
    }
  }

  function resetForm() {
    setName('')
    setStartDate(todayISO())
    setEndDate('')
    setEditingId(null)
  }

  function startEdit(period) {
    setEditingId(period.id)
    setName(period.name || '')
    setStartDate(period.startDate || '')
    setEndDate(period.endDate || '')
  }

  async function handleToggle(period) {
    if (!canModify) return
    try {
      await toggleSalesPeriodStatus(period.id, !period.closed)
    } catch (err) {
      console.error('Failed to toggle period status:', err)
    }
  }

  if (loadingPeriods) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('periods.title')}
        subtitle={t('periods.subtitle')}
      />

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('periods.total')}
          value={periods.length}
          subtext={t('periods.title')}
        />
        <StatCard
          label={t('periods.openCount')}
          value={openCount}
          subtext={t('periods.open')}
        />
        <StatCard
          label={t('periods.closedCount')}
          value={closedCount}
          subtext={t('periods.closed')}
        />
      </div>

      {/* Form Card for Creating / Editing Sales Period */}
      {canModify && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs transition-all">
          <h3 className="mb-4 text-base font-bold text-slate-800">
            {editingId ? t('periods.formTitleEdit') : t('periods.formTitleNew')}
          </h3>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-4 items-end">
              <Field label={t('periods.name')}>
                <Input
                  placeholder={t('periods.namePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>

              <Field label={t('periods.startDate')}>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </Field>

              <Field label={t('periods.endDate')}>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  required
                />
              </Field>

              <div className="flex gap-2">
                <Button type="submit" disabled={busy || !name.trim() || !startDate || !endDate} className="flex-1">
                  {editingId ? t('periods.edit') : t('periods.add')}
                </Button>
                {editingId && (
                  <Button type="button" variant="ghost" onClick={resetForm}>
                    {t('periods.cancelEdit')}
                  </Button>
                )}
              </div>
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
            placeholder={t('periods.search')}
          />
        </div>

        <TableWrap>
          <table className="w-full text-start text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <Th>{t('periods.name')}</Th>
                <Th>{t('periods.startDate')}</Th>
                <Th>{t('periods.endDate')}</Th>
                <Th>{t('periods.status')}</Th>
                {canModify && <Th className="text-end">{t('periods.actions') || 'الإجراءات'}</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredPeriods.length === 0 ? (
                <tr>
                  <Td colSpan={canModify ? 5 : 4} className="p-8 text-center text-slate-500">
                    {t('periods.empty')}
                  </Td>
                </tr>
              ) : (
                filteredPeriods.map((period) => {
                  const isOpen = !period.closed
                  return (
                    <tr key={period.id} className="hover:bg-slate-50/50 transition-colors">
                      <Td className="font-bold text-slate-900">{period.name}</Td>
                      <Td className="text-slate-600">{formatDate(period.startDate)}</Td>
                      <Td className="text-slate-600">{formatDate(period.endDate)}</Td>
                      <Td>
                        <Badge variant={isOpen ? 'emerald' : 'neutral'}>
                          {isOpen ? t('periods.open') : t('periods.closed')}
                        </Badge>
                      </Td>
                      {canModify && (
                        <Td className="text-end">
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => handleToggle(period)}
                              className="text-xs font-semibold text-slate-600 hover:text-brand-600 transition-colors"
                            >
                              {isOpen ? t('periods.toggleClose') : t('periods.toggleOpen')}
                            </button>
                            <button
                              type="button"
                              onClick={() => startEdit(period)}
                              className="text-xs font-semibold text-brand-600 hover:text-brand-800 hover:underline transition-colors"
                            >
                              {t('periods.edit')}
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
