/**
 * PAYROLL FIRESTORE SERVICE INTEGRATION & IDEMPOTENCY LAYER (PHASE 3B-2)
 *
 * Provides concurrency-safe, deterministic Firestore persistence for Payroll Runs and Payroll Items.
 *
 * ABSOLUTE RESTRICTIONS:
 * - NO GL Posting / NO accountingTransactions creation.
 * - NO salary, commission, or advance recovery GL posting.
 * - NO modification of ledger.js, costing.js, accounts.js, accounting.js, employeeAccounting.js.
 * - NO modification of historical accountingTransactions (16 baseline records).
 * - All state transitions and calculations must be concurrency-safe via runTransaction.
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
import {
  calculatePayroll,
  validatePayrollPeriod
} from './payrollEngine.js';

export const PAYROLL_CUTOVER_MONTH = '2025-01';

/**
 * Lifecycle state transition matrix.
 * Defines allowed workflow state progressions and rollbacks.
 */
const ALLOWED_TRANSITIONS = {
  DRAFT: ['CALCULATED'],
  CALCULATED: ['DRAFT', 'REVIEW'],
  REVIEW: ['CALCULATED', 'APPROVED'],
  APPROVED: ['REVIEW', 'POSTING'],
  POSTING: ['POSTED', 'APPROVED'],
  POSTED: ['LOCKED'],
  LOCKED: []
};

/**
 * Validates whether a given period ID or year/month is on or after the cutover month (2026-10).
 *
 * @param {string|number} yearOrPeriodId - e.g. "2026_10" or 2026
 * @param {number} [month] - e.g. 10
 * @returns {boolean}
 */
export function isPeriodOnOrAfterCutover(yearOrPeriodId, month) {
  let periodStr = '';
  if (typeof yearOrPeriodId === 'string') {
    periodStr = yearOrPeriodId.replace('_', '-');
  } else if (yearOrPeriodId && month) {
    periodStr = `${yearOrPeriodId}-${String(month).padStart(2, '0')}`;
  }

  if (!periodStr || periodStr.length < 7) return false;

  const periodCompare = periodStr.substring(0, 7);
  return periodCompare >= PAYROLL_CUTOVER_MONTH;
}

/**
 * Formats deterministic period ID from year and month.
 *
 * @param {number} year
 * @param {number} month
 * @returns {string} e.g. "2026_10"
 */
export function formatPeriodId(year, month) {
  const y = Number(year);
  const m = Number(month);
  return `${y}_${String(m).padStart(2, '0')}`;
}

/**
 * Creates a new Payroll Run document in Firestore using a deterministic document ID.
 * Uses runTransaction to prevent duplicate run creation under concurrent calls.
 *
 * @param {Object} params
 * @param {number} params.year - e.g. 2026
 * @param {number} params.month - e.g. 10
 * @param {string} [params.createdBy]
 * @returns {Promise<Object>} Created payroll run metadata
 */
export async function createPayrollRun({ year, month, createdBy = 'system' }) {
  const periodValidation = validatePayrollPeriod({ year, month });
  if (!periodValidation.valid) {
    throw new Error(`Invalid period parameters: ${periodValidation.errors.join(', ')}`);
  }

  const periodId = formatPeriodId(year, month);

  if (!isPeriodOnOrAfterCutover(year, month)) {
    throw new Error(
      `Payroll runs are strictly forbidden for period ${periodId} prior to cutover month ${PAYROLL_CUTOVER_MONTH}.`
    );
  }

  const runRef = doc(db, 'payrollRuns', periodId);

  return await runTransaction(db, async (transaction) => {
    const runSnap = await transaction.get(runRef);

    if (runSnap.exists()) {
      throw new Error(`Payroll run for period ${periodId} already exists.`);
    }

    const newRun = {
      periodId,
      periodYear: Number(year),
      periodMonth: Number(month),
      status: 'DRAFT',
      version: 1,
      totalGross: 0,
      totalDeductions: 0,
      totalNet: 0,
      itemCount: 0,
      createdBy,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    transaction.set(runRef, newRun);

    return {
      periodId,
      status: 'DRAFT',
      version: 1,
      created: true
    };
  });
}

/**
 * Fetches a single Payroll Run document by period ID.
 *
 * @param {string} periodId - e.g. "2026_10"
 * @returns {Promise<Object|null>}
 */
export async function getPayrollRun(periodId) {
  if (!periodId) return null;
  const runRef = doc(db, 'payrollRuns', periodId);
  const snap = await getDoc(runRef);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Fetches all Payroll Items associated with a specific period ID.
 *
 * @param {string} periodId - e.g. "2026_10"
 * @returns {Promise<Array<Object>>}
 */
export async function getPayrollItems(periodId) {
  if (!periodId) return [];
  const q = query(collection(db, 'payrollItems'), where('payrollRunId', '==', periodId));
  const querySnap = await getDocs(q);
  const items = [];
  querySnap.forEach((docSnap) => {
    items.push({ id: docSnap.id, ...docSnap.data() });
  });
  return items;
}

/**
 * Performs a concurrency-safe lifecycle state transition for a Payroll Run.
 * Uses optimistic versioning and status checks inside a Firestore transaction.
 *
 * @param {string} periodId - e.g. "2026_10"
 * @param {string} expectedStatus - Status the run must be currently in (e.g. "DRAFT")
 * @param {string} nextStatus - Desired next status (e.g. "CALCULATED")
 * @param {string} [updatedBy]
 * @returns {Promise<Object>} Updated run state
 */
export async function transitionPayrollRun(periodId, expectedStatus, nextStatus, updatedBy = 'system') {
  if (!periodId) throw new Error('Period ID is required for lifecycle transition.');
  if (!expectedStatus || !nextStatus) throw new Error('Expected status and next status are required.');

  const runRef = doc(db, 'payrollRuns', periodId);

  return await runTransaction(db, async (transaction) => {
    const runSnap = await transaction.get(runRef);

    if (!runSnap.exists()) {
      throw new Error(`Payroll run ${periodId} does not exist.`);
    }

    const runData = runSnap.data();
    const currentStatus = runData.status;

    if (currentStatus !== expectedStatus) {
      throw new Error(
        `Stale state error: Expected status "${expectedStatus}" for run ${periodId}, but current status is "${currentStatus}".`
      );
    }

    const allowedNextStates = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowedNextStates.includes(nextStatus)) {
      throw new Error(
        `Invalid lifecycle transition: Cannot transition payroll run ${periodId} from "${currentStatus}" to "${nextStatus}".`
      );
    }

    const currentVersion = Number(runData.version || 1);
    const newVersion = currentVersion + 1;

    const updates = {
      status: nextStatus,
      version: newVersion,
      updatedBy,
      updatedAt: serverTimestamp()
    };

    transaction.update(runRef, updates);

    return {
      periodId,
      previousStatus: currentStatus,
      status: nextStatus,
      version: newVersion
    };
  });
}

/**
 * Delegates financial calculation to payrollEngine.js and persists calculated payroll items
 * deterministically into Firestore inside an atomic transaction.
 *
 * @param {Object} params
 * @param {string} params.periodId - e.g. "2026_10"
 * @param {Array<Object>} params.payrollInputs - Array of input objects for payrollEngine.calculatePayroll()
 * @param {string} [params.updatedBy]
 * @returns {Promise<Object>} Summary of calculation and persistence
 */
export async function calculateAndPersistPayrollRun({ periodId, payrollInputs = [], updatedBy = 'system' }) {
  if (!periodId) throw new Error('Period ID is required for calculation.');
  if (!Array.isArray(payrollInputs) || payrollInputs.length === 0) {
    throw new Error('At least one employee payroll input must be provided.');
  }

  // Firestore transaction scalability guard (500 ops limit)
  if (payrollInputs.length > 450) {
    throw new Error(
      `Scalability limitation: Batch size of ${payrollInputs.length} employees exceeds single transaction safety threshold of 450 items.`
    );
  }

  const runRef = doc(db, 'payrollRuns', periodId);

  return await runTransaction(db, async (transaction) => {
    const runSnap = await transaction.get(runRef);

    if (!runSnap.exists()) {
      throw new Error(`Payroll run ${periodId} does not exist. Create run first.`);
    }

    const runData = runSnap.data();
    const currentStatus = runData.status;

    // Item creation/modification allowed ONLY in DRAFT or CALCULATED state
    if (currentStatus !== 'DRAFT' && currentStatus !== 'CALCULATED') {
      throw new Error(
        `Immutable state error: Cannot calculate or modify payroll items while payroll run ${periodId} is in "${currentStatus}" state.`
      );
    }

    // Delegate calculation to pure payrollEngine.js
    const calculationResult = calculatePayroll(payrollInputs);

    if (!calculationResult.valid) {
      const allErrors = (calculationResult.items || [])
        .flatMap((i) => i.errors || [])
        .filter(Boolean);
      throw new Error(`Payroll calculation failed: ${allErrors.join('; ')}`);
    }

    const calculatedItems = calculationResult.items || [];
    const totals = calculationResult.totals || {};

    // Persist each payroll item deterministically
    for (const item of calculatedItems) {
      if (item.periodId !== periodId) {
        throw new Error(
          `Consistency error: Calculated item periodId "${item.periodId}" does not match run periodId "${periodId}".`
        );
      }

      const itemDocId = `${periodId}_${item.employeeId}`;
      const itemRef = doc(db, 'payrollItems', itemDocId);

      const itemData = {
        payrollRunId: periodId,
        employeeId: item.employeeId,
        employeeCode: item.employeeCode || '',
        employeeName: item.employeeName || '',
        departmentId: item.departmentId || '',
        positionId: item.positionId || '',

        periodId: item.periodId,
        periodYear: item.periodYear,
        periodMonth: item.periodMonth,

        // Snapshot of calculated financial fields
        baseSalary: item.baseSalary,
        allowances: item.allowances || [],
        totalAllowances: item.totalAllowances,

        bonus: item.bonus,
        overtime: item.overtime,

        commissionTotal: item.commissionTotal,
        prePostedCommission: item.prePostedCommission,
        unpostedCommission: item.unpostedCommission,
        commissionJobCostIds: item.commissionJobCostIds || [],

        grossPay: item.grossPay,

        absenceDeduction: item.absenceDeduction,
        lateDeduction: item.lateDeduction,
        expenseDeductions: item.expenseDeductions,

        advanceRecoveryRequested: item.advanceRecoveryRequested,
        advanceOutstandingBalance: item.advanceOutstandingBalance,
        advanceRecovery: item.advanceRecovery,

        otherDeductions: item.otherDeductions,
        otherDeductionsClassification: item.otherDeductionsClassification || 'pending',

        totalDeductions: item.totalDeductions,
        netPayable: item.netPayable,

        accountingPreview: item.accountingPreview || {},
        warnings: item.warnings || [],
        updatedAt: serverTimestamp()
      };

      transaction.set(itemRef, itemData);
    }

    // Update run totals and status to CALCULATED
    const currentVersion = Number(runData.version || 1);
    const newVersion = currentVersion + 1;

    const runUpdates = {
      status: 'CALCULATED',
      version: newVersion,
      totalGross: totals.totalGrossPay || 0,
      totalDeductions: totals.totalDeductions || 0,
      totalNet: totals.totalNetPayable || 0,
      itemCount: calculatedItems.length,
      updatedBy,
      updatedAt: serverTimestamp()
    };

    transaction.update(runRef, runUpdates);

    return {
      periodId,
      status: 'CALCULATED',
      version: newVersion,
      itemCount: calculatedItems.length,
      totalGross: totals.totalGrossPay || 0,
      totalDeductions: totals.totalDeductions || 0,
      totalNet: totals.totalNetPayable || 0
    };
  });
}
