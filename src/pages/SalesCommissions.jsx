import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection, useLookup, updateDocById, createDoc } from '../lib/db'
import { calculatePeriodCommissions, employeePeriodDetail, disburseCommissions } from '../lib/commissions'
import { postCommissionToAccounting } from '../lib/employeeAccounting'
import { formatDate, formatMoney, formatNumber, todayISO, toNumber, round2 } from '../lib/format'
import { JOB_COSTS_COL } from './Vendors'
import {
  Badge,
  Button,
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
  Th,
} from '../components/ui'
import {
  IconTarget,
  IconInvoices,
  IconTrendUp,
  IconReports,
  IconUser,
} from '../components/Icons'

export default function SalesCommissions() {
  const { t } = useI18n()
  const { role, user } = useAuth()
  const canModify = role === 'admin' || role === 'accountant'

  // Default dates: current month from 1st to today
  const today = todayISO()
  const defaultStart = today.substring(0, 8) + '01'

  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(today)
  const [activePreset, setActivePreset] = useState('thisMonth')
  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [search, setSearch] = useState('')
  const [selectedDeptId, setSelectedDeptId] = useState('')
  const [statusTab, setStatusTab] = useState('all') // 'all', 'due', 'paid', 'targetMet'
  const [selectedEmpDetail, setSelectedEmpDetail] = useState(null)
  const [disburseModal, setDisburseModal] = useState(null)
  const [disburseAmount, setDisburseAmount] = useState('')
  const [disburseDate, setDisburseDate] = useState(today)
  const [busy, setBusy] = useState(false)

  // Realtime Collections
  const { rows: employees, loading: loadingEmps } = useCollection(COL.employees, 'name', 'asc')
  const { rows: departments, loading: loadingDepts } = useCollection(COL.departments, 'name', 'asc')
  const { rows: invoices, loading: loadingInvs } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: jobCosts, loading: loadingCosts } = useCollection(JOB_COSTS_COL, 'date', 'desc')
  const { rows: salesPeriods, loading: loadingPeriods } = useCollection(COL.salesPeriods, 'startDate', 'desc')
  const { rows: accounts } = useCollection(COL.accounts, 'code', 'asc')
  const { rows: settingsRows } = useCollection('settings')
  const settings = settingsRows?.[0] || {}

  const deptMap = useLookup(departments)

  // Quick Date Presets
  function applyPreset(key) {
    setActivePreset(key)
    setSelectedPeriodId('')
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()

    if (key === 'thisMonth') {
      setStartDate(defaultStart)
      setEndDate(today)
    } else if (key === 'lastMonth') {
      const prevMonth = new Date(y, m - 1, 1)
      const lastDayPrev = new Date(y, m, 0)
      const pad = (n) => String(n).padStart(2, '0')
      setStartDate(`${prevMonth.getFullYear()}-${pad(prevMonth.getMonth() + 1)}-01`)
      setEndDate(`${lastDayPrev.getFullYear()}-${pad(lastDayPrev.getMonth() + 1)}-${pad(lastDayPrev.getDate())}`)
    } else if (key === 'thisQuarter') {
      const qStartMonth = Math.floor(m / 3) * 3
      const pad = (n) => String(n).padStart(2, '0')
      setStartDate(`${y}-${pad(qStartMonth + 1)}-01`)
      setEndDate(today)
    } else if (key === 'thisYear') {
      setStartDate(`${y}-01-01`)
      setEndDate(today)
    }
  }

  // Sync date range if a saved period is selected
  function handlePeriodSelect(periodId) {
    setSelectedPeriodId(periodId)
    setActivePreset('custom')
    if (!periodId) return
    const p = salesPeriods.find((x) => x.id === periodId)
    if (p) {
      if (p.startDate) setStartDate(p.startDate)
      if (p.endDate) setEndDate(p.endDate)
    }
  }

  // Calculate commissions for the filtered period
  const periodResults = useMemo(() => {
    if (!startDate || !endDate) return []
    return calculatePeriodCommissions({
      employees,
      departments,
      invoices,
      jobCosts,
      startDate,
      endDate,
    })
  }, [employees, departments, invoices, jobCosts, startDate, endDate])

  // Summary KPIs for entire period
  const totals = useMemo(() => {
    let sales = 0
    let paid = 0
    let earned = 0
    let disburse = 0
    let due = 0

    periodResults.forEach((r) => {
      sales += r.totalSales
      paid += r.paidSales
      earned += r.commissionEarned
      disburse += r.commissionPaid
      due += r.commissionDue
    })

    return {
      totalSales: round2(sales),
      paidSales: round2(paid),
      commissionEarned: round2(earned),
      commissionPaid: round2(disburse),
      commissionDue: round2(due),
      dueStaffCount: periodResults.filter((r) => r.commissionDue > 0).length,
    }
  }, [periodResults])

  // Filtered rows based on search, department, and status tab
  const filteredResults = useMemo(() => {
    const term = search.trim().toLowerCase()
    return periodResults.filter((row) => {
      if (selectedDeptId && row.departmentId !== selectedDeptId) return false

      if (statusTab === 'due' && row.commissionDue <= 0) return false
      if (statusTab === 'paid' && (row.commissionDue > 0 || row.commissionEarned === 0)) return false
      if (statusTab === 'targetMet') {
        const emp = employees.find((e) => e.id === row.employeeId)
        const target = emp?.targetAmount || 0
        if (target <= 0 || row.paidSales < target) return false
      }

      if (!term) return true
      const deptName = deptMap.get(row.departmentId)?.name || ''
      return (
        row.employeeName.toLowerCase().includes(term) ||
        deptName.toLowerCase().includes(term)
      )
    })
  }, [periodResults, selectedDeptId, statusTab, search, deptMap, employees])

  // Active employee details for drill-down modal
  const activeDetailData = useMemo(() => {
    if (!selectedEmpDetail) return null
    const emp = employees.find((e) => e.id === selectedEmpDetail.employeeId)
    if (!emp) return null
    return {
      employee: emp,
      ...employeePeriodDetail({
        employee: emp,
        departments,
        invoices,
        jobCosts,
        startDate,
        endDate,
      }),
    }
  }, [selectedEmpDetail, employees, departments, invoices, jobCosts, startDate, endDate])

  // Handle Disburse Commission
  async function handleDisburse() {
    if (!disburseModal || !disburseAmount || toNumber(disburseAmount) <= 0) return
    setBusy(true)
    try {
      const emp = employees.find((e) => e.id === disburseModal.employeeId)
      const empName = emp?.name || disburseModal.employeeName || ''
      const amountNum = toNumber(disburseAmount)

      // Find all unpaid commission jobCosts for this employee in the period
      const validInvoiceIds = invoices
        .filter((inv) => inv.employeeId === disburseModal.employeeId && inv.date >= startDate && inv.date <= endDate && !inv.cancelled)
        .map((i) => i.id)

      const unpaidCosts = jobCosts.filter(
        (jc) =>
          jc.type === 'commission' &&
          jc.employeeId === disburseModal.employeeId &&
          !jc.paid &&
          validInvoiceIds.includes(jc.invoiceId || jc.entityId)
      )

      const costIdsToMark = unpaidCosts.map((c) => c.id)

      // 1. Mark jobCosts as paid in Firestore
      if (costIdsToMark.length > 0) {
        await disburseCommissions({ jobCostIds: costIdsToMark, date: disburseDate })
      } else {
        await createDoc(JOB_COSTS_COL, {
          type: 'commission',
          auto: 'commission',
          employeeId: disburseModal.employeeId,
          amount: amountNum,
          date: disburseDate,
          paid: true,
          paidDate: disburseDate,
          description: `صرف عمولة مبيعات الفترة من ${startDate} إلى ${endDate}`,
        })
      }

      // 2. Post to General Ledger (Accounting)
      try {
        await postCommissionToAccounting({
          jobCost: {
            id: `comm_${disburseModal.employeeId}_${startDate}_${endDate}`,
            amount: amountNum,
            date: disburseDate,
            description: `صرف عمولة مبيعات للموظف ${empName}`,
          },
          employeeId: disburseModal.employeeId,
          employeeName: empName,
          accounts,
          settings,
          uid: user?.uid,
        })
      } catch (acctErr) {
        console.warn('Accounting posting note:', acctErr.message)
      }

      setDisburseModal(null)
      setDisburseAmount('')
    } catch (err) {
      console.error(err)
      alert(err?.message || 'حدث خطأ أثناء صرف العمولة.')
    } finally {
      setBusy(false)
    }
  }

  if (loadingEmps || loadingDepts || loadingInvs || loadingCosts) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      {/* Native Clean Page Header */}
      <PageHeader
        title={t('commissions.title')}
        subtitle="متابعة احتساب وصرف عمولات مناديب المبيعات بناءً على المبالغ المحصلة فعلياً في الخزينة"
      />

      {/* KPI Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label={t('commissions.totalSales')}
          value={formatMoney(totals.totalSales)}
          suffix={t('common.currency')}
          Icon={IconInvoices}
        />
        <StatCard
          label={t('commissions.paidAmount')}
          value={formatMoney(totals.paidSales)}
          suffix={t('common.currency')}
          tone="text-emerald-600 bg-emerald-50"
          Icon={IconTrendUp}
        />
        <StatCard
          label={t('commissions.commissionEarned')}
          value={formatMoney(totals.commissionEarned)}
          suffix={t('common.currency')}
          tone="text-brand-600 bg-brand-50"
          Icon={IconTarget}
        />
        <StatCard
          label={t('commissions.commissionPaid')}
          value={formatMoney(totals.commissionPaid)}
          suffix={t('common.currency')}
          tone="text-slate-500 bg-slate-100"
          Icon={IconReports}
        />
        <StatCard
          label={t('commissions.commissionDue')}
          value={formatMoney(totals.commissionDue)}
          suffix={t('common.currency')}
          tone="text-amber-600 bg-amber-50"
          Icon={IconTarget}
        />
      </div>

      {/* Filter Toolbar Card */}
      <div className="card p-4 space-y-4">
        {/* Quick Presets Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-500 ml-2">الفترة:</span>
            {[
              { key: 'thisMonth', label: 'هذا الشهر' },
              { key: 'lastMonth', label: 'الشهر السابق' },
              { key: 'thisQuarter', label: 'الربع الحالي' },
              { key: 'thisYear', label: 'هذا العام' },
            ].map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => applyPreset(preset.key)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                  activePreset === preset.key
                    ? 'bg-brand-600 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="text-xs font-semibold text-slate-400">
            النطاق: <span className="num font-bold text-slate-700">{startDate} ~ {endDate}</span>
          </div>
        </div>

        {/* Inputs Row */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 items-end">
          <Field label={t('periods.startDate')}>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value)
                setActivePreset('custom')
                setSelectedPeriodId('')
              }}
            />
          </Field>

          <Field label={t('periods.endDate')}>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value)
                setActivePreset('custom')
                setSelectedPeriodId('')
              }}
            />
          </Field>

          <Field label="فترة مبيعات مسجلة">
            <Select value={selectedPeriodId} onChange={(e) => handlePeriodSelect(e.target.value)}>
              <option value="">تاريخ مخصص...</option>
              {salesPeriods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.startDate} ~ {p.endDate}) {p.closed ? '[مغلقة]' : '[مفتوحة]'}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="القسم">
            <Select value={selectedDeptId} onChange={(e) => setSelectedDeptId(e.target.value)}>
              <option value="">جميع الأقسام</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="بحث سريع">
            <SearchInput
              value={search}
              onChange={(val) => setSearch(typeof val === 'string' ? val : val?.target?.value ?? '')}
              placeholder="بحث بالموظف أو القسم..."
              className="w-full"
            />
          </Field>
        </div>
      </div>

      {/* Segment Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 rounded-xl bg-slate-100 p-1">
          {[
            { id: 'all', label: 'جميع الموظفين', count: periodResults.length },
            {
              id: 'due',
              label: 'مستحق للصرف',
              count: totals.dueStaffCount,
              tone: 'text-amber-700 bg-amber-50',
            },
            {
              id: 'paid',
              label: 'تم الصرف بالكامل',
              count: periodResults.filter((r) => r.commissionEarned > 0 && r.commissionDue === 0).length,
            },
            { id: 'targetMet', label: 'حقق التارجت' },
          ].map((tab) => {
            const active = statusTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  active
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span className={`num rounded-full px-1.5 py-0.2 text-[10px] font-bold ${tab.tone || 'bg-slate-200/70 text-slate-600'}`}>
                    {tab.count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <span className="text-xs text-slate-400 font-medium">
          عرض <strong className="num text-slate-700">{filteredResults.length}</strong> من أصل{' '}
          <strong className="num text-slate-700">{periodResults.length}</strong>
        </span>
      </div>

      {/* Main Table */}
      <TableWrap>
        <thead className="bg-slate-50 text-xs font-bold uppercase text-slate-500">
          <tr>
            <Th>{t('commissions.employee')}</Th>
            <Th>{t('commissions.department')}</Th>
            <Th className="text-end">{t('commissions.totalSales')}</Th>
            <Th className="text-end">{t('commissions.paidAmount')}</Th>
            <Th className="text-center">التارجت</Th>
            <Th className="text-center">النسبة</Th>
            <Th className="text-end">{t('commissions.commissionEarned')}</Th>
            <Th className="text-end">{t('commissions.commissionPaid')}</Th>
            <Th className="text-end">{t('commissions.commissionDue')}</Th>
            {canModify && <Th className="text-end">الإجراءات</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filteredResults.length === 0 ? (
            <tr>
              <td colSpan={canModify ? 10 : 9} className="py-16 text-center">
                <div className="mx-auto flex max-w-sm flex-col items-center justify-center gap-2 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400">
                    <IconTarget className="h-6 w-6" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                    لا توجد بيانات مسجلة
                  </h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    لم يتم العثور على فواتير أو عمولات لهذا النطاق الزمني.
                  </p>
                </div>
              </td>
            </tr>
          ) : (
            filteredResults.map((row) => {
              const dept = deptMap.get(row.departmentId)
              const emp = employees.find((e) => e.id === row.employeeId)
              const target = emp?.targetAmount || 0
              const hasTarget = target > 0
              const achievePct = hasTarget ? Math.round((row.paidSales / target) * 100) : 0

              return (
                <tr
                  key={row.employeeId}
                  className="hover:bg-slate-50/70 transition-colors cursor-pointer"
                  onClick={() => setSelectedEmpDetail(row)}
                >
                  <Td className="font-bold text-slate-900">
                    <div className="flex items-center gap-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-50 text-xs font-bold text-brand-700">
                        {(row.employeeName || '').slice(0, 1)}
                      </span>
                      <div>
                        <div>{row.employeeName}</div>
                        <div className="text-xs font-normal text-slate-400">
                          <span className="num">{row.invoiceCount}</span> فاتورة
                        </div>
                      </div>
                    </div>
                  </Td>

                  <Td className="text-xs text-slate-600">
                    {dept?.name ? <Badge tone="slate">{dept.name}</Badge> : '—'}
                  </Td>

                  <Td className="text-end num font-semibold text-slate-700">
                    {formatMoney(row.totalSales)}
                  </Td>

                  <Td className="text-end num font-bold text-emerald-700">
                    {formatMoney(row.paidSales)}
                  </Td>

                  <Td className="text-center text-xs">
                    {hasTarget ? (
                      <span className={`num font-bold ${achievePct >= 100 ? 'text-emerald-600' : 'text-slate-600'}`}>
                        {achievePct}% ({formatMoney(target)})
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </Td>

                  <Td className="text-center font-mono text-xs font-semibold text-brand-700">
                    {row.commissionRate}%
                  </Td>

                  <Td className="text-end num font-bold text-slate-900">
                    {formatMoney(row.commissionEarned)}
                  </Td>

                  <Td className="text-end num text-slate-500">
                    {formatMoney(row.commissionPaid)}
                  </Td>

                  <Td className="text-end">
                    {row.commissionDue > 0 ? (
                      <span className="num font-extrabold text-amber-700 bg-amber-50 px-2 py-1 rounded-lg">
                        {formatMoney(row.commissionDue)}
                      </span>
                    ) : (
                      <span className="text-xs font-bold text-emerald-700">
                        تم الصرف ✓
                      </span>
                    )}
                  </Td>

                  {canModify && (
                    <Td className="text-end" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        {row.commissionDue > 0 ? (
                          <Button
                            size="sm"
                            onClick={() => {
                              setDisburseModal(row)
                              setDisburseAmount(String(row.commissionDue))
                            }}
                          >
                            صرف
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedEmpDetail(row)}
                        >
                          التفاصيل
                        </Button>
                      </div>
                    </Td>
                  )}
                </tr>
              )
            })
          )}
        </tbody>
      </TableWrap>

      {/* Drill-down Detail Modal */}
      {activeDetailData && (
        <Modal
          open={Boolean(selectedEmpDetail)}
          onClose={() => setSelectedEmpDetail(null)}
          title={`تفاصيل عمولات: ${activeDetailData.employee.name}`}
          wide
        >
          <div className="space-y-5">
            {/* Target & KPI Summary */}
            <div className="card p-4 bg-slate-50 border-slate-200">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <span className="text-xs text-slate-500 block">إجمالي المبيعات:</span>
                  <strong className="num text-base font-bold text-slate-900">
                    {formatMoney(activeDetailData.summary.totalSales)} {t('common.currency')}
                  </strong>
                </div>

                <div>
                  <span className="text-xs text-slate-500 block">المحصل فعلياً:</span>
                  <strong className="num text-base font-bold text-emerald-700">
                    {formatMoney(activeDetailData.summary.paidSales)} {t('common.currency')}
                  </strong>
                </div>

                <div>
                  <span className="text-xs text-slate-500 block">التارجت والإنجاز:</span>
                  <strong className="num text-base font-bold text-slate-900">
                    {activeDetailData.targetInfo.targetAmount > 0
                      ? `${activeDetailData.targetInfo.achievedPercentage}% (${formatMoney(activeDetailData.targetInfo.targetAmount)})`
                      : 'بدون تارجت'}
                  </strong>
                </div>

                <div>
                  <span className="text-xs text-slate-500 block">الصافي المستحق للصرف:</span>
                  <strong className="num text-base font-extrabold text-amber-700">
                    {formatMoney(activeDetailData.summary.commissionDue)} {t('common.currency')}
                  </strong>
                </div>
              </div>
            </div>

            {/* Invoices Breakdown Table */}
            <div>
              <h4 className="text-sm font-bold text-slate-800 mb-2">الفواتير المحسوبة بالفترة:</h4>
              <TableWrap>
                <thead className="bg-slate-50 uppercase text-slate-500 text-xs">
                  <tr>
                    <Th>رقم الفاتورة</Th>
                    <Th>العميل</Th>
                    <Th>التاريخ</Th>
                    <Th className="text-end">الإجمالي</Th>
                    <Th className="text-end">المسدد من العميل</Th>
                    <Th className="text-end">أتعاب الشركة الصافية</Th>
                    <Th className="text-end">العمولة على المسدد</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {activeDetailData.invoices.length === 0 ? (
                    <tr>
                      <Td colSpan={7} className="text-center py-6 text-slate-400">
                        لا توجد فواتير
                      </Td>
                    </tr>
                  ) : (
                    activeDetailData.invoices.map((inv) => (
                      <tr key={inv.invoiceId}>
                        <Td className="font-bold text-slate-900 num font-mono">{inv.invoiceNumber}</Td>
                        <Td>{inv.clientName || '—'}</Td>
                        <Td className="num text-slate-500">{formatDate(inv.date)}</Td>
                        <Td className="text-end num font-semibold text-slate-700">{formatMoney(inv.total)}</Td>
                        <Td className="text-end num font-bold text-emerald-700">{formatMoney(inv.paidAmount)}</Td>
                        <Td className="text-end num text-slate-600">{formatMoney(inv.fees)}</Td>
                        <Td className="text-end num font-bold text-brand-700">{formatMoney(inv.commissionAmount)}</Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </TableWrap>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
              <Button variant="ghost" onClick={() => setSelectedEmpDetail(null)}>
                إغلاق
              </Button>
              {canModify && activeDetailData.summary.commissionDue > 0 && (
                <Button
                  onClick={() => {
                    const empRow = selectedEmpDetail
                    setSelectedEmpDetail(null)
                    setDisburseModal(empRow)
                    setDisburseAmount(String(activeDetailData.summary.commissionDue))
                  }}
                >
                  صرف عمولة الموظف ({formatMoney(activeDetailData.summary.commissionDue)} {t('common.currency')})
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Disburse Modal */}
      {disburseModal && (
        <Modal
          open={Boolean(disburseModal)}
          onClose={() => setDisburseModal(null)}
          title={`صرف عمولة: ${disburseModal.employeeName}`}
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-950 space-y-1">
              <div className="font-bold text-sky-900">القيد المحاسبي التلقائي للصرف:</div>
              <div className="font-mono">
                <div>Dr 5105 مصروف عمولات بيع (مدين)</div>
                <div>Cr 210201 مستحقات الموظف (دائن)</div>
              </div>
            </div>

            <Field label="المبلغ المراد صرفه (جنيه)">
              <Input
                numeric
                value={disburseAmount}
                onChange={(e) => setDisburseAmount(e.target.value)}
                placeholder="أدخل المبلغ"
              />
            </Field>

            <Field label="تاريخ الصرف">
              <Input
                type="date"
                value={disburseDate}
                onChange={(e) => setDisburseDate(e.target.value)}
              />
            </Field>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
              <Button variant="ghost" onClick={() => setDisburseModal(null)} disabled={busy}>
                إلغاء
              </Button>
              <Button
                onClick={handleDisburse}
                disabled={busy || !disburseAmount || toNumber(disburseAmount) <= 0}
              >
                {busy ? 'جارٍ الصرف…' : 'تأكيد الصرف والترحيل المحاسبي'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
