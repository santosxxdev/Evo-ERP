import { collection, doc, runTransaction, serverTimestamp } from 'firebase/firestore'
import { db } from './firebase'
import { COL } from './db'
import { requireRole, validatePeriod } from './accounting'
import { round2, toNumber } from './format'

/**
 * 1. ترحيل استحقاق المرتب الشهري للموظف إلى شجرة الحسابات العامة
 * Dr 5201 Salaries Expense
 * Cr 210201 Employee Payroll Payable (subledger = emp-payable-{employeeId})
 */
export async function postSalaryAccrual({
  employeeId,
  employeeName,
  amount,
  year,
  month,
  uid = null,
  accounts = [],
  settings = {},
}) {
  const numAmount = round2(toNumber(amount))
  if (numAmount <= 0) {
    throw new Error('Accounting Error: Salary accrual amount must be greater than zero.')
  }
  if (!employeeId) {
    throw new Error('Accounting Error: Missing employeeId for salary accrual posting.')
  }

  const yearNum = Number(year) || new Date().getFullYear()
  const monthNum = Number(month) || new Date().getMonth() + 1
  const monthKeyStr = String(monthNum).padStart(2, '0')
  const periodDate = `${yearNum}-${monthKeyStr}-28`

  validatePeriod(periodDate, settings)

  const salaryExpenseAcct = requireRole(accounts, 'salaryExpense', 'Salary Accrual Posting')
  const employeePayableAcct = requireRole(accounts, 'employeePayable', 'Salary Accrual Posting')

  const deterministicId = `emp_salary_${employeeId}_${yearNum}_${monthKeyStr}`
  const txRef = doc(db, COL.accountingTransactions, deterministicId)

  return await runTransaction(db, async (t) => {
    const existing = await t.get(txRef)
    if (existing.exists()) {
      return {
        created: false,
        transactionId: existing.id,
        existingData: existing.data(),
        message: 'Salary accrual already posted for this period.',
      }
    }

    const payload = {
      idempotencyKey: `employee_salary:${employeeId}:${yearNum}-${monthKeyStr}:post`,
      transactionDate: periodDate,
      sourceType: 'employee_salary',
      sourceId: `${employeeId}_${yearNum}_${monthKeyStr}`,
      action: 'accrual',
      lines: [
        {
          accountId: salaryExpenseAcct.id,
          accountCode: salaryExpenseAcct.code || '5201',
          debit: numAmount,
          credit: 0,
        },
        {
          accountId: employeePayableAcct.id,
          accountCode: employeePayableAcct.code || '210201',
          debit: 0,
          credit: numAmount,
          subLedgerType: 'employee',
          subLedgerId: `emp-payable-${employeeId}`,
          subLedgerName: employeeName || '',
        },
      ],
      totalDebit: numAmount,
      totalCredit: numAmount,
      status: 'posted',
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    }

    t.set(txRef, payload)

    return {
      created: true,
      transactionId: txRef.id,
      message: 'Salary accrual posted successfully.',
    }
  })
}

/**
 * 2. ترحيل عمولة المبيعات المستحقة للموظف إلى شجرة الحسابات العامة
 * Dr 5105 Commission Expense
 * Cr 210201 Employee Payroll Payable (subledger = emp-payable-{employeeId})
 * sourceType = jobCosts / sourceId = jobCost.id (يتوافق 100% مع ledger.js)
 */
export async function postCommissionToAccounting({
  jobCost,
  employeeId,
  employeeName,
  uid = null,
  accounts = [],
  settings = {},
}) {
  if (!jobCost || !jobCost.id) {
    throw new Error('Accounting Error: Invalid jobCost object provided.')
  }
  const numAmount = round2(toNumber(jobCost.amount))
  if (numAmount <= 0) {
    throw new Error('Accounting Error: Commission amount must be greater than zero.')
  }
  const targetEmployeeId = jobCost.employeeId || employeeId
  if (!targetEmployeeId) {
    throw new Error('Accounting Error: Missing employee ID for commission posting.')
  }

  const txDate = jobCost.date || new Date().toISOString().slice(0, 10)
  validatePeriod(txDate, settings)

  const commissionExpenseAcct = requireRole(accounts, 'costCommission', 'Commission Posting')
  const employeePayableAcct = requireRole(accounts, 'employeePayable', 'Commission Posting')

  const deterministicId = `jobCosts_${jobCost.id}`
  const txRef = doc(db, COL.accountingTransactions, deterministicId)

  return await runTransaction(db, async (t) => {
    const existing = await t.get(txRef)
    if (existing.exists()) {
      return {
        created: false,
        transactionId: existing.id,
        existingData: existing.data(),
        message: 'Commission already posted for this job cost.',
      }
    }

    const payload = {
      idempotencyKey: `jobCosts:${jobCost.id}:post`,
      transactionDate: txDate,
      sourceType: 'jobCosts',
      sourceId: jobCost.id,
      action: 'commission_post',
      lines: [
        {
          accountId: commissionExpenseAcct.id,
          accountCode: commissionExpenseAcct.code || '5105',
          debit: numAmount,
          credit: 0,
        },
        {
          accountId: employeePayableAcct.id,
          accountCode: employeePayableAcct.code || '210201',
          debit: 0,
          credit: numAmount,
          subLedgerType: 'employee',
          subLedgerId: `emp-payable-${targetEmployeeId}`,
          subLedgerName: employeeName || '',
        },
      ],
      totalDebit: numAmount,
      totalCredit: numAmount,
      status: 'posted',
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    }

    t.set(txRef, payload)

    return {
      created: true,
      transactionId: txRef.id,
      message: 'Commission posted to accounting successfully.',
    }
  })
}

/**
 * 3. ترحيل استقطاع/تسوية السلفة المخصومة من مستحقات الموظف
 * Dr 210201 Employee Payroll Payable (subledger = emp-payable-{employeeId})
 * Cr 110203 Employee Advance (subledger = emp-advance-{employeeId})
 */
export async function postAdvanceRecovery({
  employeeId,
  employeeName,
  amount,
  year,
  month,
  sourceId = null,
  uid = null,
  accounts = [],
  settings = {},
}) {
  const numAmount = round2(toNumber(amount))
  if (numAmount <= 0) {
    throw new Error('Accounting Error: Advance recovery amount must be greater than zero.')
  }
  if (!employeeId) {
    throw new Error('Accounting Error: Missing employeeId for advance recovery posting.')
  }

  const yearNum = Number(year) || new Date().getFullYear()
  const monthNum = Number(month) || new Date().getMonth() + 1
  const monthKeyStr = String(monthNum).padStart(2, '0')
  const periodDate = `${yearNum}-${monthKeyStr}-28`

  validatePeriod(periodDate, settings)

  const employeePayableAcct = requireRole(accounts, 'employeePayable', 'Advance Recovery Posting')
  const employeeAdvanceAcct = requireRole(accounts, 'employeeAdvance', 'Advance Recovery Posting')

  const deterministicId = sourceId
    ? `emp_advance_rec_${sourceId}`
    : `emp_advance_rec_${employeeId}_${yearNum}_${monthKeyStr}`
  const txRef = doc(db, COL.accountingTransactions, deterministicId)

  return await runTransaction(db, async (t) => {
    const existing = await t.get(txRef)
    if (existing.exists()) {
      return {
        created: false,
        transactionId: existing.id,
        existingData: existing.data(),
        message: 'Advance recovery already posted for this period.',
      }
    }

    const payload = {
      idempotencyKey: `employee_advance_recovery:${employeeId}:${yearNum}-${monthKeyStr}:post`,
      transactionDate: periodDate,
      sourceType: 'employee_advance_recovery',
      sourceId: sourceId || `${employeeId}_${yearNum}_${monthKeyStr}`,
      action: 'advance_recovery',
      lines: [
        {
          accountId: employeePayableAcct.id,
          accountCode: employeePayableAcct.code || '210201',
          debit: numAmount,
          credit: 0,
          subLedgerType: 'employee',
          subLedgerId: `emp-payable-${employeeId}`,
          subLedgerName: employeeName || '',
        },
        {
          accountId: employeeAdvanceAcct.id,
          accountCode: employeeAdvanceAcct.code || '110203',
          debit: 0,
          credit: numAmount,
          subLedgerType: 'employee',
          subLedgerId: `emp-advance-${employeeId}`,
          subLedgerName: employeeName || '',
        },
      ],
      totalDebit: numAmount,
      totalCredit: numAmount,
      status: 'posted',
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    }

    t.set(txRef, payload)

    return {
      created: true,
      transactionId: txRef.id,
      message: 'Advance recovery posted to accounting successfully.',
    }
  })
}
