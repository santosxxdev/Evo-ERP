import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    employeeCost: [],
    payment: [],
    subledgerReconciliation: [],
    overpayment: [],
    duplicates: [],
    missing: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const getBal = (journals, role) => accountBalances(journals, testAccounts).find(a => a.account.role === role)?.balance || 0;

  // 1. Employee Entries (Salary/Bonus/Deduction) vs Ledger
  // Since `employeeEntries` isn't a parameter of `buildJournal`, these don't exist in GL!
  results.employeeCost.push({
    test: 'Basic Salary / Bonus / Deduction Accounting',
    status: 'MISSING',
    reason: 'The `employeeEntries` collection (which holds salaries, bonuses, and deductions) is completely omitted from `buildJournal()`. Employee salaries never hit the General Ledger, P&L, or Trial Balance.'
  });

  // 2. Employee Job Costs (Direct Cost -> Payable)
  const jobCost1 = { id: 'jc1', employeeId: 'emp1', amount: 4000, type: 'model', paid: false, date: '2026-01-01' };
  const jCost = buildJournal({ jobCosts: [jobCost1], accounts: testAccounts });
  
  results.employeeCost.push({
    test: 'Employee Job Cost 4,000 (Accrued)',
    directCostBalance: getBal(jCost, 'costModel'), // Expected 4000
    employeePayableBalance: -getBal(jCost, 'employeePayable'), // Expected 4000 (Credit)
    cashBalance: getBal(jCost, 'cash') // Expected 0
  });

  // 3. Employee Payment (via Job Costs)
  const jobCostPaid = { id: 'jc1', employeeId: 'emp1', amount: 4000, type: 'model', paid: true, date: '2026-01-01' };
  const jCostPaid = buildJournal({ jobCosts: [jobCostPaid], accounts: testAccounts });

  results.payment.push({
    test: 'Employee Job Cost 4,000 (Paid)',
    directCostBalance: getBal(jCostPaid, 'costModel'), // Expected 4000
    employeePayableBalance: -getBal(jCostPaid, 'employeePayable'), // Expected 0
    cashBalance: getBal(jCostPaid, 'cash'), // Expected -4000
    mutatesHistory: true // Because it replaces the original payable credit with cash credit
  });

  // 4. Employee Expenses
  const expAdvance = { id: 'e1', amount: 5000, settled: false, target: { kind: 'employee', id: 'emp1' }, categoryId: 'cat1', date: '2026-01-01' };
  const expDeduct = { id: 'e2', amount: -1000, settled: false, target: { kind: 'employee', id: 'emp1' }, categoryId: 'cat1', date: '2026-01-01' };
  
  // Need a category
  const expenseCategories = [{ id: 'cat1', name: 'General Expense' }];
  const jExp = buildJournal({ expenses: [expAdvance, expDeduct], accounts: testAccounts, expenseCategories });

  results.employeeCost.push({
    test: 'Employee Expenses (Positive and Negative)',
    expenseBalance: getBal(jExp, 'otherExpense'), // Expected 4000 (5000 - 1000)
    employeePayableBalance: -getBal(jExp, 'employeePayable') // Expected 4000 (Credit)
  });

  // 5. Employee Subledger vs GL Reconciliation
  // Employee Subledger in UI shows: entries (salaries) + jobCosts + expenses targeted at them?
  // Let's check: UI only shows entries + jobCosts + targets? No, Employees.jsx only aggregates `entries` + `jobCosts` + `commissionRows` + `bonusRows`.
  // It completely ignores `expenses` with `target.kind === 'employee'`!
  results.subledgerReconciliation.push({
    test: 'Employee Statement vs GL AP',
    status: 'FAIL',
    reason: 'The UI Employee Statement aggregates `employeeEntries` (which are NOT in GL) and ignores `expenses` targeted at employees (which ARE in GL). The subledger and GL will never reconcile.'
  });

  // 6. Employee Overpayment / Partial Payment
  results.overpayment.push({
    test: 'Partial Payments and Overpayments',
    status: 'FAIL',
    reason: 'Like Vendors, Employee liabilities use strict `paid`/`settled` booleans. Partial payments and overpayments are structurally impossible.'
  });

  // 7. Duplicate Payment
  results.duplicates.push({
    test: 'Idempotency',
    status: 'FAIL',
    reason: 'Idempotency relies on the `paid` boolean toggle which mutates the original record. There are no discrete payment transactions.'
  });

  fs.writeFileSync('test07_results.json', JSON.stringify(results, null, 2));
}

runTests();
