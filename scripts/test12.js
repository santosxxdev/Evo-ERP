import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS, byRole } from '../src/lib/accounts.js';
import { computeTotals } from '../src/lib/invoice.js';
import fs from 'fs';

function runTests() {
  const results = {
    outputTax: [],
    inputTaxExpenses: [],
    inputTaxAssets: [],
    taxReturn: [],
    taxAccountMapping: [],
    egyptianTaxReadiness: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const getBal = (journals, role) => accountBalances(journals, testAccounts).find(a => a.account.role === role)?.balance || 0;

  // 1. Output Tax
  const inv1 = { id: 'inv1', number: 'INV-1', date: '2026-01-01', taxAmount: 140, adBudgetTotal: 0, total: 1140, feesTotal: 1000 };
  const j1 = buildJournal({ invoices: [inv1], accounts: testAccounts });
  const ar1 = getBal(j1, 'receivable'); // should be 1140
  const rev1 = getBal(j1, 'revenue'); // should be -1000 (wait, balance returns normal, so 1000)
  const tax1 = getBal(j1, 'tax'); // normal for liability is credit, should be 140

  results.outputTax.push({
    test: 'Sales Invoice Output Tax',
    drAR: ar1,
    crRev: rev1,
    crTax: tax1,
    reconciles: ar1 === (rev1 + tax1) ? 'PASS' : 'FAIL',
    reason: 'Output tax is accurately posted as a credit to the tax account.'
  });

  // 2. Input Tax on Expenses
  // Since there is no tax field on expenses, it's just amount.
  const exp1 = { id: 'exp1', amount: 11400, date: '2026-01-02', settled: true, methodType: 'cash' };
  const j2 = buildJournal({ expenses: [exp1], accounts: testAccounts });
  const expBal = getBal(j2, 'expense'); // 11400
  const taxBal2 = getBal(j2, 'tax'); // 0

  results.inputTaxExpenses.push({
    test: 'Expense Input Tax',
    drExpense: expBal,
    drTax: taxBal2,
    reconciles: 'FAIL',
    reason: 'There is no input VAT capability for general expenses. Users must post the gross amount to the expense account, completely losing the recoverable tax component.'
  });

  // 3. Input Tax on Assets
  const ast1 = { id: 'ast1', purchaseCost: 100000, purchaseDate: '2026-01-03', taxKind: 'tax1', acquisition: 'credit' };
  const j3 = buildJournal({ assets: [ast1], accounts: testAccounts, settings: { taxRate1: 14, taxRate: 14 } });
  const astBal = getBal(j3, 'equipment'); // 100000
  const taxBal3 = accountBalances(j3, testAccounts).find(a => a.account.role === 'tax')?.debit || 0; // should be 14000
  const apBal3 = getBal(j3, 'vendorPayable'); // 114000
  
  results.inputTaxAssets.push({
    test: 'Asset Input Tax',
    drAsset: astBal,
    drTax: taxBal3,
    crAP: apBal3,
    reconciles: apBal3 === (astBal + taxBal3) ? 'PASS' : 'FAIL',
    reason: 'Input tax on assets is supported but posts directly to the SAME account as Output Tax, mixing input and output tax in the GL.'
  });

  // 4. Tax Account Mapping Failure
  const accNoTax = testAccounts.map(a => a.role === 'tax' ? { ...a, role: 'none' } : a);
  const j4 = buildJournal({ invoices: [inv1], accounts: accNoTax });
  const tbal4 = accountBalances(j4, accNoTax);
  // Receivable = 1140, Revenue = 1000, Tax = 0.
  // The system posts { accountId: null, credit: 140 } to the journal, which the Trial Balance silently drops.
  const drTotal4 = tbal4.reduce((sum, a) => sum + a.debit, 0);
  const crTotal4 = tbal4.reduce((sum, a) => sum + a.credit, 0);

  results.taxAccountMapping.push({
    test: 'Missing Tax Account',
    drTotal: drTotal4,
    crTotal: crTotal4,
    unbalancedAmount: Math.abs(drTotal4 - crTotal4),
    reason: 'If the tax account mapping is missing, ledger.js still attempts to post a line with accountId: null. The accountBalances aggregator silently ignores null accounts, resulting in an unbalanced Trial Balance by exactly the tax amount.'
  });

  // 5. Tax Return Report
  results.taxReturn.push({
    test: 'Report Calculation',
    status: 'FAIL',
    reason: 'The TaxReturn component (src/pages/Accounting.jsx) hardcodes the Input VAT row to display "—". The total payable simply prints the mixed GL balance without mathematically isolating Output vs Input VAT.'
  });

  fs.writeFileSync('test12_results.json', JSON.stringify(results, null, 2));
}

runTests();
