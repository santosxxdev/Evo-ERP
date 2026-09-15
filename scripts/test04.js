import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { vendorBalance } from '../src/lib/costing.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    subledgerReconciliation: [],
    partialPayment: [],
    settlementIntegrity: [],
    multiVendor: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const getBal = (journals, role) => accountBalances(journals, testAccounts).find(a => a.role === role)?.balance || 0;
  
  // 1. RECONCILIATION TEST (Vendor Subledger vs GL)
  // Create 1 job cost and 1 general expense for Vendor A
  const vendorA = { id: 'v1', name: 'Vendor A' };
  const jobCost1 = { id: 'jc1', vendorId: 'v1', amount: 5000, type: 'model', paid: false, date: '2026-01-01' };
  const expense1 = { id: 'exp1', target: { kind: 'vendor', id: 'v1' }, amount: 2000, settled: false, date: '2026-01-01', categoryId: 'cat1' };
  
  const journals = buildJournal({
    jobCosts: [jobCost1],
    expenses: [expense1],
    accounts: testAccounts,
    vendors: [vendorA],
    expenseCategories: [{ id: 'cat1', name: 'General' }]
  });

  const subledger = vendorBalance('v1', [jobCost1]); // vendorBalance only accepts costs array
  const glPayable = getBal(journals, 'vendorPayable');

  results.subledgerReconciliation.push({
    test: 'Job Cost (5000) + Vendor Expense (2000)',
    subledgerBalance: subledger.due, // Expected: 5000
    glPayable: -glPayable, // Expected: 7000 (credit)
    difference: 7000 - subledger.due, // 2000 mismatch!
    mismatchConfirmed: subledger.due !== -glPayable
  });

  // 2. SETTLEMENT INTEGRITY & PARTIAL PAYMENT
  // There is literally no `paidAmount` field on `jobCosts`. It's a boolean `paid: true|false`.
  // When paid = true, the ledger entry changes.
  const jobCostPaid = { ...jobCost1, paid: true };
  const journalsPaid = buildJournal({
    jobCosts: [jobCostPaid],
    accounts: testAccounts,
    vendors: [vendorA]
  });

  results.settlementIntegrity.push({
    test: 'Settling job cost',
    originalHasAPCredit: journals.some(j => j.id === 'cost-jc1' && j.lines.some(l => l.account?.role === 'vendorPayable')),
    paidHasAPCredit: journalsPaid.some(j => j.id === 'cost-jc1' && j.lines.some(l => l.account?.role === 'vendorPayable')), // Should be FALSE
    paidHasCashCredit: journalsPaid.some(j => j.id === 'cost-jc1' && j.lines.some(l => l.account?.role === 'cash')), // Should be TRUE
    mutatesHistory: true
  });

  results.partialPayment.push({
    test: 'Partial Payment',
    supported: false,
    reason: 'The `paid` property on jobCosts and `settled` on expenses are strict booleans.'
  });

  // 3. MULTI-VENDOR
  const jobCost2 = { id: 'jc2', vendorId: 'v2', amount: 3000, type: 'video', paid: false, date: '2026-01-02' };
  const journalsMulti = buildJournal({
    jobCosts: [jobCost1, jobCost2],
    accounts: testAccounts,
    vendors: [vendorA, { id: 'v2', name: 'Vendor B' }]
  });

  results.multiVendor.push({
    test: 'Vendor A and Vendor B job costs',
    totalGLPayable: -getBal(journalsMulti, 'vendorPayable'), // 8000
    vendorABalance: vendorBalance('v1', [jobCost1, jobCost2]).due, // 5000
    vendorBBalance: vendorBalance('v2', [jobCost1, jobCost2]).due // 3000
  });

  fs.writeFileSync('test04_results.json', JSON.stringify(results, null, 2));
}

runTests();
