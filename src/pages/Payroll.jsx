import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection, useSettings } from '../lib/db'
import { ACCOUNTS_COL } from '../lib/accounts'
import { JOB_COSTS_COL } from './Vendors'
import { formatDate, formatMoney, round2, toNumber } from '../lib/format'
import {
  createPayrollRun,
  formatPeriodId,
  getPayrollItems,
  getPayrollRun,
  isPeriodOnOrAfterCutover,
  PAYROLL_CUTOVER_MONTH,
  transitionPayrollRun,
  calculateAndPersistPayrollRun,
} from '../lib/payrollService'
import { postPayrollRun } from '../lib/payrollPosting'
import { calculatePayrollItem, roundMoney } from '../lib/payrollEngine'
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
  Th,
} from '../components/ui'
import ReportPrintHeader from '../components/ReportPrintHeader'
import PrintDocument from '../components/PrintDocument'
import { doc, onSnapshot, collection, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase'

export default function Payroll() {
  const { t, locale } = useI18n()
  const { user, role } = useAuth()
  const { settings } = useSettings()

  // 1. Collections & Data Queries
  const { rows: employees, loading: loadingEmps } = useCollection(COL.employees, 'employeeCode', 'asc')
  const { rows: departments } = useCollection(COL.departments, 'name', 'asc')
  const { rows: positions } = useCollection(COL.positions, 'title', 'asc')
  const { rows: jobCosts } = useCollection(JOB_COSTS_COL)
  const { rows: accounts } = useCollection(ACCOUNTS_COL, 'code', 'asc')
  const { rows: accountingTransactions } = useCollection(COL.accountingTransactions)

  // 2. Period Selection State
  const defaultMonthStr = '2026-10'
  const [selectedMonth, setSelectedMonth] = useState(defaultMonthStr)

  const [year, month] = useMemo(() => {
    const parts = (selectedMonth || defaultMonthStr).split('-')
    return [Number(parts[0]) || 2026, Number(parts[1]) || 10]
  }, [selectedMonth])

  const periodId = useMemo(() => formatPeriodId(year, month), [year, month])
  const isCutoverValid = useMemo(() => isPeriodOnOrAfterCutover(year, month), [year, month])

  // 3. Firestore Realtime State for Payroll Run and Items
  const [payrollRun, setPayrollRun] = useState(null)
  const [payrollItems, setPayrollItems] = useState([])
  const [loadingRun, setLoadingRun] = useState(true)

  useEffect(() => {
    setLoadingRun(true)
    if (!periodId) {
      setPayrollRun(null)
      setPayrollItems([])
      setLoadingRun(false)
      return
    }

    // Listener for Payroll Run
    const runRef = doc(db, 'payrollRuns', periodId)
    const unsubRun = onSnapshot(
      runRef,
      (snap) => {
        if (snap.exists()) {
          setPayrollRun({ id: snap.id, ...snap.data() })
        } else {
          setPayrollRun(null)
        }
        setLoadingRun(false)
      },
      (err) => {
        console.error('Error fetching payroll run:', err)
        setLoadingRun(false)
      }
    )

    // Listener for Payroll Items
    const itemsQuery = query(collection(db, 'payrollItems'), where('payrollRunId', '==', periodId))
    const unsubItems = onSnapshot(
      itemsQuery,
      (snap) => {
        const items = []
        snap.forEach((docSnap) => items.push({ id: docSnap.id, ...docSnap.data() }))
        setPayrollItems(items)
      },
      (err) => {
        console.error('Error fetching payroll items:', err)
      }
    )

    return () => {
      unsubRun()
      unsubItems()
    }
  }, [periodId])

  // 4. UI Filter & Edit States
  const [activeTab, setActiveTab] = useState('payroll') // 'payroll' | 'reconciliation' | 'statements'
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedDept, setSelectedDept] = useState('all')
  const [selectedFilterStatus, setSelectedFilterStatus] = useState('all')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')

  const [editInputs, setEditInputs] = useState({})
  const [activeItem, setActiveItem] = useState(null) // for edit/view item modal
  const [payslipItem, setPayslipItem] = useState(null) // for printable payslip modal
  const [printDocMode, setPrintDocMode] = useState(null) // 'report' | 'payslip' | null

  const [busy, setBusy] = useState(false)
  const [notification, setNotification] = useState(null) // { type: 'success'|'error', text: '' }
  const [confirmState, setConfirmState] = useState(null) // { action: 'review'|'approve'|'post', title: '', message: '' }
  const [postingResult, setPostingResult] = useState(null)

  const deptMap = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments])
  const posMap = useMemo(() => new Map(positions.map((p) => [p.id, p.title])), [positions])

  // Subledger Advance Balances (110203)
  const employeeAdvanceBalances = useMemo(() => {
    const balancesMap = new Map()
    employees.forEach((emp) => {
      const subledgerCode = `emp-advance-${emp.id}`
      let debits = 0
      let credits = 0
      accountingTransactions.forEach((tx) => {
        if (!tx.lines) return
        tx.lines.forEach((l) => {
          if (l.accountId === '110203' || String(l.code) === '110203') {
            if (l.subledgerId === subledgerCode || l.subledger === subledgerCode) {
              debits += Number(l.debit) || 0
              credits += Number(l.credit) || 0
            }
          }
        })
      })
      balancesMap.set(emp.id, Math.max(0, roundMoney(debits - credits)))
    })
    return balancesMap
  }, [employees, accountingTransactions])

  // Subledger Payable Ledger Balances (210201)
  const employeePayableLedger = useMemo(() => {
    const ledgerMap = new Map()
    employees.forEach((emp) => {
      const subledgerCode = `emp-payable-${emp.id}`
      let debits = 0
      let credits = 0
      accountingTransactions.forEach((tx) => {
        if (!tx.lines) return
        tx.lines.forEach((l) => {
          if (l.accountId === '210201' || String(l.code) === '210201') {
            if (l.subledgerId === subledgerCode || l.subledger === subledgerCode) {
              debits += Number(l.debit) || 0
              credits += Number(l.credit) || 0
            }
          }
        })
      })
      ledgerMap.set(emp.id, {
        debits: roundMoney(debits),
        credits: roundMoney(credits),
        outstandingPayable: roundMoney(credits - debits),
      })
    })
    return ledgerMap
  }, [employees, accountingTransactions])

  // Lifecycle check: Is editing allowed?
  const isEditable = useMemo(() => {
    if (!payrollRun) return true
    return payrollRun.status === 'DRAFT' || payrollRun.status === 'CALCULATED'
  }, [payrollRun])

  const statusTone = useCallback((status) => {
    switch (status) {
      case 'DRAFT':
        return 'slate'
      case 'CALCULATED':
        return 'sky'
      case 'REVIEW':
        return 'amber'
      case 'APPROVED':
        return 'brand'
      case 'POSTING':
        return 'amber'
      case 'POSTED':
        return 'green'
      case 'LOCKED':
        return 'slate'
      default:
        return 'slate'
    }
  }, [])

  // 5. Gather Payroll Engine Inputs
  const buildPayrollInputsForEmployees = useCallback(() => {
    return employees
      .filter((emp) => emp.status !== 'archived')
      .map((emp) => {
        const itemOverride = editInputs[emp.id] || {}
        const existingItem = payrollItems.find((i) => i.employeeId === emp.id) || {}

        const empJobCosts = jobCosts.filter(
          (j) => j.employeeId === emp.id && j.status === 'paid' && !j.payrollRunId
        )

        const commissionItems = empJobCosts.map((j) => ({
          jobCostId: j.id,
          amount: Number(j.commissionAmount) || 0,
          prePosted: Boolean(j.postedToGL),
        }))

        const advBalance = employeeAdvanceBalances.get(emp.id) || 0

        return {
          period: { year, month, periodId },
          employee: {
            id: emp.id,
            employeeCode: emp.employeeCode || emp.code || '',
            name: emp.name || '',
            baseSalary: itemOverride.baseSalary !== undefined ? itemOverride.baseSalary : (emp.baseSalary ?? 0),
            departmentId: emp.departmentId || '',
            positionId: emp.positionId || '',
            status: emp.status || 'active',
          },
          allowances: itemOverride.allowances || emp.allowances || [],
          bonus: itemOverride.bonus !== undefined ? itemOverride.bonus : (existingItem.bonus ?? 0),
          overtime: itemOverride.overtime !== undefined ? itemOverride.overtime : (existingItem.overtime ?? 0),
          commission: {
            items: commissionItems,
          },
          absenceDeduction:
            itemOverride.absenceDeduction !== undefined
              ? itemOverride.absenceDeduction
              : (existingItem.absenceDeduction ?? 0),
          lateDeduction:
            itemOverride.lateDeduction !== undefined ? itemOverride.lateDeduction : (existingItem.lateDeduction ?? 0),
          advanceRecovery: {
            requestedAmount:
              itemOverride.advanceRecoveryRequested !== undefined
                ? itemOverride.advanceRecoveryRequested
                : (existingItem.advanceRecoveryRequested ?? 0),
            outstandingBalance: advBalance,
          },
          otherDeductions:
            itemOverride.otherDeductions !== undefined ? itemOverride.otherDeductions : (existingItem.otherDeductions ?? 0),
        }
      })
  }, [employees, editInputs, payrollItems, jobCosts, employeeAdvanceBalances, year, month, periodId])

  // 6. Action Handlers
  const handleCreateRun = async () => {
    if (!isCutoverValid) {
      setNotification({
        type: 'error',
        text: `Payroll creation is strictly forbidden for period ${periodId} prior to cutover month ${PAYROLL_CUTOVER_MONTH}.`,
      })
      return
    }

    setBusy(true)
    setNotification(null)
    try {
      let run = payrollRun
      if (!run) {
        await createPayrollRun({ year, month, createdBy: user?.name || user?.email || 'user' })
      }
      const inputs = buildPayrollInputsForEmployees()
      await calculateAndPersistPayrollRun({
        periodId,
        payrollInputs: inputs,
        updatedBy: user?.name || user?.email || 'user',
      })
      setNotification({ type: 'success', text: `Payroll run ${periodId} created and calculated successfully.` })
    } catch (err) {
      console.error('Create run failed:', err)
      setNotification({ type: 'error', text: err.message || 'Failed to create payroll run.' })
    } finally {
      setBusy(false)
    }
  }

  const handleRecalculate = async () => {
    if (!payrollRun) return
    if (!isEditable) {
      setNotification({ type: 'error', text: `Cannot recalculate run in ${payrollRun.status} state.` })
      return
    }

    setBusy(true)
    setNotification(null)
    try {
      const inputs = buildPayrollInputsForEmployees()
      await calculateAndPersistPayrollRun({
        periodId,
        payrollInputs: inputs,
        updatedBy: user?.name || user?.email || 'user',
      })
      setNotification({ type: 'success', text: `Payroll recalculated successfully for ${periodId}.` })
    } catch (err) {
      console.error('Recalculate failed:', err)
      setNotification({ type: 'error', text: err.message || 'Failed to recalculate payroll.' })
    } finally {
      setBusy(false)
    }
  }

  const handleTransition = async (nextStatus) => {
    if (!payrollRun) return
    setBusy(true)
    setNotification(null)
    try {
      await transitionPayrollRun(periodId, payrollRun.status, nextStatus, user?.name || user?.email || 'user')
      setNotification({ type: 'success', text: `Payroll run status updated to ${nextStatus}.` })
      setConfirmState(null)
    } catch (err) {
      console.error('Transition failed:', err)
      setNotification({ type: 'error', text: err.message || 'Failed to update payroll status.' })
    } finally {
      setBusy(false)
    }
  }

  const handlePostGL = async () => {
    if (!payrollRun) return
    setBusy(true)
    setNotification(null)
    try {
      const res = await postPayrollRun({
        periodId,
        postedBy: user?.name || user?.email || 'user',
        accounts,
        settings,
      })
      setPostingResult(res)
      setNotification({ type: 'success', text: `Payroll posted successfully to GL (${res.transactionId}).` })
      setConfirmState(null)
    } catch (err) {
      console.error('Posting GL failed:', err)
      setNotification({ type: 'error', text: err.message || 'Failed to post payroll to GL.' })
    } finally {
      setBusy(false)
    }
  }

  // Export Payroll to CSV
  const exportPayrollCSV = () => {
    if (!payrollItems || payrollItems.length === 0) return

    const headers = [
      'Employee Code',
      'Employee Name',
      'Department',
      'Position',
      'Base Salary',
      'Allowances',
      'Bonus',
      'Overtime',
      'Commission',
      'Gross Pay',
      'Deductions',
      'Advance Recovery',
      'Net Pay',
      'Warnings',
    ]

    const rows = payrollItems.map((item) => [
      item.employeeCode || '',
      item.employeeName || '',
      deptMap.get(item.departmentId) || '',
      posMap.get(item.positionId) || '',
      toNumber(item.baseSalary),
      toNumber(item.totalAllowances),
      toNumber(item.bonus),
      toNumber(item.overtime),
      toNumber(item.commissionTotal),
      toNumber(item.grossPay),
      toNumber(item.totalDeductions),
      toNumber(item.advanceRecovery),
      toNumber(item.netPayable),
      (item.warnings || []).join('; '),
    ])

    const csvStr = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')),
    ].join('\r\n')

    const blob = new Blob([`\uFEFF${csvStr}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `iyora-payroll-${periodId}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  // 7. Summary Totals Calculation
  const totals = useMemo(() => {
    if (!payrollItems || payrollItems.length === 0) {
      return {
        itemCount: 0,
        totalGross: payrollRun?.totalGross || 0,
        totalDeductions: payrollRun?.totalDeductions || 0,
        totalNet: payrollRun?.totalNet || 0,
        totalCommission: 0,
        totalUnpostedCommission: 0,
        totalAdvanceRecovery: 0,
      }
    }

    return {
      itemCount: payrollItems.length,
      totalGross: payrollItems.reduce((sum, item) => sum + (Number(item.grossPay) || 0), 0),
      totalDeductions: payrollItems.reduce((sum, item) => sum + (Number(item.totalDeductions) || 0), 0),
      totalNet: payrollItems.reduce((sum, item) => sum + (Number(item.netPayable) || 0), 0),
      totalCommission: payrollItems.reduce((sum, item) => sum + (Number(item.commissionTotal) || 0), 0),
      totalUnpostedCommission: payrollItems.reduce((sum, item) => sum + (Number(item.unpostedCommission) || 0), 0),
      totalAdvanceRecovery: payrollItems.reduce((sum, item) => sum + (Number(item.advanceRecovery) || 0), 0),
    }
  }, [payrollItems, payrollRun])

  // 8. Accounting Reconciliation Panel Numbers
  const reconciliationData = useMemo(() => {
    const salaryExpense5201 = roundMoney(totals.totalGross)
    const commissionExpense5105 = roundMoney(totals.totalUnpostedCommission)
    const employeePayable210201 = roundMoney(totals.totalNet)
    const advanceRecovery110203 = roundMoney(totals.totalAdvanceRecovery)

    const totalDebits = roundMoney(salaryExpense5201 + commissionExpense5105)
    const totalCredits = roundMoney(employeePayable210201 + advanceRecovery110203)
    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01

    return {
      salaryExpense5201,
      commissionExpense5105,
      employeePayable210201,
      advanceRecovery110203,
      totalDebits,
      totalCredits,
      isBalanced,
    }
  }, [totals])

  // 9. Filtered Items List for Table
  const filteredItems = useMemo(() => {
    return payrollItems.filter((item) => {
      const matchesSearch =
        !searchQuery ||
        (item.employeeName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.employeeCode || '').toLowerCase().includes(searchQuery.toLowerCase())

      const matchesDept = selectedDept === 'all' || item.departmentId === selectedDept

      const hasWarnings = (item.warnings || []).length > 0
      const matchesStatus =
        selectedFilterStatus === 'all' ||
        (selectedFilterStatus === 'warnings' && hasWarnings) ||
        (selectedFilterStatus === 'clean' && !hasWarnings)

      return matchesSearch && matchesDept && matchesStatus
    })
  }, [payrollItems, searchQuery, selectedDept, selectedFilterStatus])

  // Selected Employee Statement Item
  const selectedStatementItem = useMemo(() => {
    if (!selectedEmployeeId) return payrollItems[0] || null
    return payrollItems.find((item) => item.employeeId === selectedEmployeeId) || null
  }, [payrollItems, selectedEmployeeId])

  // Handlers for modal item edit
  const handleSaveModalItem = () => {
    if (!activeItem) return
    handleRecalculate()
    setActiveItem(null)
  }

  if (loadingRun || loadingEmps) {
    return <Loading />
  }

  return (
    <div className="space-y-6">
      {/* PAGE HEADER */}
      <PageHeader
        title={t('nav.payroll') || 'رواتب الموظفين'}
        subtitle="Monthly employee payroll management, reporting & payslips"
      >
        <div className="flex flex-wrap items-center gap-3">
          {/* Period Selector */}
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
            <span className="text-xs font-semibold text-slate-500">Period:</span>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="bg-transparent text-sm font-bold text-slate-800 outline-none"
            />
          </div>

          {/* Lifecycle Status Badge */}
          <Badge tone={statusTone(payrollRun?.status || 'NO RUN')}>
            {payrollRun ? payrollRun.status : 'NO RUN'}
          </Badge>

          {/* Export CSV */}
          {payrollItems.length > 0 && (
            <Button variant="ghost" onClick={exportPayrollCSV}>
              📥 Export CSV
            </Button>
          )}

          {/* Print Report */}
          {payrollRun && (
            <Button variant="ghost" onClick={() => window.print()}>
              🖨️ Print Report
            </Button>
          )}

          {/* Dynamic Lifecycle Buttons */}
          {!payrollRun && (
            <Button
              variant="primary"
              onClick={handleCreateRun}
              disabled={busy || !isCutoverValid}
            >
              Create Payroll Run
            </Button>
          )}

          {payrollRun && isEditable && (
            <Button variant="ghost" onClick={handleRecalculate} disabled={busy}>
              Recalculate
            </Button>
          )}

          {payrollRun?.status === 'CALCULATED' && (
            <Button
              variant="primary"
              onClick={() =>
                setConfirmState({
                  action: 'review',
                  title: `Submit Payroll for Review (${periodId})?`,
                  message: 'This will lock calculation inputs for review. Are you sure you want to proceed?',
                })
              }
              disabled={busy}
            >
              Submit for Review
            </Button>
          )}

          {payrollRun?.status === 'REVIEW' && (
            <Button
              variant="primary"
              onClick={() =>
                setConfirmState({
                  action: 'approve',
                  title: `Approve Payroll (${periodId})?`,
                  message:
                    'Approving will lock all employee payroll items as final and enable General Ledger posting.',
                })
              }
              disabled={busy}
            >
              Approve Payroll
            </Button>
          )}

          {(payrollRun?.status === 'APPROVED' || payrollRun?.status === 'POSTING') && (
            <Button
              variant="primary"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() =>
                setConfirmState({
                  action: 'post',
                  title: `Post Payroll to Accounting (${periodId})?`,
                  message:
                    'This action creates consolidated General Ledger entries (Dr 5201, Dr 5105, Cr 210201, Cr 110203). After posting, payroll accounting entries cannot be edited directly.',
                })
              }
              disabled={busy}
            >
              Post to Accounting
            </Button>
          )}
        </div>
      </PageHeader>

      {/* WORKSPACE NAVIGATION TABS */}
      <div className="flex border-b border-slate-200">
        <button
          type="button"
          onClick={() => setActiveTab('payroll')}
          className={`border-b-2 px-5 py-3 text-sm font-bold transition ${
            activeTab === 'payroll'
              ? 'border-brand-600 text-brand-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          📋 Operations & Employee Items
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('reconciliation')}
          className={`border-b-2 px-5 py-3 text-sm font-bold transition ${
            activeTab === 'reconciliation'
              ? 'border-brand-600 text-brand-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          ⚖️ Accounting GL Reconciliation
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('statements')}
          className={`border-b-2 px-5 py-3 text-sm font-bold transition ${
            activeTab === 'statements'
              ? 'border-brand-600 text-brand-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          👤 Employee Statements & Payslips
        </button>
      </div>

      {/* NOTIFICATION BANNER */}
      {notification && (
        <div
          className={`flex items-center justify-between rounded-2xl px-5 py-4 text-sm font-semibold shadow-sm ${
            notification.type === 'error'
              ? 'border border-red-200 bg-red-50 text-red-800'
              : 'border border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          <span>{notification.text}</span>
          <button
            type="button"
            onClick={() => setNotification(null)}
            className="text-xs font-bold underline opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* CUTOVER RESTRICTION WARNING */}
      {!isCutoverValid && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          <p className="font-bold">Cutover Date Restriction</p>
          <p className="mt-1 text-xs">
            Payroll management is restricted prior to cutover month {PAYROLL_CUTOVER_MONTH}. Please select period 2026-10 or later.
          </p>
        </div>
      )}

      {/* SUMMARY STAT CARDS */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Employees" value={totals.itemCount} />
        <StatCard label="Gross Payroll" value={formatMoney(totals.totalGross)} suffix="EGP" />
        <StatCard label="Deductions" value={formatMoney(totals.totalDeductions)} suffix="EGP" />
        <StatCard label="Net Payroll" value={formatMoney(totals.totalNet)} suffix="EGP" tone="text-emerald-600 bg-emerald-50" />
        <StatCard label="Commission" value={formatMoney(totals.totalCommission)} suffix="EGP" />
        <StatCard label="Advance Recovery" value={formatMoney(totals.totalAdvanceRecovery)} suffix="EGP" />
      </div>

      {/* TAB 1: OPERATIONS & EMPLOYEE TABLE */}
      {activeTab === 'payroll' && (
        <div className="space-y-6">
          {/* SEARCH AND FILTERS */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search employee code or name..."
              />

              <Select
                value={selectedDept}
                onChange={(e) => setSelectedDept(e.target.value)}
                className="w-48"
              >
                <option value="all">All Departments</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>

              <Select
                value={selectedFilterStatus}
                onChange={(e) => setSelectedFilterStatus(e.target.value)}
                className="w-44"
              >
                <option value="all">All Items</option>
                <option value="warnings">Has Warnings</option>
                <option value="clean">Clean</option>
              </Select>
            </div>

            {payrollRun && (
              <p className="text-xs font-semibold text-slate-400">
                Run Version: {payrollRun.version || 1} · Last Updated:{' '}
                {payrollRun.updatedAt?.toDate ? formatDate(payrollRun.updatedAt.toDate()) : '—'}
              </p>
            )}
          </div>

          {/* MAIN PAYROLL TABLE OR EMPTY STATE */}
          {!payrollRun ? (
            <EmptyState
              title="No Payroll Run for Selected Period"
              message={`No payroll run document has been initialized for ${periodId}. Click below to create and calculate payroll.`}
              action={
                <Button
                  variant="primary"
                  onClick={handleCreateRun}
                  disabled={busy || !isCutoverValid}
                >
                  Create Payroll Run ({periodId})
                </Button>
              }
            />
          ) : filteredItems.length === 0 ? (
            <EmptyState
              title="No Payroll Items Found"
              message="No employee payroll items match the current filters."
            />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Employee</Th>
                  <Th>Dept / Position</Th>
                  <Th className="text-end">Base Salary</Th>
                  <Th className="text-end">Allowances</Th>
                  <Th className="text-end">Bonus</Th>
                  <Th className="text-end">Overtime</Th>
                  <Th className="text-end">Commission</Th>
                  <Th className="text-end">Gross</Th>
                  <Th className="text-end">Deductions</Th>
                  <Th className="text-end">Adv. Recovery</Th>
                  <Th className="text-end">Net Pay</Th>
                  <Th>Status</Th>
                  <Th className="text-center">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const warnings = item.warnings || []
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/80">
                      <Td className="font-mono text-xs font-bold text-slate-600">
                        {item.employeeCode || '—'}
                      </Td>
                      <Td className="font-semibold text-slate-900">
                        {item.employeeName}
                      </Td>
                      <Td className="text-xs text-slate-500">
                        <div>{deptMap.get(item.departmentId) || '—'}</div>
                        <div className="text-[11px] text-slate-400">{posMap.get(item.positionId) || '—'}</div>
                      </Td>
                      <Td className="text-end font-mono">{formatMoney(item.baseSalary)}</Td>
                      <Td className="text-end font-mono text-slate-600">{formatMoney(item.totalAllowances)}</Td>
                      <Td className="text-end font-mono text-emerald-600">{formatMoney(item.bonus)}</Td>
                      <Td className="text-end font-mono text-emerald-600">{formatMoney(item.overtime)}</Td>
                      <Td className="text-end font-mono text-sky-600">{formatMoney(item.commissionTotal)}</Td>
                      <Td className="text-end font-mono font-bold text-slate-900">{formatMoney(item.grossPay)}</Td>
                      <Td className="text-end font-mono text-rose-600">{formatMoney(item.totalDeductions)}</Td>
                      <Td className="text-end font-mono text-amber-600">{formatMoney(item.advanceRecovery)}</Td>
                      <Td className="text-end font-mono font-extrabold text-emerald-700">
                        {formatMoney(item.netPayable)}
                      </Td>
                      <Td>
                        {warnings.length > 0 ? (
                          <Badge tone="amber">{warnings.length} warning(s)</Badge>
                        ) : (
                          <Badge tone="green">Clean</Badge>
                        )}
                      </Td>
                      <Td className="text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <Button
                            variant="ghost"
                            className="px-2 py-1 text-xs"
                            onClick={() => setActiveItem(item)}
                          >
                            {isEditable ? 'Edit / View' : 'View Details'}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-2 py-1 text-xs text-brand-600"
                            onClick={() => setPayslipItem(item)}
                          >
                            📄 Payslip
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </TableWrap>
          )}
        </div>
      )}

      {/* TAB 2: ACCOUNTING GL RECONCILIATION */}
      {activeTab === 'reconciliation' && (
        <div className="space-y-6">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-base font-bold text-slate-900">
              General Ledger Accounting Reconciliation Panel ({periodId})
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Consolidated financial GL entries created upon posting. Verifies total debits equal total credits.
            </p>

            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
              {/* Debit Entries */}
              <div className="space-y-3 rounded-2xl border border-emerald-100 bg-emerald-50/50 p-5">
                <h4 className="text-xs font-extrabold uppercase tracking-wider text-emerald-900">
                  DEBIT ENTRIES (EXPENSES)
                </h4>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-slate-700">Dr 5201 (Salaries & Admin Wages):</span>
                  <span className="font-mono font-extrabold text-emerald-800">
                    {formatMoney(reconciliationData.salaryExpense5201)} EGP
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-slate-700">Dr 5105 (Unposted Commissions):</span>
                  <span className="font-mono font-extrabold text-emerald-800">
                    {formatMoney(reconciliationData.commissionExpense5105)} EGP
                  </span>
                </div>
                <div className="border-t border-emerald-200 pt-3 flex justify-between font-extrabold text-base text-emerald-950">
                  <span>TOTAL DEBITS:</span>
                  <span className="font-mono">{formatMoney(reconciliationData.totalDebits)} EGP</span>
                </div>
              </div>

              {/* Credit Entries */}
              <div className="space-y-3 rounded-2xl border border-sky-100 bg-sky-50/50 p-5">
                <h4 className="text-xs font-extrabold uppercase tracking-wider text-sky-900">
                  CREDIT ENTRIES (PAYABLES & ADVANCES SETTLEMENT)
                </h4>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-slate-700">Cr 210201 (Employee Payroll Payable):</span>
                  <span className="font-mono font-extrabold text-sky-800">
                    {formatMoney(reconciliationData.employeePayable210201)} EGP
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-slate-700">Cr 110203 (Employee Advances Recovery):</span>
                  <span className="font-mono font-extrabold text-sky-800">
                    {formatMoney(reconciliationData.advanceRecovery110203)} EGP
                  </span>
                </div>
                <div className="border-t border-sky-200 pt-3 flex justify-between font-extrabold text-base text-sky-950">
                  <span>TOTAL CREDITS:</span>
                  <span className="font-mono">{formatMoney(reconciliationData.totalCredits)} EGP</span>
                </div>
              </div>
            </div>

            {/* Reconciliation Status */}
            <div
              className={`mt-6 flex items-center justify-between rounded-2xl p-4 text-sm font-extrabold ${
                reconciliationData.isBalanced
                  ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                  : 'bg-red-100 text-red-900 border border-red-300'
              }`}
            >
              <span>Reconciliation Status: {reconciliationData.isBalanced ? '✓ Balanced' : '✗ Reconciliation Error'}</span>
              <span className="font-mono">
                Difference: {formatMoney(Math.abs(reconciliationData.totalDebits - reconciliationData.totalCredits))} EGP
              </span>
            </div>

            {payrollRun?.status === 'POSTED' && (
              <div className="mt-4 text-xs font-mono text-slate-500">
                Deterministic GL Transaction ID: <span className="font-bold text-slate-800">emp_payroll_run_{periodId}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: EMPLOYEE STATEMENTS & PAYSLIP */}
      {activeTab === 'statements' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-bold text-slate-700">Select Employee:</span>
              <Select
                value={selectedEmployeeId}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                className="w-72"
              >
                {payrollItems.map((i) => (
                  <option key={i.employeeId} value={i.employeeId}>
                    {i.employeeCode} — {i.employeeName}
                  </option>
                ))}
              </Select>
            </div>

            {selectedStatementItem && (
              <Button variant="primary" onClick={() => setPayslipItem(selectedStatementItem)}>
                📄 Open Printable Payslip
              </Button>
            )}
          </div>

          {selectedStatementItem ? (
            <div className="space-y-6">
              {/* Employee Summary Card */}
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <h3 className="text-lg font-extrabold text-slate-900">{selectedStatementItem.employeeName}</h3>
                    <p className="text-xs text-slate-500 font-mono">
                      Code: {selectedStatementItem.employeeCode} · Dept: {deptMap.get(selectedStatementItem.departmentId) || '—'} · Position: {posMap.get(selectedStatementItem.positionId) || '—'}
                    </p>
                  </div>
                  <Badge tone={statusTone(payrollRun?.status)}>{payrollRun?.status}</Badge>
                </div>

                {/* Earnings & Deductions Breakdown */}
                <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="space-y-2 rounded-2xl bg-slate-50 p-4 border border-slate-100">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Earnings Breakdown</h4>
                    <div className="flex justify-between text-xs">
                      <span>Base Salary:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.baseSalary)} EGP</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span>Allowances:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.totalAllowances)} EGP</span>
                    </div>
                    <div className="flex justify-between text-xs text-emerald-600">
                      <span>Bonus:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.bonus)} EGP</span>
                    </div>
                    <div className="flex justify-between text-xs text-emerald-600">
                      <span>Overtime:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.overtime)} EGP</span>
                    </div>
                    <div className="flex justify-between text-xs text-sky-600">
                      <span>Commission Total:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.commissionTotal)} EGP</span>
                    </div>
                    <div className="border-t pt-2 flex justify-between font-bold text-sm text-slate-900">
                      <span>Gross Earnings:</span>
                      <span className="font-mono">{formatMoney(selectedStatementItem.grossPay)} EGP</span>
                    </div>
                  </div>

                  <div className="space-y-2 rounded-2xl bg-slate-50 p-4 border border-slate-100">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Deductions Breakdown</h4>
                    <div className="flex justify-between text-xs text-rose-600">
                      <span>Absence Deduction:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.absenceDeduction)} EGP</span>
                    </div>
                    <div className="flex justify-between text-xs text-rose-600">
                      <span>Late Deduction:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.lateDeduction)} EGP</span>
                    </div>
                    <div className="flex justify-between text-xs text-amber-600">
                      <span>Advance Recovery:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.advanceRecovery)} EGP</span>
                    </div>
                    <div className="flex justify-between text-xs text-rose-600">
                      <span>Other Deductions:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.otherDeductions)} EGP</span>
                    </div>
                    <div className="border-t pt-2 flex justify-between font-bold text-sm text-rose-700">
                      <span>Total Deductions:</span>
                      <span className="font-mono">{formatMoney(selectedStatementItem.totalDeductions)} EGP</span>
                    </div>
                  </div>
                </div>

                {/* Net Salary Banner */}
                <div className="mt-6 flex items-center justify-between rounded-2xl bg-emerald-600 p-4 font-extrabold text-white">
                  <span className="text-base">NET SALARY PAYABLE:</span>
                  <span className="font-mono text-xl">{formatMoney(selectedStatementItem.netPayable)} EGP</span>
                </div>

                {/* Employee Subledger Payable Overview */}
                <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-900 p-4 text-white">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Employee Subledger Payable Balance (210201 · emp-payable-{selectedStatementItem.employeeId})
                  </h4>
                  <div className="mt-3 grid grid-cols-2 gap-4 text-xs font-mono">
                    <div>
                      <span className="text-slate-400">Total Credits Posted:</span>
                      <p className="text-sm font-bold text-emerald-400">
                        {formatMoney(employeePayableLedger.get(selectedStatementItem.employeeId)?.credits || 0)} EGP
                      </p>
                    </div>
                    <div>
                      <span className="text-slate-400">Total Disbursed (Debits):</span>
                      <p className="text-sm font-bold text-sky-400">
                        {formatMoney(employeePayableLedger.get(selectedStatementItem.employeeId)?.debits || 0)} EGP
                      </p>
                    </div>
                    <div className="col-span-2 border-t border-slate-700 pt-2 flex justify-between">
                      <span className="text-slate-300 font-bold">Outstanding Payable Balance:</span>
                      <span className="text-sm font-bold text-emerald-400">
                        {formatMoney(employeePayableLedger.get(selectedStatementItem.employeeId)?.outstandingPayable || 0)} EGP
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState title="No Employee Selected" message="Select an employee from the dropdown to view their statement." />
          )}
        </div>
      )}

      {/* EMPLOYEE DETAIL MODAL / EDIT DRAWER */}
      {activeItem && (
        <Modal
          open={Boolean(activeItem)}
          onClose={() => setActiveItem(null)}
          title={`Payroll Details: ${activeItem.employeeName} (${activeItem.employeeCode})`}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setActiveItem(null)}>
                Close
              </Button>
              {isEditable && (
                <Button variant="primary" onClick={handleSaveModalItem} disabled={busy}>
                  Save & Recalculate
                </Button>
              )}
            </>
          }
        >
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 rounded-2xl bg-slate-50 p-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-slate-400">Department</p>
                <p className="text-sm font-bold text-slate-800">{deptMap.get(activeItem.departmentId) || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Position</p>
                <p className="text-sm font-bold text-slate-800">{posMap.get(activeItem.positionId) || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Run Period</p>
                <p className="text-sm font-bold text-slate-800">{activeItem.periodId}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Run Status</p>
                <Badge tone={statusTone(payrollRun?.status)}>{payrollRun?.status}</Badge>
              </div>
            </div>

            {(activeItem.warnings || []).length > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
                <p className="font-bold">Warnings for this Employee:</p>
                <ul className="mt-1 list-disc ps-4 space-y-0.5">
                  {activeItem.warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-4 rounded-2xl border border-slate-100 p-4">
                <h4 className="text-sm font-bold text-slate-900">Earnings & Allowances</h4>

                <Field label="Base Salary (EGP)">
                  <Input
                    numeric
                    disabled={!isEditable}
                    value={
                      editInputs[activeItem.employeeId]?.baseSalary !== undefined
                        ? editInputs[activeItem.employeeId].baseSalary
                        : activeItem.baseSalary
                    }
                    onChange={(e) =>
                      setEditInputs({
                        ...editInputs,
                        [activeItem.employeeId]: {
                          ...editInputs[activeItem.employeeId],
                          baseSalary: toNumber(e.target.value),
                        },
                      })
                    }
                  />
                </Field>

                <Field label="Bonus (EGP)">
                  <Input
                    numeric
                    disabled={!isEditable}
                    value={
                      editInputs[activeItem.employeeId]?.bonus !== undefined
                        ? editInputs[activeItem.employeeId].bonus
                        : activeItem.bonus
                    }
                    onChange={(e) =>
                      setEditInputs({
                        ...editInputs,
                        [activeItem.employeeId]: {
                          ...editInputs[activeItem.employeeId],
                          bonus: toNumber(e.target.value),
                        },
                      })
                    }
                  />
                </Field>

                <Field label="Overtime (EGP)">
                  <Input
                    numeric
                    disabled={!isEditable}
                    value={
                      editInputs[activeItem.employeeId]?.overtime !== undefined
                        ? editInputs[activeItem.employeeId].overtime
                        : activeItem.overtime
                    }
                    onChange={(e) =>
                      setEditInputs({
                        ...editInputs,
                        [activeItem.employeeId]: {
                          ...editInputs[activeItem.employeeId],
                          overtime: toNumber(e.target.value),
                        },
                      })
                    }
                  />
                </Field>

                <div className="rounded-xl bg-slate-50 p-3">
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Total Allowances:</span>
                    <span className="font-mono font-bold text-slate-700">
                      {formatMoney(activeItem.totalAllowances)} EGP
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500 mt-1">
                    <span>Commission (Calculated):</span>
                    <span className="font-mono font-bold text-sky-600">
                      {formatMoney(activeItem.commissionTotal)} EGP
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-4 rounded-2xl border border-slate-100 p-4">
                <h4 className="text-sm font-bold text-slate-900">Deductions & Advances</h4>

                <Field label="Absence Deduction (EGP)">
                  <Input
                    numeric
                    disabled={!isEditable}
                    value={
                      editInputs[activeItem.employeeId]?.absenceDeduction !== undefined
                        ? editInputs[activeItem.employeeId].absenceDeduction
                        : activeItem.absenceDeduction
                    }
                    onChange={(e) =>
                      setEditInputs({
                        ...editInputs,
                        [activeItem.employeeId]: {
                          ...editInputs[activeItem.employeeId],
                          absenceDeduction: toNumber(e.target.value),
                        },
                      })
                    }
                  />
                </Field>

                <Field label="Late Deduction (EGP)">
                  <Input
                    numeric
                    disabled={!isEditable}
                    value={
                      editInputs[activeItem.employeeId]?.lateDeduction !== undefined
                        ? editInputs[activeItem.employeeId].lateDeduction
                        : activeItem.lateDeduction
                    }
                    onChange={(e) =>
                      setEditInputs({
                        ...editInputs,
                        [activeItem.employeeId]: {
                          ...editInputs[activeItem.employeeId],
                          lateDeduction: toNumber(e.target.value),
                        },
                      })
                    }
                  />
                </Field>

                <Field label="Advance Recovery Requested (EGP)">
                  <Input
                    numeric
                    disabled={!isEditable}
                    value={
                      editInputs[activeItem.employeeId]?.advanceRecoveryRequested !== undefined
                        ? editInputs[activeItem.employeeId].advanceRecoveryRequested
                        : activeItem.advanceRecoveryRequested
                    }
                    onChange={(e) =>
                      setEditInputs({
                        ...editInputs,
                        [activeItem.employeeId]: {
                          ...editInputs[activeItem.employeeId],
                          advanceRecoveryRequested: toNumber(e.target.value),
                        },
                      })
                    }
                  />
                  <span className="mt-1 block text-[11px] text-slate-400">
                    Outstanding Advance Balance: {formatMoney(activeItem.advanceOutstandingBalance || 0)} EGP
                  </span>
                </Field>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* PRINTABLE PAYSLIP MODAL */}
      {payslipItem && (
        <Modal
          open={Boolean(payslipItem)}
          onClose={() => setPayslipItem(null)}
          title={`Employee Payslip — ${payslipItem.employeeName}`}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setPayslipItem(null)}>
                Close
              </Button>
              <Button variant="primary" onClick={() => window.print()}>
                🖨️ Print Payslip
              </Button>
            </>
          }
        >
          <div className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-sm">
            <ReportPrintHeader
              title="EMPLOYEE PAYSLIP / إشعار راتب"
              subtitle={`Payroll Period: ${periodId}`}
            />

            <div className="grid grid-cols-2 gap-4 rounded-xl bg-slate-50 p-4 text-xs">
              <div>
                <span className="text-slate-400">Employee Name:</span>
                <p className="font-bold text-slate-900">{payslipItem.employeeName}</p>
              </div>
              <div>
                <span className="text-slate-400">Employee Code:</span>
                <p className="font-mono font-bold text-slate-900">{payslipItem.employeeCode}</p>
              </div>
              <div>
                <span className="text-slate-400">Department:</span>
                <p className="font-bold text-slate-800">{deptMap.get(payslipItem.departmentId) || '—'}</p>
              </div>
              <div>
                <span className="text-slate-400">Position:</span>
                <p className="font-bold text-slate-800">{posMap.get(payslipItem.positionId) || '—'}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-emerald-800">EARNINGS</h4>
                <div className="flex justify-between text-xs">
                  <span>Base Salary:</span>
                  <span className="font-mono">{formatMoney(payslipItem.baseSalary)} EGP</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Allowances:</span>
                  <span className="font-mono">{formatMoney(payslipItem.totalAllowances)} EGP</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Bonus:</span>
                  <span className="font-mono">{formatMoney(payslipItem.bonus)} EGP</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Overtime:</span>
                  <span className="font-mono">{formatMoney(payslipItem.overtime)} EGP</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Commission:</span>
                  <span className="font-mono">{formatMoney(payslipItem.commissionTotal)} EGP</span>
                </div>
                <div className="flex justify-between border-t pt-2 font-bold text-xs text-slate-900">
                  <span>Gross Earnings:</span>
                  <span className="font-mono">{formatMoney(payslipItem.grossPay)} EGP</span>
                </div>
              </div>

              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-rose-800">DEDUCTIONS</h4>
                <div className="flex justify-between text-xs">
                  <span>Absence:</span>
                  <span className="font-mono">{formatMoney(payslipItem.absenceDeduction)} EGP</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Late:</span>
                  <span className="font-mono">{formatMoney(payslipItem.lateDeduction)} EGP</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Advance Recovery:</span>
                  <span className="font-mono">{formatMoney(payslipItem.advanceRecovery)} EGP</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Other Deductions:</span>
                  <span className="font-mono">{formatMoney(payslipItem.otherDeductions)} EGP</span>
                </div>
                <div className="flex justify-between border-t pt-2 font-bold text-xs text-rose-900">
                  <span>Total Deductions:</span>
                  <span className="font-mono">{formatMoney(payslipItem.totalDeductions)} EGP</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl bg-slate-900 p-4 font-extrabold text-white">
              <span>NET SALARY PAYABLE:</span>
              <span className="font-mono text-lg">{formatMoney(payslipItem.netPayable)} EGP</span>
            </div>

            <div className="flex justify-between pt-8 text-[11px] text-slate-400">
              <div>
                <span>Employee Signature: __________________</span>
              </div>
              <div>
                <span>Approved By: __________________</span>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* CONFIRMATION MODALS */}
      {confirmState && (
        <ConfirmDialog
          open={Boolean(confirmState)}
          onClose={() => setConfirmState(null)}
          title={confirmState.title}
          message={confirmState.message}
          onConfirm={() => {
            if (confirmState.action === 'review') handleTransition('REVIEW')
            if (confirmState.action === 'approve') handleTransition('APPROVED')
            if (confirmState.action === 'post') handlePostGL()
          }}
          busy={busy}
        />
      )}

      {/* POSTING RESULT MODAL */}
      {postingResult && (
        <Modal
          open={Boolean(postingResult)}
          onClose={() => setPostingResult(null)}
          title="✓ Payroll Posted to General Ledger"
          footer={
            <Button variant="primary" onClick={() => setPostingResult(null)}>
              Done
            </Button>
          }
        >
          <div className="space-y-4 text-sm">
            <div className="rounded-2xl bg-emerald-50 p-4 text-emerald-900 border border-emerald-200">
              <p className="font-bold">Posting Status: POSTED</p>
              <p className="mt-1 font-mono text-xs">
                GL Transaction ID: <span className="font-bold">{postingResult.transactionId}</span>
              </p>
            </div>

            <div className="space-y-2">
              <h4 className="font-bold text-slate-800">Accounting GL Summary Impact:</h4>
              <ul className="space-y-1 font-mono text-xs text-slate-600 bg-slate-50 p-3 rounded-xl border">
                <li>Salary Expense → 5201: {formatMoney(totals.totalGross)} EGP</li>
                <li>Commission Expense → 5105: {formatMoney(totals.totalCommission)} EGP</li>
                <li>Employee Payable → 210201: {formatMoney(totals.totalNet)} EGP</li>
                <li>Advance Recovery → 110203: {formatMoney(totals.totalAdvanceRecovery)} EGP</li>
              </ul>
            </div>
          </div>
        </Modal>
      )}

      {/* PRINT PORTAL DOCUMENT FOR MEDIA PRINT */}
      <PrintDocument>
        <ReportPrintHeader
          title={`PAYROLL SUMMARY REPORT (${periodId})`}
          subtitle={`Status: ${payrollRun?.status || 'N/A'}`}
        />

        <div className="mb-6 grid grid-cols-4 gap-4 border p-4 text-xs font-mono">
          <div>
            <span>Employees:</span> <strong>{totals.itemCount}</strong>
          </div>
          <div>
            <span>Gross Payroll:</span> <strong>{formatMoney(totals.totalGross)} EGP</strong>
          </div>
          <div>
            <span>Total Deductions:</span> <strong>{formatMoney(totals.totalDeductions)} EGP</strong>
          </div>
          <div>
            <span>Net Payroll:</span> <strong>{formatMoney(totals.totalNet)} EGP</strong>
          </div>
        </div>

        <table className="w-full text-start text-xs">
          <thead>
            <tr className="border-b-2 border-slate-900 font-bold">
              <th className="py-2 text-start">Code</th>
              <th className="py-2 text-start">Employee</th>
              <th className="py-2 text-end">Base</th>
              <th className="py-2 text-end">Allowances</th>
              <th className="py-2 text-end">Bonus</th>
              <th className="py-2 text-end">Gross</th>
              <th className="py-2 text-end">Deductions</th>
              <th className="py-2 text-end">Net Pay</th>
            </tr>
          </thead>
          <tbody>
            {payrollItems.map((item) => (
              <tr key={item.id} className="border-b border-slate-200">
                <td className="py-1 font-mono">{item.employeeCode}</td>
                <td className="py-1 font-bold">{item.employeeName}</td>
                <td className="py-1 text-end font-mono">{formatMoney(item.baseSalary)}</td>
                <td className="py-1 text-end font-mono">{formatMoney(item.totalAllowances)}</td>
                <td className="py-1 text-end font-mono">{formatMoney(item.bonus)}</td>
                <td className="py-1 text-end font-mono font-bold">{formatMoney(item.grossPay)}</td>
                <td className="py-1 text-end font-mono text-rose-700">{formatMoney(item.totalDeductions)}</td>
                <td className="py-1 text-end font-mono font-extrabold">{formatMoney(item.netPayable)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PrintDocument>
    </div>
  )
}
