/**
 * PAYROLL CALCULATION ENGINE (PHASE 3B-1)
 *
 * Pure JavaScript calculations for employee payroll.
 *
 * ABSOLUTE RULES:
 * - Pure calculation engine only.
 * - NO Firebase reads/writes.
 * - NO GL postings or accounting transactions creation.
 * - NO side effects, Date.now(), or Math.random() in financial calculations.
 * - Input snapshots must not be mutated.
 */

/**
 * Safely rounds a numeric monetary value to 2 decimal places.
 * Prevents floating-point artifacts (e.g. 0.1 + 0.2 = 0.30000000000000004).
 *
 * @param {number} val
 * @returns {number}
 */
export function roundMoney(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Validates payroll period object or parameters.
 *
 * @param {Object} period
 * @param {number} period.year - e.g. 2026
 * @param {number} period.month - 1-12
 * @param {string} [period.periodId] - e.g. "2026_09"
 * @returns {{ valid: boolean, errors: string[], normalized: Object|null }}
 */
export function validatePayrollPeriod(period) {
  const errors = [];
  if (!period || typeof period !== 'object') {
    return { valid: false, errors: ['Period must be a valid object.'], normalized: null };
  }

  const year = Number(period.year);
  const month = Number(period.month);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    errors.push(`Period year must be a valid integer between 2000 and 2100. Received: ${period.year}`);
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    errors.push(`Period month must be an integer between 1 and 12. Received: ${period.month}`);
  }

  const expectedPeriodId = `${year}_${String(month).padStart(2, '0')}`;
  if (period.periodId && period.periodId !== expectedPeriodId) {
    errors.push(`Period ID "${period.periodId}" does not match expected format "${expectedPeriodId}".`);
  }

  if (errors.length > 0) {
    return { valid: false, errors, normalized: null };
  }

  return {
    valid: true,
    errors: [],
    normalized: {
      year,
      month,
      periodId: expectedPeriodId
    }
  };
}

/**
 * Normalizes raw payroll input into a clean, immutable object structure.
 *
 * @param {Object} input
 * @returns {Object} Deep-copied & normalized input
 */
export function normalizePayrollInput(input) {
  if (!input || typeof input !== 'object') return {};

  const rawEmp = input.employee || {};
  const employee = {
    id: rawEmp.id || rawEmp.docId || '',
    employeeCode: rawEmp.employeeCode || rawEmp.code || '',
    name: rawEmp.name || rawEmp.employeeName || rawEmp.displayName || '',
    baseSalary: rawEmp.baseSalary !== undefined && rawEmp.baseSalary !== null ? Number(rawEmp.baseSalary) : null,
    departmentId: rawEmp.departmentId || '',
    positionId: rawEmp.positionId || '',
    status: rawEmp.status ? String(rawEmp.status).trim().toLowerCase() : ''
  };

  const period = input.period || {};

  const rawAllowances = Array.isArray(input.allowances) ? input.allowances : [];
  const allowances = rawAllowances.map((item, idx) => ({
    id: item.id || `allowance_${idx + 1}`,
    name: item.name || `Allowance ${idx + 1}`,
    amount: Number(item.amount) || 0
  }));

  const bonus = Number(input.bonus) || 0;
  const overtime = Number(input.overtime) || 0;

  // Commission normalizer
  const rawComm = input.commission || {};
  let commission = {
    total: 0,
    prePosted: 0,
    unposted: 0,
    items: []
  };

  if (typeof rawComm === 'number') {
    commission.total = Number(rawComm) || 0;
    commission.unposted = commission.total;
    commission.items = commission.total > 0 ? [{ jobCostId: 'manual', amount: commission.total, prePosted: false }] : [];
  } else if (typeof rawComm === 'object') {
    const rawItems = Array.isArray(rawComm.items) ? rawComm.items : [];
    if (rawItems.length > 0) {
      commission.items = rawItems.map((item, idx) => ({
        jobCostId: item.jobCostId || `jc_${idx + 1}`,
        amount: Number(item.amount) || 0,
        prePosted: Boolean(item.prePosted)
      }));
      commission.total = commission.items.reduce((sum, item) => sum + item.amount, 0);
      commission.prePosted = commission.items
        .filter(item => item.prePosted)
        .reduce((sum, item) => sum + item.amount, 0);
      commission.unposted = commission.total - commission.prePosted;
    } else {
      commission.total = Number(rawComm.total || rawComm.amount) || 0;
      const prePosted = Boolean(rawComm.prePosted);
      commission.prePosted = prePosted ? commission.total : 0;
      commission.unposted = prePosted ? 0 : commission.total;
      if (commission.total > 0) {
        commission.items = [{ jobCostId: rawComm.jobCostId || 'manual', amount: commission.total, prePosted }];
      }
    }
  }

  const absenceDeduction = Number(input.absenceDeduction) || 0;
  const lateDeduction = Number(input.lateDeduction) || 0;

  // Advance recovery input normalizer
  const rawAdvance = input.advanceRecovery;
  let advanceRecovery = {
    requestedAmount: 0,
    outstandingBalance: 0
  };

  if (typeof rawAdvance === 'number') {
    advanceRecovery.requestedAmount = rawAdvance;
    advanceRecovery.outstandingBalance = input.outstandingAdvanceBalance !== undefined
      ? Number(input.outstandingAdvanceBalance)
      : rawAdvance;
  } else if (typeof rawAdvance === 'object' && rawAdvance !== null) {
    advanceRecovery.requestedAmount = Number(rawAdvance.requestedAmount || rawAdvance.amount) || 0;
    advanceRecovery.outstandingBalance = Number(rawAdvance.outstandingBalance || rawAdvance.balance) || 0;
  } else if (input.outstandingAdvanceBalance !== undefined) {
    advanceRecovery.outstandingBalance = Number(input.outstandingAdvanceBalance) || 0;
  }

  const otherDeductions = Number(input.otherDeductions) || 0;

  return {
    employee,
    period,
    allowances,
    bonus,
    overtime,
    commission,
    absenceDeduction,
    lateDeduction,
    advanceRecovery,
    otherDeductions
  };
}

/**
 * Calculates a single employee's payroll item deterministically.
 *
 * @param {Object} rawInput
 * @returns {Object} Structured payroll item calculation result
 */
export function calculatePayrollItem(rawInput) {
  const errors = [];
  const warnings = [];

  const norm = normalizePayrollInput(rawInput);
  const periodValidation = validatePayrollPeriod(norm.period);

  if (!periodValidation.valid) {
    errors.push(...periodValidation.errors);
  }

  const emp = norm.employee;

  // Employee checks
  if (!emp || !emp.id) {
    errors.push('Employee ID is required.');
  }

  if (!emp || !emp.name) {
    errors.push('Employee name is required.');
  }

  // Employee status eligibility
  const ELIGIBLE_STATUSES = ['active'];
  const INELIGIBLE_STATUSES = ['terminated', 'archived', 'suspended'];

  if (emp.status) {
    if (INELIGIBLE_STATUSES.includes(emp.status)) {
      errors.push(`Employee "${emp.name}" with status "${emp.status}" is not eligible for payroll.`);
    } else if (emp.status === 'on_leave') {
      errors.push(`Employee "${emp.name}" status is "on_leave"; requires explicit caller decision.`);
    } else if (!ELIGIBLE_STATUSES.includes(emp.status)) {
      errors.push(`Employee "${emp.name}" has unrecognized status "${emp.status}".`);
    }
  } else {
    // Default fallback: if status is empty, treat as active with warning or allow if undefined
    warnings.push(`Employee status for "${emp.name}" is missing; assuming active.`);
  }

  // Salary validation (no silent zero)
  if (emp.baseSalary === null || emp.baseSalary === undefined) {
    errors.push(`Base salary is missing for employee "${emp.name}".`);
  } else if (!Number.isFinite(emp.baseSalary)) {
    errors.push(`Base salary for employee "${emp.name}" must be a finite number.`);
  } else if (emp.baseSalary < 0) {
    errors.push(`Base salary for employee "${emp.name}" cannot be negative (${emp.baseSalary}).`);
  }

  const baseSalary = roundMoney(emp.baseSalary || 0);

  // Allowances calculation
  let totalAllowances = 0;
  const processedAllowances = norm.allowances.map(a => {
    if (!Number.isFinite(a.amount) || a.amount < 0) {
      errors.push(`Allowance "${a.name}" has invalid amount: ${a.amount}`);
    }
    const roundedAmount = roundMoney(a.amount);
    totalAllowances += roundedAmount;
    return {
      id: a.id,
      name: a.name,
      amount: roundedAmount
    };
  });
  totalAllowances = roundMoney(totalAllowances);

  // Earnings
  if (!Number.isFinite(norm.bonus) || norm.bonus < 0) {
    errors.push(`Bonus must be a non-negative number (${norm.bonus}).`);
  }
  const bonus = roundMoney(norm.bonus);

  if (!Number.isFinite(norm.overtime) || norm.overtime < 0) {
    errors.push(`Overtime must be a non-negative number (${norm.overtime}).`);
  }
  const overtime = roundMoney(norm.overtime);

  // Commission details
  const comm = norm.commission;
  if (!Number.isFinite(comm.total) || comm.total < 0) {
    errors.push(`Commission total must be a non-negative number (${comm.total}).`);
  }
  const commissionTotal = roundMoney(comm.total);
  const prePostedCommission = roundMoney(comm.prePosted);
  const unpostedCommission = roundMoney(comm.unposted);
  const commissionJobCostIds = comm.items.map(item => item.jobCostId).filter(Boolean);

  // Gross Pay calculation
  const grossPay = roundMoney(baseSalary + totalAllowances + bonus + overtime + commissionTotal);

  // Expense Deductions (Absence & Late)
  if (!Number.isFinite(norm.absenceDeduction) || norm.absenceDeduction < 0) {
    errors.push(`Absence deduction must be a non-negative number (${norm.absenceDeduction}).`);
  }
  const absenceDeduction = roundMoney(norm.absenceDeduction);

  if (!Number.isFinite(norm.lateDeduction) || norm.lateDeduction < 0) {
    errors.push(`Late deduction must be a non-negative number (${norm.lateDeduction}).`);
  }
  const lateDeduction = roundMoney(norm.lateDeduction);

  const expenseDeductions = roundMoney(absenceDeduction + lateDeduction);

  // Advance Recovery calculation & capping
  const adv = norm.advanceRecovery;
  if (!Number.isFinite(adv.requestedAmount) || adv.requestedAmount < 0) {
    errors.push(`Advance recovery requested amount must be a non-negative number (${adv.requestedAmount}).`);
  }
  if (!Number.isFinite(adv.outstandingBalance) || adv.outstandingBalance < 0) {
    errors.push(`Advance outstanding balance must be a non-negative number (${adv.outstandingBalance}).`);
  }

  const requestedAdv = roundMoney(adv.requestedAmount);
  const outstandingAdv = roundMoney(adv.outstandingBalance);

  let actualAdvanceRecovery = Math.min(requestedAdv, outstandingAdv);
  actualAdvanceRecovery = roundMoney(actualAdvanceRecovery);

  if (requestedAdv > outstandingAdv) {
    warnings.push(
      `Advance recovery requested (${requestedAdv} EGP) exceeds outstanding balance (${outstandingAdv} EGP); capped at ${actualAdvanceRecovery} EGP.`
    );
  }

  // Other Deductions
  if (!Number.isFinite(norm.otherDeductions) || norm.otherDeductions < 0) {
    errors.push(`Other deductions must be a non-negative number (${norm.otherDeductions}).`);
  }
  const otherDeductions = roundMoney(norm.otherDeductions);

  // Total Deductions
  const totalDeductions = roundMoney(expenseDeductions + actualAdvanceRecovery + otherDeductions);

  // Net Payable calculation
  const netPayable = roundMoney(grossPay - totalDeductions);

  if (netPayable < 0) {
    errors.push(
      `Net payable cannot be negative. Gross Pay (${grossPay} EGP) is less than Total Deductions (${totalDeductions} EGP).`
    );
  }

  // Accounting Preview Metadata for future Phase 3B-3 GL posting
  const salaryExpensePreview = roundMoney(baseSalary + totalAllowances + bonus + overtime - expenseDeductions);
  const commissionExpenseToPostPreview = unpostedCommission;
  const advanceRecoveryPreview = actualAdvanceRecovery;
  const employeePayablePreview = netPayable;

  const valid = errors.length === 0;

  const periodObj = periodValidation.normalized || {
    year: norm.period.year || 0,
    month: norm.period.month || 0,
    periodId: norm.period.periodId || ''
  };

  return {
    valid,
    errors,
    warnings,

    // Employee snapshot fields
    employeeId: emp.id,
    employeeCode: emp.employeeCode,
    employeeName: emp.name,
    departmentId: emp.departmentId,
    positionId: emp.positionId,

    // Period fields
    periodId: periodObj.periodId,
    periodYear: periodObj.year,
    periodMonth: periodObj.month,

    // Financial components
    baseSalary,

    allowances: processedAllowances,
    totalAllowances,

    bonus,
    overtime,

    commissionTotal,
    prePostedCommission,
    unpostedCommission,
    commissionJobCostIds,

    grossPay,

    absenceDeduction,
    lateDeduction,
    expenseDeductions,

    advanceRecoveryRequested: requestedAdv,
    advanceOutstandingBalance: outstandingAdv,
    advanceRecovery: actualAdvanceRecovery,

    otherDeductions,
    otherDeductionsClassification: 'pending',

    totalDeductions,
    netPayable,

    // GL Preview metadata
    accountingPreview: {
      salaryExpense: salaryExpensePreview,
      commissionExpenseToPost: commissionExpenseToPostPreview,
      advanceRecovery: advanceRecoveryPreview,
      employeePayable: employeePayablePreview
    }
  };
}

/**
 * Calculates aggregate summary totals for an array of payroll items.
 *
 * @param {Array<Object>} items - Array of calculated payroll items
 * @returns {Object} Run-level aggregate totals
 */
export function calculatePayrollTotals(items = []) {
  if (!Array.isArray(items)) {
    return {
      totalEmployees: 0,
      validCount: 0,
      invalidCount: 0,
      totalGrossPay: 0,
      totalExpenseDeductions: 0,
      totalAdvanceRecovery: 0,
      totalOtherDeductions: 0,
      totalDeductions: 0,
      totalNetPayable: 0,
      accountingPreview: {
        totalSalaryExpense: 0,
        totalCommissionExpenseToPost: 0,
        totalAdvanceRecovery: 0,
        totalEmployeePayable: 0
      }
    };
  }

  let validCount = 0;
  let invalidCount = 0;

  let totalGrossPay = 0;
  let totalExpenseDeductions = 0;
  let totalAdvanceRecovery = 0;
  let totalOtherDeductions = 0;
  let totalDeductions = 0;
  let totalNetPayable = 0;

  let totalSalaryExpense = 0;
  let totalCommissionExpenseToPost = 0;

  for (const item of items) {
    if (item && item.valid) {
      validCount++;
      totalGrossPay += item.grossPay || 0;
      totalExpenseDeductions += item.expenseDeductions || 0;
      totalAdvanceRecovery += item.advanceRecovery || 0;
      totalOtherDeductions += item.otherDeductions || 0;
      totalDeductions += item.totalDeductions || 0;
      totalNetPayable += item.netPayable || 0;

      if (item.accountingPreview) {
        totalSalaryExpense += item.accountingPreview.salaryExpense || 0;
        totalCommissionExpenseToPost += item.accountingPreview.commissionExpenseToPost || 0;
      }
    } else {
      invalidCount++;
    }
  }

  return {
    totalEmployees: items.length,
    validCount,
    invalidCount,
    totalGrossPay: roundMoney(totalGrossPay),
    totalExpenseDeductions: roundMoney(totalExpenseDeductions),
    totalAdvanceRecovery: roundMoney(totalAdvanceRecovery),
    totalOtherDeductions: roundMoney(totalOtherDeductions),
    totalDeductions: roundMoney(totalDeductions),
    totalNetPayable: roundMoney(totalNetPayable),
    accountingPreview: {
      totalSalaryExpense: roundMoney(totalSalaryExpense),
      totalCommissionExpenseToPost: roundMoney(totalCommissionExpenseToPost),
      totalAdvanceRecovery: roundMoney(totalAdvanceRecovery),
      totalEmployeePayable: roundMoney(totalNetPayable)
    }
  };
}

/**
 * Validates a calculated item or run totals object.
 *
 * @param {Object} result
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePayrollResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object') {
    return { valid: false, errors: ['Payroll result must be a valid object.'] };
  }

  if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
    errors.push(...result.errors);
  }

  if (typeof result.netPayable === 'number' && result.netPayable < 0) {
    errors.push(`Net payable cannot be negative (${result.netPayable}).`);
  }

  if (result.accountingPreview) {
    const { salaryExpense, commissionExpenseToPost, advanceRecovery, employeePayable } = result.accountingPreview;
    const totalDebits = roundMoney((salaryExpense || 0) + (commissionExpenseToPost || 0));
    const totalCredits = roundMoney((advanceRecovery || 0) + (employeePayable || 0));

    // Note: if prePostedCommission > 0, it was already debited to 5105 and credited to employeePayable in prior run/posting.
    // Therefore, in the current run's GL, salaryExpense + commissionExpenseToPost + prePostedCommission == advanceRecovery + employeePayable.
    const prePostedComm = result.prePostedCommission || 0;
    const balancedWithPreposted = roundMoney(totalDebits + prePostedComm) === totalCredits;

    if (!balancedWithPreposted) {
      errors.push(
        `Accounting preview imbalance: Total Debits (${totalDebits} + prePosted ${prePostedComm} = ${roundMoney(totalDebits + prePostedComm)}) does not equal Total Credits (${totalCredits}).`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Main Payroll Calculation Entry Point.
 * Accepts either a single employee payroll input object or an array of input objects.
 *
 * @param {Object|Array<Object>} input
 * @returns {Object} Calculated payroll item or collection of payroll items with totals
 */
export function calculatePayroll(input) {
  if (Array.isArray(input)) {
    const items = input.map(item => calculatePayrollItem(item));
    const totals = calculatePayrollTotals(items);
    const allValid = items.every(i => i.valid) && totals.invalidCount === 0;

    return {
      valid: allValid,
      items,
      totals
    };
  }

  return calculatePayrollItem(input);
}
