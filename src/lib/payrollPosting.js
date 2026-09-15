/**
 * PAYROLL CONSOLIDATED GL POSTING ENGINE (PHASE 3B-3)
 *
 * Handles consolidated GL posting for approved Payroll Runs.
 *
 * ABSOLUTE SAFETY RULES:
 * - Deterministic GL ID: emp_payroll_run_{periodId}
 * - Pure lifecycle transition: APPROVED -> POSTING -> POSTED -> LOCKED
 * - NO modification of historical 16 GL transactions.
 * - NO modification of ledger.js, costing.js, accounts.js, db.js, employeeAccounting.js, accounting.js.
 * - Enforces zero double-posting for pre-posted commissions and salary accruals.
 * - Enforces exact GL debit/credit balance before commit.
 */

import {
  doc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  runTransaction,
  serverTimestamp
} from 'firebase/firestore';
import { db } from './firebase.js';
import { COL } from './db.js';
import { requireRole, validatePeriod, validateTransaction } from './accounting.js';
import { roundMoney } from './payrollEngine.js';
import {
  getPayrollRun,
  getPayrollItems,
  transitionPayrollRun,
  isPeriodOnOrAfterCutover
} from './payrollService.js';

/**
 * Posts a consolidated Payroll Run to the General Ledger (accountingTransactions).
 *
 * @param {Object} params
 * @param {string} params.periodId - e.g. "2026_10"
 * @param {string} [params.postedBy] - User ID or username
 * @param {string} [params.transactionDate] - Optional posting date (YYYY-MM-DD)
 * @param {Array<Object>} [params.accounts] - Chart of Accounts array
 * @param {Object} [params.settings] - Company settings object
 * @returns {Promise<Object>} GL Posting summary
 */
export async function postPayrollRun({
  periodId,
  postedBy = 'system',
  transactionDate = null,
  accounts = [],
  settings = {}
}) {
  if (!periodId) {
    throw new Error('Accounting Error: Missing periodId for payroll GL posting.');
  }

  // 1. Cutover validation
  if (!isPeriodOnOrAfterCutover(periodId)) {
    throw new Error(
      `Accounting Error: Payroll GL posting is strictly forbidden for period ${periodId} prior to cutover month 2026-10.`
    );
  }

  // 2. Fetch Payroll Run and Items
  const run = await getPayrollRun(periodId);
  if (!run) {
    throw new Error(`Accounting Error: Payroll run ${periodId} does not exist.`);
  }

  // Idempotency check: If already POSTED or LOCKED, return existing GL status
  const deterministicGlId = `emp_payroll_run_${periodId}`;
  const glRef = doc(db, COL.accountingTransactions, deterministicGlId);
  const existingGlSnap = await getDoc(glRef);

  if (run.status === 'POSTED' || run.status === 'LOCKED') {
    if (existingGlSnap.exists()) {
      const existingData = existingGlSnap.data();
      if (
        existingData.sourceType === 'payrollRun' &&
        existingData.sourceId === periodId &&
        existingData.totalDebit === existingData.totalCredit
      ) {
        return {
          created: false,
          transactionId: existingGlSnap.id,
          status: run.status,
          alreadyPosted: true,
          message: `Payroll run ${periodId} is already posted to GL.`
        };
      }
    }
  }

  // Precondition: Run status must be APPROVED or POSTING (for recovery)
  if (run.status !== 'APPROVED' && run.status !== 'POSTING') {
    throw new Error(
      `Accounting Error: Cannot post payroll run ${periodId} in status "${run.status}". Run must be APPROVED.`
    );
  }

  const items = await getPayrollItems(periodId);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`Accounting Error: Payroll run ${periodId} has no calculated payroll items.`);
  }

  // Reconcile items totals against run totals
  const sumGross = items.reduce((s, i) => s + (i.grossPay || 0), 0);
  const sumDeductions = items.reduce((s, i) => s + (i.totalDeductions || 0), 0);
  const sumNet = items.reduce((s, i) => s + (i.netPayable || 0), 0);

  if (
    roundMoney(sumGross) !== roundMoney(run.totalGross) ||
    roundMoney(sumDeductions) !== roundMoney(run.totalDeductions) ||
    roundMoney(sumNet) !== roundMoney(run.totalNet)
  ) {
    throw new Error(
      `Accounting Security Error: Payroll run totals mismatch with items sum (Run: Gross ${run.totalGross}, Net ${run.totalNet} vs Items: Gross ${sumGross}, Net ${sumNet}). Aborting GL posting.`
    );
  }

  // 3. Accounting Period Validation
  const yearNum = run.periodYear;
  const monthNum = run.periodMonth;
  const monthKeyStr = String(monthNum).padStart(2, '0');
  const txDate = transactionDate || `${yearNum}-${monthKeyStr}-28`;

  validatePeriod(txDate, settings);

  // 4. Resolve Chart of Account Roles
  const salaryExpenseAcct = requireRole(accounts, 'salaryExpense', 'Payroll Consolidated GL Posting');
  const commissionExpenseAcct = requireRole(accounts, 'costCommission', 'Payroll Consolidated GL Posting');
  const employeePayableAcct = requireRole(accounts, 'employeePayable', 'Payroll Consolidated GL Posting');
  const employeeAdvanceAcct = requireRole(accounts, 'employeeAdvance', 'Payroll Consolidated GL Posting');

  // 5. Construct Consolidated Journal Lines
  let totalSalaryExpense = 0;
  let totalUnpostedCommissionExpense = 0;
  let totalAdvanceRecovery = 0;
  let totalIncrementalPayable = 0;

  const lines = [];
  const unpostedJobCostIdsToMark = [];

  // Itemized breakdown
  for (const item of items) {
    const itemSalaryExp = roundMoney(
      (item.baseSalary || 0) +
        (item.totalAllowances || 0) +
        (item.bonus || 0) +
        (item.overtime || 0) -
        (item.expenseDeductions || 0)
    );
    totalSalaryExpense += itemSalaryExp;

    const unpostedComm = roundMoney(item.unpostedCommission || 0);
    totalUnpostedCommissionExpense += unpostedComm;

    if (Array.isArray(item.commissionJobCostIds) && item.commissionJobCostIds.length > 0 && unpostedComm > 0) {
      unpostedJobCostIdsToMark.push(...item.commissionJobCostIds);
    }

    const advRecovery = roundMoney(item.advanceRecovery || 0);
    if (advRecovery > 0) {
      totalAdvanceRecovery += advRecovery;
      lines.push({
        accountId: employeeAdvanceAcct.id,
        accountCode: employeeAdvanceAcct.code || '110203',
        debit: 0,
        credit: advRecovery,
        subLedgerType: 'employee',
        subLedgerId: `emp-advance-${item.employeeId}`,
        subLedgerName: item.employeeName || ''
      });
    }

    // Incremental payable credit = netPayable - prePostedCommission
    const prePostedComm = roundMoney(item.prePostedCommission || 0);
    const incrementalPayable = roundMoney((item.netPayable || 0) - prePostedComm);

    if (incrementalPayable > 0) {
      totalIncrementalPayable += incrementalPayable;
      lines.push({
        accountId: employeePayableAcct.id,
        accountCode: employeePayableAcct.code || '210201',
        debit: 0,
        credit: incrementalPayable,
        subLedgerType: 'employee',
        subLedgerId: `emp-payable-${item.employeeId}`,
        subLedgerName: item.employeeName || ''
      });
    }
  }

  totalSalaryExpense = roundMoney(totalSalaryExpense);
  totalUnpostedCommissionExpense = roundMoney(totalUnpostedCommissionExpense);
  totalAdvanceRecovery = roundMoney(totalAdvanceRecovery);
  totalIncrementalPayable = roundMoney(totalIncrementalPayable);

  // Add Debit Line for Salaries Expense (5201)
  if (totalSalaryExpense > 0) {
    lines.unshift({
      accountId: salaryExpenseAcct.id,
      accountCode: salaryExpenseAcct.code || '5201',
      debit: totalSalaryExpense,
      credit: 0
    });
  }

  // Add Debit Line for Unposted Commissions Expense (5105)
  if (totalUnpostedCommissionExpense > 0) {
    const salaryLineIdx = totalSalaryExpense > 0 ? 1 : 0;
    lines.splice(salaryLineIdx, 0, {
      accountId: commissionExpenseAcct.id,
      accountCode: commissionExpenseAcct.code || '5105',
      debit: totalUnpostedCommissionExpense,
      credit: 0
    });
  }

  const totalDebit = roundMoney(totalSalaryExpense + totalUnpostedCommissionExpense);
  const totalCredit = roundMoney(totalAdvanceRecovery + totalIncrementalPayable);

  // Verify debit/credit balance
  const glPayload = {
    idempotencyKey: `payroll_run:${periodId}:post`,
    transactionDate: txDate,
    sourceType: 'payrollRun',
    sourceId: periodId,
    action: 'payroll_post',
    description: `Consolidated Payroll Run for Period ${periodId}`,
    lines,
    totalDebit,
    totalCredit,
    status: 'posted',
    createdBy: postedBy,
    createdAt: serverTimestamp()
  };

  validateTransaction(glPayload);

  // 6. Transition to POSTING Lock if currently APPROVED
  if (run.status === 'APPROVED') {
    await transitionPayrollRun(periodId, 'APPROVED', 'POSTING', postedBy);
  }

  // 7. Atomic Transaction: Commit GL Document, update JobCosts, and set status POSTED
  const runRef = doc(db, 'payrollRuns', periodId);

  return await runTransaction(db, async (transaction) => {
    // Check existing GL doc inside transaction
    const existingTxSnap = await transaction.get(glRef);
    if (existingTxSnap.exists()) {
      const existingData = existingTxSnap.data();
      if (
        existingData.sourceType !== 'payrollRun' ||
        existingData.sourceId !== periodId ||
        roundMoney(existingData.totalDebit) !== roundMoney(totalDebit)
      ) {
        throw new Error(
          `Accounting Security Error: Existing GL transaction ${deterministicGlId} conflicts with current payroll totals.`
        );
      }
    } else {
      // Write deterministic GL transaction
      transaction.set(glRef, glPayload);
    }

    // Mark unposted candidate jobCosts as postedToGL
    if (unpostedJobCostIdsToMark.length > 0) {
      for (const jcId of unpostedJobCostIdsToMark) {
        const jcRef = doc(db, COL.jobCosts || 'jobCosts', jcId);
        const jcSnap = await transaction.get(jcRef);
        if (jcSnap.exists()) {
          const jcData = jcSnap.data();
          if (!jcData.postedToGL) {
            transaction.update(jcRef, {
              postedToGL: true,
              payrollRunId: periodId,
              updatedAt: serverTimestamp()
            });
          }
        }
      }
    }

    // Update Payroll Run status to POSTED
    const runSnap = await transaction.get(runRef);
    const currentVer = Number(runSnap.data()?.version || 1);

    transaction.update(runRef, {
      status: 'POSTED',
      version: currentVer + 1,
      glTransactionId: deterministicGlId,
      postedBy,
      postedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    return {
      created: !existingTxSnap.exists(),
      transactionId: deterministicGlId,
      periodId,
      status: 'POSTED',
      totalDebit,
      totalCredit,
      message: 'Consolidated Payroll Run posted to GL successfully.'
    };
  });
}
