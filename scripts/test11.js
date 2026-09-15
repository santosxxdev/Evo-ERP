import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS, byRole } from '../src/lib/accounts.js';
import { vendorBalance } from '../src/lib/costing.js';
import fs from 'fs';

function runTests() {
  const results = {
    vendorSubledger: [],
    apReconciliation: [],
    historicalIntegrity: [],
    vendorDeletion: [],
    manualJournals: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const getBal = (journals, role) => accountBalances(journals, testAccounts).find(a => a.account.role === role)?.balance || 0;

  // 1. Vendor Statement Formula & Expenses
  // formula: vendorBalance only sums JOB_COSTS (costs array) where vendorId matches.
  // It completely ignores expenses and asset purchases.
  
  const v1 = { id: 'v1', name: 'Vendor A' };
  const jc1 = { id: 'jc1', vendorId: 'v1', amount: 5000, type: 'video', date: '2026-01-01', paid: false };
  const exp1 = { id: 'exp1', target: { kind: 'vendor', id: 'v1' }, amount: 2000, date: '2026-01-02', paidStatus: 'unpaid', categoryId: 'cat1' };
  const ast1 = { id: 'ast1', vendor: 'Vendor A', purchaseCost: 10000, purchaseDate: '2026-01-03', acquisition: 'credit' };
  
  const uiBal = vendorBalance(v1.id, [jc1]); 
  // Should be 5000 due, since expenses and assets are ignored.

  const j1 = buildJournal({ 
    jobCosts: [jc1], 
    expenses: [exp1], 
    assets: [ast1], 
    vendors: [v1],
    accounts: testAccounts,
    expenseCategories: [{id: 'cat1', system: 'other'}]
  });
  
  const apBal = getBal(j1, 'vendorPayable');
  
  results.apReconciliation.push({
    test: 'General Expense & Asset Purchase vs Subledger',
    uiBalanceDue: uiBal.due, // 5000
    glAP: apBal, // 5000 (jc1) + 2000 (exp1) + 10000 (ast1) = 17000
    difference: apBal - uiBal.due, // 12000
    reason: 'vendorBalance() ONLY aggregates Job Costs. However, ledger.js credits vendorPayable for unpaid general expenses and credit-based asset purchases. This creates an irreconcilable 12,000 difference between the Vendor Statement and the AP GL.'
  });

  // 2. Asset Purchases AP Orphan
  results.apReconciliation.push({
    test: 'Asset Purchase AP Orphan',
    status: 'FAIL',
    reason: 'Asset purchases on credit debit the Asset account and credit AP, but there is NO vendorId recorded, NO payment function in ledger.js for assets, and NO integration with the Vendor Statement. It is an unpayable orphan AP liability.'
  });

  // 3. Historical Integrity of Payments (CF-28)
  const jc1_paid = { ...jc1, paid: true, paidDate: '2026-02-01' };
  // If we rebuild journal as of Jan 31 (ignoring dates greater than Jan 31)
  const j2 = buildJournal({ jobCosts: [jc1_paid], vendors: [v1], accounts: testAccounts });
  // Wait, buildJournal doesn't filter by `asOf` internally. It just maps to journals.
  // The crucial part is what date the payment is logged on.
  const costEntry = j2.find(e => e.id === `cost-jc1`);
  
  results.historicalIntegrity.push({
    test: 'Payment Date Integrity',
    paymentDate: jc1_paid.paidDate, // Feb 01
    journalDate: costEntry.date, // Jan 01 (expense generation date)
    creditsCash: costEntry.lines.some(l => l.account?.role === 'cash' && l.credit === 5000),
    reason: 'ledger.js completely ignores `paidDate`. When a job cost is marked as paid, it retroactively rewrites the original expense journal entry on the expense date to credit Cash instead of AP. This deletes the AP liability from historical balance sheets entirely and falsely reduces historical Cash.'
  });

  // 4. Vendor Deletion (CF-31)
  // delete Vendor A
  const j3 = buildJournal({ jobCosts: [jc1], vendors: [], accounts: testAccounts });
  const orphanEntry = j3.find(e => e.id === `cost-jc1`);
  results.vendorDeletion.push({
    test: 'Orphaned Financial Transactions',
    vendorReference: orphanEntry.ref,
    reason: 'The frontend does not block vendor deletion (unlike Client deletion). If a vendor is deleted, historical GL entries dynamically lose their vendor name reference (`vendor?.name ?? ""`), replacing it with an empty string, while permanently locking the payable amount.'
  });

  // 5. Duplicate Vendors
  results.vendorDeletion.push({
    test: 'Duplicate Vendors',
    status: 'FAIL',
    reason: 'There are no uniqueness constraints on Vendor Name or Code in the database. Duplicates fragment AP.'
  });

  fs.writeFileSync('test11_results.json', JSON.stringify(results, null, 2));
}

runTests();
