import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { invoiceProfit } from '../src/lib/costing.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    jobCost: [],
    multipleCosts: [],
    employeeJobCost: [],
    doubleCounting: [],
    unlinkedCost: [],
    minimumPrice: [],
    historicalMutation: [],
    missingAccounts: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const getBal = (journals, role) => accountBalances(journals, testAccounts).find(a => a.account.role === role)?.balance || 0;

  // 1. Basic Job Cost (Employee vs Direct Cost)
  const jcEmployee = { id: 'jc1', employeeId: 'emp1', amount: 2000, type: 'model', paid: false, invoiceId: 'inv1', date: '2026-01-01' };
  const j1 = buildJournal({ jobCosts: [jcEmployee], accounts: testAccounts });
  
  results.employeeJobCost.push({
    test: 'Employee Job Cost 2,000',
    directCostBalance: getBal(j1, 'costModel'), // Expected 2000
    employeePayable: -getBal(j1, 'employeePayable'), // Expected 2000
    cash: getBal(j1, 'cash')
  });

  // 2. Multiple Costs
  const jcVendor = { id: 'jc2', vendorId: 'ven1', amount: 3000, type: 'video', paid: false, invoiceId: 'inv1', date: '2026-01-01' };
  // Note: There is NO 'expense' type in jobCosts, only specific COST_TYPES. Expenses are recorded in the expenses collection.
  // Expenses can target an invoice but we need to see if they are included in invoiceProfit.
  // wait, costsOfInvoice only filters `costs` (which are jobCosts). Expenses don't have `invoiceId` in costing.js.
  
  const j2 = buildJournal({ jobCosts: [jcEmployee, jcVendor], accounts: testAccounts });
  
  results.multipleCosts.push({
    test: 'Multiple Job Costs',
    modelCost: getBal(j2, 'costModel'), // Expected 2000
    videoCost: getBal(j2, 'costVideo'), // Expected 3000
    totalPayable: -getBal(j2, 'employeePayable') - getBal(j2, 'vendorPayable') // Expected 5000
  });

  // 3. Profitability Calculation
  const invoice = { id: 'inv1', total: 20000, adBudgetTotal: 0, taxAmount: 0 };
  const profit = invoiceProfit(invoice, [jcEmployee, jcVendor]);
  
  results.jobCost.push({
    test: 'Service Profitability',
    revenue: profit.revenue, // Expected 20000
    cost: profit.cost, // Expected 5000
    profit: profit.profit, // Expected 15000
    margin: profit.margin // Expected 75
  });

  // 4. Double Counting Test
  // Is it possible to have an Employee Entry for Salary AND a Job Cost for the same work?
  // Yes, because Employee Entries don't hit GL, the UI statement will show both, but GL will only show Job Cost.
  // Wait, what if it's an Expense targeted at an Employee AND a Job Cost?
  const expEmp = { id: 'e1', amount: 2000, target: { kind: 'employee', id: 'emp1' }, categoryId: 'cat1', settled: false, date: '2026-01-01' };
  const j3 = buildJournal({ jobCosts: [jcEmployee], expenses: [expEmp], accounts: testAccounts });
  
  results.doubleCounting.push({
    test: 'Employee Expense + Employee Job Cost',
    directCost: getBal(j3, 'costModel'), // 2000
    generalExpense: getBal(j3, 'otherExpense'), // 2000
    totalPayable: -getBal(j3, 'employeePayable') // 4000
  });

  // 5. Unlinked Job Cost
  // Job cost without `invoiceId`
  const jcUnlinked = { id: 'jc3', employeeId: 'emp1', amount: 3000, type: 'design', paid: false, date: '2026-01-01' };
  const j4 = buildJournal({ jobCosts: [jcUnlinked], accounts: testAccounts });
  
  results.unlinkedCost.push({
    test: 'Unlinked Job Cost',
    directCost: getBal(j4, 'costDesign'), // Expected 3000
    payable: -getBal(j4, 'employeePayable'), // Expected 3000
    profitabilityImpact: invoiceProfit(invoice, [jcUnlinked]).cost // Expected 0, because it's not linked to any invoice
  });

  // 6. Minimum Selling Price
  results.minimumPrice.push({
    test: 'Minimum Selling Price Control',
    status: 'MISSING',
    reason: 'The invoice creation flow does not validate `invoice.total` against `invoice.expectedCost`. It calculates a suggested price but never enforces it.'
  });

  // 7. Payment Date Mutation
  const jcPaid = { ...jcEmployee, paid: true };
  const j5 = buildJournal({ jobCosts: [jcPaid], accounts: testAccounts });
  
  results.historicalMutation.push({
    test: 'Payment Date / Mutation',
    mutatesOriginalAccrual: true,
    reason: 'Marking a job cost as paid swaps the Employee/Vendor Payable account for Cash on the original transaction date. No discrete payment transaction is created.',
    accrualBalance: getBal(j5, 'employeePayable'), // Expected 0
    cashBalance: getBal(j5, 'cash') // Expected -2000
  });

  // 8. Missing Account Roles
  const badAccounts = testAccounts.map(a => a.role === 'costModel' ? { ...a, role: null } : a);
  const j6 = buildJournal({ jobCosts: [jcEmployee], accounts: badAccounts });
  const hasUnbalanced = j6.some(j => j.lines.some(l => l.accountId === null));
  
  results.missingAccounts.push({
    test: 'Missing Job Cost Account',
    unbalancedEntryCreated: hasUnbalanced
  });

  fs.writeFileSync('test08_results.json', JSON.stringify(results, null, 2));
}

runTests();
