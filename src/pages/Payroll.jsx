import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { COL, useCollection, useSettings } from '../lib/db'
import { ACCOUNTS_COL } from '../lib/accounts'
import { JOB_COSTS_COL } from './Vendors'
import { formatDate, formatMoney, round2, todayISO, toNumber } from '../lib/format'
import { calculateEmployeeTieredCommission, invoiceFees, monthlyTargetBonus } from '../lib/costing'
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
  const { rows: entries } = useCollection(COL.employeeEntries, 'date', 'desc')
  const { rows: invoices } = useCollection(COL.invoices, 'date', 'desc')
  const { rows: vouchers } = useCollection(COL.vouchers, 'date', 'desc')

  // 2. Period Selection State
  const defaultMonthStr = todayISO().slice(0, 7)
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

  const [busy, setBusy] = useState(false)
  const [notification, setNotification] = useState(null) // { type: 'success'|'error', text: '' }
  const [confirmState, setConfirmState] = useState(null) // { action: 'review'|'approve'|'post', title: '', message: '' }
  const [postingResult, setPostingResult] = useState(null)

  const deptMap = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments])
  const posMap = useMemo(() => new Map(positions.map((p) => [p.id, p.title])), [positions])

  const accountMap = useMemo(() => new Map(accounts.map((d) => [d.id, d])), [accounts])

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
          const acc = accountMap.get(l.accountId)
          const isAcc =
            acc?.code === '110203' ||
            String(acc?.code).startsWith('110203') ||
            acc?.role === 'employeeAdvance' ||
            l.accountId === '110203' ||
            String(l.code) === '110203'

          const isEmp =
            l.subledgerId === subledgerCode ||
            l.subledger === subledgerCode ||
            l.subLedgerId === subledgerCode ||
            (l.subLedgerType === 'employee' && (
              l.subLedgerId === emp.id ||
              l.subLedgerId === subledgerCode ||
              String(l.subLedgerId).replace(/^emp-(payable|advance)-/, '') === emp.id
            )) ||
            l.employeeId === emp.id ||
            (l.subLedgerName && l.subLedgerName.trim().toLowerCase() === emp.name?.trim().toLowerCase())

          if (isAcc && isEmp) {
            debits += Number(l.debit) || 0
            credits += Number(l.credit) || 0
          }
        })
      })

      // Also scan vouchers (journalEntries) in case they exist directly
      vouchers.forEach((v) => {
        if (!v.lines) return
        v.lines.forEach((l) => {
          const acc = accountMap.get(l.accountId)
          const isAcc =
            acc?.code === '110203' ||
            String(acc?.code).startsWith('110203') ||
            acc?.role === 'employeeAdvance' ||
            l.accountId === '110203' ||
            String(l.code) === '110203'

          const isEmp =
            (l.subLedgerType === 'employee' && (
              l.subLedgerId === emp.id ||
              l.subLedgerId === subledgerCode ||
              String(l.subLedgerId).replace(/^emp-(payable|advance)-/, '') === emp.id
            )) ||
            l.employeeId === emp.id ||
            (l.subLedgerName && l.subLedgerName.trim().toLowerCase() === emp.name?.trim().toLowerCase())

          if (isAcc && isEmp && !accountingTransactions.some((tx) => tx.sourceId === v.id)) {
            debits += Number(l.debit) || 0
            credits += Number(l.credit) || 0
          }
        })
      })

      balancesMap.set(emp.id, Math.max(0, roundMoney(debits - credits)))
    })
    return balancesMap
  }, [employees, accountingTransactions, vouchers, accountMap])

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
          const acc = accountMap.get(l.accountId)
          const isAcc =
            acc?.code === '210201' ||
            String(acc?.code).startsWith('210201') ||
            acc?.role === 'employeePayable' ||
            l.accountId === '210201' ||
            String(l.code) === '210201'

          const isEmp =
            l.subledgerId === subledgerCode ||
            l.subledger === subledgerCode ||
            l.subLedgerId === subledgerCode ||
            (l.subLedgerType === 'employee' && (
              l.subLedgerId === emp.id ||
              l.subLedgerId === subledgerCode ||
              String(l.subLedgerId).replace(/^emp-(payable|advance)-/, '') === emp.id
            )) ||
            l.employeeId === emp.id ||
            (l.subLedgerName && l.subLedgerName.trim().toLowerCase() === emp.name?.trim().toLowerCase())

          if (isAcc && isEmp) {
            debits += Number(l.debit) || 0
            credits += Number(l.credit) || 0
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
  }, [employees, accountingTransactions, accountMap])

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

  const getStatusLabel = useCallback(
    (status) => {
      if (!status) return t('payroll.status.no_run')
      const key = `payroll.status.${status.toLowerCase()}`
      return t(key)
    },
    [t]
  )

  // 5. Gather Payroll Engine Inputs
  const buildPayrollInputsForEmployees = useCallback(() => {
    const monthKeyStr = selectedMonth || `${year}-${String(month).padStart(2, '0')}`

    return employees
      .filter((emp) => emp.status !== 'archived')
      .map((emp) => {
        const itemOverride = editInputs[emp.id] || {}
        const existingItem = payrollItems.find((i) => i.employeeId === emp.id) || {}

        // 1. Commission from jobCosts for this employee
        const cancelledInvoiceIds = new Set(invoices.filter((inv) => inv.cancelled).map((inv) => inv.id))
        const empJobCosts = jobCosts.filter(
          (j) => j.employeeId === emp.id && (j.type === 'commission' || Number(j.amount || j.commissionAmount || 0) > 0) && (!j.payrollRunId || j.payrollRunId === periodId) && (!j.invoiceId || !cancelledInvoiceIds.has(j.invoiceId))
        )

        const commissionItems = empJobCosts.map((j) => ({
          jobCostId: j.id,
          amount: Number(j.amount || j.commissionAmount) || 0,
          prePosted: Boolean(j.postedToGL || j.paid),
        }))

        // 2. Entries from employeeEntries for this month
        const empMonthEntries = entries.filter(
          (e) => e.employeeId === emp.id && (e.date?.slice(0, 7) === monthKeyStr)
        )

        let entriesBonus = 0
        let entriesRaise = 0
        let entriesDeduction = 0

        empMonthEntries.forEach((e) => {
          const amt = Number(e.amount) || 0
          if (e.type === 'bonus') entriesBonus += amt
          else if (e.type === 'raise') entriesRaise += amt
          else if (e.type === 'commission') {
            commissionItems.push({
              jobCostId: `entry_${e.id}`,
              amount: amt,
              prePosted: Boolean(e.paid),
            })
          }
          else if (e.type === 'deduction') entriesDeduction += amt
        })

        // 3. Target Bonus & Tiered Commission from invoices for this month
        const targetBonus = monthlyTargetBonus(emp, invoices, monthKeyStr)?.earned || 0
        const monthInvoices = invoices.filter(
          (inv) => inv.employeeId === emp.id && !inv.cancelled && inv.date?.slice(0, 7) === monthKeyStr
        )
        const totalSales = monthInvoices.reduce((sum, inv) => sum + invoiceFees(inv), 0)
        const tierCommission = calculateEmployeeTieredCommission(emp, totalSales)?.totalCommission || 0

        if (commissionItems.length === 0 && tierCommission > 0) {
          commissionItems.push({
            jobCostId: 'sales_tier_commission',
            amount: tierCommission,
            prePosted: false,
          })
        }

        const totalCalculatedBonus = roundMoney(entriesBonus + entriesRaise + targetBonus)
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
          bonus:
            itemOverride.bonus !== undefined
              ? itemOverride.bonus
              : (existingItem.bonus !== undefined ? existingItem.bonus : totalCalculatedBonus),
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
                : (existingItem.advanceRecoveryRequested !== undefined ? existingItem.advanceRecoveryRequested : advBalance),
            outstandingBalance: advBalance,
          },
          otherDeductions:
            itemOverride.otherDeductions !== undefined
              ? itemOverride.otherDeductions
              : (existingItem.otherDeductions !== undefined ? existingItem.otherDeductions : entriesDeduction),
        }
      })
  }, [employees, editInputs, payrollItems, jobCosts, entries, invoices, employeeAdvanceBalances, selectedMonth, year, month, periodId])

  // 6. Action Handlers
  const handleCreateRun = async () => {
    if (!isCutoverValid) {
      setNotification({
        type: 'error',
        text: t('payroll.cutoverMessage', { month: PAYROLL_CUTOVER_MONTH }),
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
      t('payroll.th.code'),
      t('payroll.th.employee'),
      t('positions.department'),
      t('positions.name'),
      t('payroll.th.baseSalary'),
      t('payroll.th.allowances'),
      t('payroll.th.bonus'),
      t('payroll.th.overtime'),
      t('payroll.th.commission'),
      t('payroll.th.gross'),
      t('payroll.th.deductions'),
      t('payroll.th.advRecovery'),
      t('payroll.th.netPay'),
      t('payroll.th.status'),
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
        title={t('payroll.title')}
        subtitle={t('payroll.subtitle')}
      >
        <div className="flex flex-wrap items-center gap-3">
          {/* Period Selector */}
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 shadow-xs">
            <span className="text-xs font-semibold text-slate-500">{t('payroll.period')}</span>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="bg-transparent text-sm font-bold text-slate-800 outline-hidden cursor-pointer"
            />
          </div>

          {/* Lifecycle Status Badge */}
          <Badge tone={statusTone(payrollRun?.status || 'NO RUN')}>
            {getStatusLabel(payrollRun?.status)}
          </Badge>

          {/* Export CSV */}
          {payrollItems.length > 0 && (
            <Button variant="ghost" onClick={exportPayrollCSV}>
              {t('payroll.exportCsv')}
            </Button>
          )}

          {/* Print Report */}
          {payrollRun && (
            <Button variant="ghost" onClick={() => window.print()}>
              {t('payroll.printReport')}
            </Button>
          )}

          {/* Dynamic Lifecycle Buttons */}
          {!payrollRun && (
            <Button
              variant="primary"
              onClick={handleCreateRun}
              disabled={busy || !isCutoverValid}
            >
              {t('payroll.createRun')}
            </Button>
          )}

          {payrollRun && isEditable && (
            <Button variant="ghost" onClick={handleRecalculate} disabled={busy}>
              {t('payroll.recalculate')}
            </Button>
          )}

          {payrollRun?.status === 'CALCULATED' && (
            <Button
              variant="primary"
              onClick={() =>
                setConfirmState({
                  action: 'review',
                  title: t('payroll.confirmReviewTitle', { periodId }),
                  message: t('payroll.confirmReviewMsg'),
                })
              }
              disabled={busy}
            >
              {t('payroll.submitReview')}
            </Button>
          )}

          {payrollRun?.status === 'REVIEW' && (
            <Button
              variant="primary"
              onClick={() =>
                setConfirmState({
                  action: 'approve',
                  title: t('payroll.confirmApproveTitle', { periodId }),
                  message: t('payroll.confirmApproveMsg'),
                })
              }
              disabled={busy}
            >
              {t('payroll.approve')}
            </Button>
          )}

          {(payrollRun?.status === 'APPROVED' || payrollRun?.status === 'POSTING') && (
            <Button
              variant="primary"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() =>
                setConfirmState({
                  action: 'post',
                  title: t('payroll.confirmPostTitle', { periodId }),
                  message: t('payroll.confirmPostMsg'),
                })
              }
              disabled={busy}
            >
              {t('payroll.postGl')}
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
          {t('payroll.tab.operations')}
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
          {t('payroll.tab.reconciliation')}
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
          {t('payroll.tab.statements')}
        </button>
      </div>

      {/* NOTIFICATION BANNER */}
      {notification && (
        <div
          className={`flex items-center justify-between rounded-2xl px-5 py-4 text-sm font-semibold shadow-xs ${
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
            ✕
          </button>
        </div>
      )}

      {/* CUTOVER RESTRICTION WARNING */}
      {!isCutoverValid && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          <p className="font-bold">{t('payroll.cutoverTitle')}</p>
          <p className="mt-1 text-xs">
            {t('payroll.cutoverMessage', { month: PAYROLL_CUTOVER_MONTH })}
          </p>
        </div>
      )}

      {/* SUMMARY STAT CARDS */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label={t('payroll.stat.employees')} value={totals.itemCount} />
        <StatCard label={t('payroll.stat.gross')} value={formatMoney(totals.totalGross)} suffix={t('common.currency')} />
        <StatCard label={t('payroll.stat.deductions')} value={formatMoney(totals.totalDeductions)} suffix={t('common.currency')} />
        <StatCard label={t('payroll.stat.net')} value={formatMoney(totals.totalNet)} suffix={t('common.currency')} tone="text-emerald-600 bg-emerald-50" />
        <StatCard label={t('payroll.stat.commission')} value={formatMoney(totals.totalCommission)} suffix={t('common.currency')} />
        <StatCard label={t('payroll.stat.advanceRecovery')} value={formatMoney(totals.totalAdvanceRecovery)} suffix={t('common.currency')} />
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
                placeholder={t('payroll.searchPlaceholder')}
              />

              <Select
                value={selectedDept}
                onChange={(e) => setSelectedDept(e.target.value)}
                className="w-48"
              >
                <option value="all">{t('payroll.filterAllDepts')}</option>
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
                <option value="all">{t('payroll.filterAllItems')}</option>
                <option value="warnings">{t('payroll.filterWarnings')}</option>
                <option value="clean">{t('payroll.filterClean')}</option>
              </Select>
            </div>

            {payrollRun && (
              <p className="text-xs font-semibold text-slate-400">
                {t('payroll.runVersionInfo', {
                  version: payrollRun.version || 1,
                  updatedAt: payrollRun.updatedAt?.toDate ? formatDate(payrollRun.updatedAt.toDate()) : '—',
                })}
              </p>
            )}
          </div>

          {/* MAIN PAYROLL TABLE OR EMPTY STATE */}
          {!payrollRun ? (
            <EmptyState
              title={t('payroll.emptyRunTitle')}
              message={t('payroll.emptyRunMessage', { periodId })}
              action={
                <Button
                  variant="primary"
                  onClick={handleCreateRun}
                  disabled={busy || !isCutoverValid}
                >
                  {t('payroll.createRun')} ({periodId})
                </Button>
              }
            />
          ) : filteredItems.length === 0 ? (
            <EmptyState
              title={t('payroll.emptyItemsTitle')}
              message={t('payroll.emptyItemsMessage')}
            />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>{t('payroll.th.code')}</Th>
                  <Th>{t('payroll.th.employee')}</Th>
                  <Th>{t('payroll.th.deptPos')}</Th>
                  <Th className="text-end">{t('payroll.th.baseSalary')}</Th>
                  <Th className="text-end">{t('payroll.th.allowances')}</Th>
                  <Th className="text-end">{t('payroll.th.bonus')}</Th>
                  <Th className="text-end">{t('payroll.th.overtime')}</Th>
                  <Th className="text-end">{t('payroll.th.commission')}</Th>
                  <Th className="text-end">{t('payroll.th.gross')}</Th>
                  <Th className="text-end">{t('payroll.th.deductions')}</Th>
                  <Th className="text-end">{t('payroll.th.advRecovery')}</Th>
                  <Th className="text-end">{t('payroll.th.netPay')}</Th>
                  <Th>{t('payroll.th.status')}</Th>
                  <Th className="text-center">{t('payroll.th.actions')}</Th>
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
                          <Badge tone="amber">{t('payroll.warningsBadge', { count: warnings.length })}</Badge>
                        ) : (
                          <Badge tone="green">{t('payroll.cleanBadge')}</Badge>
                        )}
                      </Td>
                      <Td className="text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <Button
                            variant="ghost"
                            className="px-2 py-1 text-xs"
                            onClick={() => setActiveItem(item)}
                          >
                            {isEditable ? t('payroll.editView') : t('payroll.viewDetails')}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-2 py-1 text-xs text-brand-600"
                            onClick={() => setPayslipItem(item)}
                          >
                            {t('payroll.payslipBtn')}
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
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xs">
            <h3 className="text-base font-bold text-slate-900">
              {t('payroll.rec.title', { periodId })}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {t('payroll.rec.subtitle')}
            </p>

            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
              {/* Debit Entries */}
              <div className="space-y-3 rounded-2xl border border-emerald-100 bg-emerald-50/50 p-5">
                <h4 className="text-xs font-extrabold uppercase tracking-wider text-emerald-900">
                  {t('payroll.rec.debitTitle')}
                </h4>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-slate-700">{t('payroll.rec.salaryExp')}</span>
                  <span className="font-mono font-extrabold text-emerald-800">
                    {formatMoney(reconciliationData.salaryExpense5201)} {t('common.currency')}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-slate-700">{t('payroll.rec.commExp')}</span>
                  <span className="font-mono font-extrabold text-emerald-800">
                    {formatMoney(reconciliationData.commissionExpense5105)} {t('common.currency')}
                  </span>
                </div>
                <div className="border-t border-emerald-200 pt-3 flex justify-between font-extrabold text-base text-emerald-950">
                  <span>{t('payroll.rec.totalDebits')}</span>
                  <span className="font-mono">{formatMoney(reconciliationData.totalDebits)} {t('common.currency')}</span>
                </div>
              </div>

              {/* Credit Entries */}
              <div className="space-y-3 rounded-2xl border border-sky-100 bg-sky-50/50 p-5">
                <h4 className="text-xs font-extrabold uppercase tracking-wider text-sky-900">
                  {t('payroll.rec.creditTitle')}
                </h4>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-slate-700">{t('payroll.rec.empPayable')}</span>
                  <span className="font-mono font-extrabold text-sky-800">
                    {formatMoney(reconciliationData.employeePayable210201)} {t('common.currency')}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-slate-700">{t('payroll.rec.advRecovery')}</span>
                  <span className="font-mono font-extrabold text-sky-800">
                    {formatMoney(reconciliationData.advanceRecovery110203)} {t('common.currency')}
                  </span>
                </div>
                <div className="border-t border-sky-200 pt-3 flex justify-between font-extrabold text-base text-sky-950">
                  <span>{t('payroll.rec.totalCredits')}</span>
                  <span className="font-mono">{formatMoney(reconciliationData.totalCredits)} {t('common.currency')}</span>
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
              <span>{t('payroll.rec.status')} {reconciliationData.isBalanced ? `✓ ${t('payroll.rec.balanced')}` : `✗ ${t('payroll.rec.error')}`}</span>
              <span className="font-mono">
                {t('payroll.rec.diff')} {formatMoney(Math.abs(reconciliationData.totalDebits - reconciliationData.totalCredits))} {t('common.currency')}
              </span>
            </div>

            {payrollRun?.status === 'POSTED' && (
              <div className="mt-4 text-xs font-mono text-slate-500">
                {t('payroll.rec.txId')} <span className="font-bold text-slate-800">emp_payroll_run_{periodId}</span>
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
              <span className="text-sm font-bold text-slate-700">{t('payroll.stmt.selectEmp')}</span>
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
                {t('payroll.stmt.openPayslip')}
              </Button>
            )}
          </div>

          {selectedStatementItem ? (
            <div className="space-y-6">
              {/* Employee Summary Card */}
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <h3 className="text-lg font-extrabold text-slate-900">{selectedStatementItem.employeeName}</h3>
                    <p className="text-xs text-slate-500 font-mono">
                      {t('payroll.th.code')}: {selectedStatementItem.employeeCode} · {t('positions.department')}: {deptMap.get(selectedStatementItem.departmentId) || '—'} · {t('positions.name')}: {posMap.get(selectedStatementItem.positionId) || '—'}
                    </p>
                  </div>
                  <Badge tone={statusTone(payrollRun?.status)}>{getStatusLabel(payrollRun?.status)}</Badge>
                </div>

                {/* Earnings & Deductions Breakdown */}
                <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="space-y-2 rounded-2xl bg-slate-50 p-4 border border-slate-100">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">{t('payroll.stmt.earningsBreakdown')}</h4>
                    <div className="flex justify-between text-xs">
                      <span>{t('payroll.th.baseSalary')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.baseSalary)} {t('common.currency')}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span>{t('payroll.th.allowances')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.totalAllowances)} {t('common.currency')}</span>
                    </div>
                    <div className="flex justify-between text-xs text-emerald-600">
                      <span>{t('payroll.th.bonus')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.bonus)} {t('common.currency')}</span>
                    </div>
                    <div className="flex justify-between text-xs text-emerald-600">
                      <span>{t('payroll.th.overtime')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.overtime)} {t('common.currency')}</span>
                    </div>
                    <div className="flex justify-between text-xs text-sky-600">
                      <span>{t('payroll.th.commission')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.commissionTotal)} {t('common.currency')}</span>
                    </div>
                    <div className="border-t pt-2 flex justify-between font-bold text-sm text-slate-900">
                      <span>{t('payroll.stmt.grossEarnings')}</span>
                      <span className="font-mono">{formatMoney(selectedStatementItem.grossPay)} {t('common.currency')}</span>
                    </div>
                  </div>

                  <div className="space-y-2 rounded-2xl bg-slate-50 p-4 border border-slate-100">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">{t('payroll.stmt.deductionsBreakdown')}</h4>
                    <div className="flex justify-between text-xs text-rose-600">
                      <span>{t('payroll.modal.absence')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.absenceDeduction)} {t('common.currency')}</span>
                    </div>
                    <div className="flex justify-between text-xs text-rose-600">
                      <span>{t('payroll.modal.late')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.lateDeduction)} {t('common.currency')}</span>
                    </div>
                    <div className="flex justify-between text-xs text-amber-600">
                      <span>{t('payroll.stat.advanceRecovery')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.advanceRecovery)} {t('common.currency')}</span>
                    </div>
                    <div className="flex justify-between text-xs text-rose-600">
                      <span>{t('payroll.modal.otherDeductions')}:</span>
                      <span className="font-mono font-bold">{formatMoney(selectedStatementItem.otherDeductions)} {t('common.currency')}</span>
                    </div>
                    <div className="border-t pt-2 flex justify-between font-bold text-sm text-rose-700">
                      <span>{t('payroll.stmt.totalDeductions')}</span>
                      <span className="font-mono">{formatMoney(selectedStatementItem.totalDeductions)} {t('common.currency')}</span>
                    </div>
                  </div>
                </div>

                {/* Net Salary Banner */}
                <div className="mt-6 flex items-center justify-between rounded-2xl bg-emerald-600 p-4 font-extrabold text-white">
                  <span className="text-base">{t('payroll.stmt.netSalary')}</span>
                  <span className="font-mono text-xl">{formatMoney(selectedStatementItem.netPayable)} {t('common.currency')}</span>
                </div>

                {/* Employee Subledger Payable Overview */}
                <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-900 p-4 text-white">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    {t('payroll.stmt.subledgerTitle', { empId: selectedStatementItem.employeeId })}
                  </h4>
                  <div className="mt-3 grid grid-cols-2 gap-4 text-xs font-mono">
                    <div>
                      <span className="text-slate-400">{t('payroll.stmt.creditsPosted')}</span>
                      <p className="text-sm font-bold text-emerald-400">
                        {formatMoney(employeePayableLedger.get(selectedStatementItem.employeeId)?.credits || 0)} {t('common.currency')}
                      </p>
                    </div>
                    <div>
                      <span className="text-slate-400">{t('payroll.stmt.debitsDisbursed')}</span>
                      <p className="text-sm font-bold text-sky-400">
                        {formatMoney(employeePayableLedger.get(selectedStatementItem.employeeId)?.debits || 0)} {t('common.currency')}
                      </p>
                    </div>
                    <div className="col-span-2 border-t border-slate-700 pt-2 flex justify-between">
                      <span className="text-slate-300 font-bold">{t('payroll.stmt.outstandingPayable')}</span>
                      <span className="text-sm font-bold text-emerald-400">
                        {formatMoney(employeePayableLedger.get(selectedStatementItem.employeeId)?.outstandingPayable || 0)} {t('common.currency')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState title={t('payroll.stmt.noEmpSelected')} message={t('payroll.stmt.selectEmpPrompt')} />
          )}
        </div>
      )}

      {/* EMPLOYEE DETAIL MODAL / EDIT DRAWER */}
      {activeItem && (
        <Modal
          open={Boolean(activeItem)}
          onClose={() => setActiveItem(null)}
          title={t('payroll.modal.editTitle', { name: activeItem.employeeName, code: activeItem.employeeCode })}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setActiveItem(null)}>
                {t('payroll.modal.close')}
              </Button>
              {isEditable && (
                <Button variant="primary" onClick={handleSaveModalItem} disabled={busy}>
                  {t('payroll.modal.saveRecalc')}
                </Button>
              )}
            </>
          }
        >
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 rounded-2xl bg-slate-50 p-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-slate-400">{t('payroll.modal.dept')}</p>
                <p className="text-sm font-bold text-slate-800">{deptMap.get(activeItem.departmentId) || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">{t('payroll.modal.position')}</p>
                <p className="text-sm font-bold text-slate-800">{posMap.get(activeItem.positionId) || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">{t('payroll.modal.runPeriod')}</p>
                <p className="text-sm font-bold text-slate-800">{activeItem.periodId}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">{t('payroll.modal.runStatus')}</p>
                <Badge tone={statusTone(payrollRun?.status)}>{getStatusLabel(payrollRun?.status)}</Badge>
              </div>
            </div>

            {(activeItem.warnings || []).length > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
                <p className="font-bold">{t('payroll.modal.warnings')}</p>
                <ul className="mt-1 list-disc ps-4 space-y-0.5">
                  {activeItem.warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-4 rounded-2xl border border-slate-100 p-4">
                <h4 className="text-sm font-bold text-slate-900">{t('payroll.modal.earningsHead')}</h4>

                <Field label={t('payroll.modal.baseSalary')}>
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

                <Field label={t('payroll.modal.bonus')}>
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

                <Field label={t('payroll.modal.overtime')}>
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
                    <span>{t('payroll.modal.totalAllowances')}</span>
                    <span className="font-mono font-bold text-slate-700">
                      {formatMoney(activeItem.totalAllowances)} {t('common.currency')}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500 mt-1">
                    <span>{t('payroll.modal.calculatedComm')}</span>
                    <span className="font-mono font-bold text-sky-600">
                      {formatMoney(activeItem.commissionTotal)} {t('common.currency')}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-4 rounded-2xl border border-slate-100 p-4">
                <h4 className="text-sm font-bold text-slate-900">{t('payroll.modal.deductionsHead')}</h4>

                <Field label={t('payroll.modal.absence')}>
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

                <Field label={t('payroll.modal.late')}>
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

                <Field label={t('payroll.modal.advRecoveryReq')}>
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
                    {t('payroll.modal.advBalance')} {formatMoney(activeItem.advanceOutstandingBalance || 0)} {t('common.currency')}
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
          title={t('payroll.payslip.modalTitle', { name: payslipItem.employeeName })}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setPayslipItem(null)}>
                {t('payroll.modal.close')}
              </Button>
              <Button variant="primary" onClick={() => window.print()}>
                {t('payroll.payslip.printBtn')}
              </Button>
            </>
          }
        >
          <div className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-xs">
            <ReportPrintHeader
              title={t('payroll.payslip.headerTitle')}
              subtitle={t('payroll.payslip.period', { periodId })}
            />

            <div className="grid grid-cols-2 gap-4 rounded-xl bg-slate-50 p-4 text-xs">
              <div>
                <span className="text-slate-400">{t('payroll.payslip.empName')}</span>
                <p className="font-bold text-slate-900">{payslipItem.employeeName}</p>
              </div>
              <div>
                <span className="text-slate-400">{t('payroll.payslip.empCode')}</span>
                <p className="font-mono font-bold text-slate-900">{payslipItem.employeeCode}</p>
              </div>
              <div>
                <span className="text-slate-400">{t('payroll.payslip.empDept')}</span>
                <p className="font-bold text-slate-800">{deptMap.get(payslipItem.departmentId) || '—'}</p>
              </div>
              <div>
                <span className="text-slate-400">{t('payroll.payslip.empPos')}</span>
                <p className="font-bold text-slate-800">{posMap.get(payslipItem.positionId) || '—'}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-emerald-800">{t('payroll.payslip.earnings')}</h4>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.th.baseSalary')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.baseSalary)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.th.allowances')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.totalAllowances)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.th.bonus')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.bonus)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.th.overtime')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.overtime)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.th.commission')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.commissionTotal)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between border-t pt-2 font-bold text-xs text-slate-900">
                  <span>{t('payroll.payslip.gross')}</span>
                  <span className="font-mono">{formatMoney(payslipItem.grossPay)} {t('common.currency')}</span>
                </div>
              </div>

              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-rose-800">{t('payroll.payslip.deductions')}</h4>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.modal.absence')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.absenceDeduction)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.modal.late')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.lateDeduction)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.stat.advanceRecovery')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.advanceRecovery)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{t('payroll.modal.otherDeductions')}:</span>
                  <span className="font-mono">{formatMoney(payslipItem.otherDeductions)} {t('common.currency')}</span>
                </div>
                <div className="flex justify-between border-t pt-2 font-bold text-xs text-rose-900">
                  <span>{t('payroll.payslip.totalDeductions')}</span>
                  <span className="font-mono">{formatMoney(payslipItem.totalDeductions)} {t('common.currency')}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl bg-slate-900 p-4 font-extrabold text-white">
              <span>{t('payroll.payslip.net')}</span>
              <span className="font-mono text-lg">{formatMoney(payslipItem.netPayable)} {t('common.currency')}</span>
            </div>

            <div className="flex justify-between pt-8 text-[11px] text-slate-400">
              <div>
                <span>{t('payroll.payslip.sigEmp')}</span>
              </div>
              <div>
                <span>{t('payroll.payslip.sigApp')}</span>
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
          title={`✓ ${t('payroll.postModal.title')}`}
          footer={
            <Button variant="primary" onClick={() => setPostingResult(null)}>
              {t('payroll.postModal.done')}
            </Button>
          }
        >
          <div className="space-y-4 text-sm">
            <div className="rounded-2xl bg-emerald-50 p-4 text-emerald-900 border border-emerald-200">
              <p className="font-bold">{t('payroll.postModal.status')}</p>
              <p className="mt-1 font-mono text-xs">
                {t('payroll.postModal.txId')} <span className="font-bold">{postingResult.transactionId}</span>
              </p>
            </div>

            <div className="space-y-2">
              <h4 className="font-bold text-slate-800">{t('payroll.postModal.summary')}</h4>
              <ul className="space-y-1 font-mono text-xs text-slate-600 bg-slate-50 p-3 rounded-xl border">
                <li>Salary Expense → 5201: {formatMoney(totals.totalGross)} {t('common.currency')}</li>
                <li>Commission Expense → 5105: {formatMoney(totals.totalCommission)} {t('common.currency')}</li>
                <li>Employee Payable → 210201: {formatMoney(totals.totalNet)} {t('common.currency')}</li>
                <li>Advance Recovery → 110203: {formatMoney(totals.totalAdvanceRecovery)} {t('common.currency')}</li>
              </ul>
            </div>
          </div>
        </Modal>
      )}

      {/* PRINT PORTAL DOCUMENT FOR MEDIA PRINT */}
      <PrintDocument>
        <ReportPrintHeader
          title={`${t('payroll.title')} (${periodId})`}
          subtitle={`Status: ${getStatusLabel(payrollRun?.status)}`}
        />

        <div className="mb-6 grid grid-cols-4 gap-4 border p-4 text-xs font-mono">
          <div>
            <span>{t('payroll.stat.employees')}:</span> <strong>{totals.itemCount}</strong>
          </div>
          <div>
            <span>{t('payroll.stat.gross')}:</span> <strong>{formatMoney(totals.totalGross)} {t('common.currency')}</strong>
          </div>
          <div>
            <span>{t('payroll.stat.deductions')}:</span> <strong>{formatMoney(totals.totalDeductions)} {t('common.currency')}</strong>
          </div>
          <div>
            <span>{t('payroll.stat.net')}:</span> <strong>{formatMoney(totals.totalNet)} {t('common.currency')}</strong>
          </div>
        </div>

        <table className="w-full text-start text-xs">
          <thead>
            <tr className="border-b-2 border-slate-900 font-bold">
              <th className="py-2 text-start">{t('payroll.th.code')}</th>
              <th className="py-2 text-start">{t('payroll.th.employee')}</th>
              <th className="py-2 text-end">{t('payroll.th.baseSalary')}</th>
              <th className="py-2 text-end">{t('payroll.th.allowances')}</th>
              <th className="py-2 text-end">{t('payroll.th.bonus')}</th>
              <th className="py-2 text-end">{t('payroll.th.gross')}</th>
              <th className="py-2 text-end">{t('payroll.th.deductions')}</th>
              <th className="py-2 text-end">{t('payroll.th.netPay')}</th>
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
