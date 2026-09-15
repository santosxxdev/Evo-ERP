import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { periodStatements } from '../src/lib/useAccounting.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    balanceSheetDateFilter: [],
    retainedEarnings: [],
    subledgerDates: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));

  // 1. Balance Sheet Date Filter (CF-36)
  // Transaction in Jan
  const invJan = { id: 'inv1', number: 'INV-1', date: '2026-01-15', total: 100000, adBudgetTotal: 0, taxAmount: 0, feesTotal: 100000 };
  const expJan = { id: 'exp1', date: '2026-01-20', amount: 40000, settled: false, target: { kind: 'vendor', id: 'v1' } };
  // Transaction in Feb
  const invFeb = { id: 'inv2', number: 'INV-2', date: '2026-02-10', total: 50000, adBudgetTotal: 0, taxAmount: 0, feesTotal: 50000 };

  const journal = buildJournal({
    invoices: [invJan, invFeb],
    expenses: [expJan],
    accounts: testAccounts
  });

  // All-time Balance Sheet
  const stmtAll = periodStatements(journal, testAccounts, '', '');
  const assetsAll = stmtAll.balances.find(a => a.account.role === 'receivable')?.balance || 0; // 150000
  const liabilitiesAll = stmtAll.balances.find(a => a.account.role === 'vendorPayable')?.balance || 0; // 40000
  const profitAll = stmtAll.profit; // 150000 - 40000 = 110000
  
  // Feb-only Balance Sheet
  const stmtFeb = periodStatements(journal, testAccounts, '2026-02-01', '2026-02-28');
  const assetsFeb = stmtFeb.balances.find(a => a.account.role === 'receivable')?.balance || 0; // 50000
  const liabilitiesFeb = stmtFeb.balances.find(a => a.account.role === 'vendorPayable')?.balance || 0; // 0
  const profitFeb = stmtFeb.profit; // 50000 - 0 = 50000

  results.balanceSheetDateFilter.push({
    test: 'Balance Sheet with Date Filter',
    allTimeAssets: assetsAll,
    allTimeLiabilities: liabilitiesAll,
    allTimeProfit: profitAll,
    febAssets: assetsFeb,
    febLiabilities: liabilitiesFeb,
    febProfit: profitFeb,
    reconciles: (assetsFeb === liabilitiesFeb + profitFeb) ? 'YES' : 'NO',
    reason: 'The Balance Sheet mathematically balances for the selected period (Assets 50,000 = Liabilities 0 + Profit 50,000), but it completely drops historical opening balances (the 100,000 AR from Jan is gone). A Balance Sheet MUST show cumulative balances to be valid.'
  });

  results.retainedEarnings.push({
    test: 'Retained Earnings / Equity Closing',
    status: 'FAIL',
    reason: 'The system has no Retained Earnings account and no year-end closing mechanism. Historical profits from prior periods (Jan 110,000) simply vanish from the Feb Balance Sheet, breaking continuous financial reporting.'
  });

  results.subledgerDates.push({
    test: 'Subledgers Ignore Date Filters',
    status: 'FAIL',
    reason: 'The ReceivablesReport and InvoicesReport in ReportView.jsx calculate balances directly from the `invoices` array WITHOUT applying the `from` and `to` date filters. When a user selects "This Month", the AR Report shows ALL-TIME customer balances, while the General Ledger AR shows only THIS MONTH\'S movements. They will never reconcile under a date filter.'
  });

  fs.writeFileSync('test13_results.json', JSON.stringify(results, null, 2));
}

runTests();
