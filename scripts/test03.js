import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    basic: [],
    unpaidAndSettlement: [],
    clientFunded: [],
    negative: [],
    editing: [],
    missingRole: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const expCategory = { id: 'cat1', name: 'General', isAdSpend: false };
  const adCategory = { id: 'cat2', name: 'Ads', isAdSpend: true };
  const paymentMethods = [{ id: 'pm1', type: 'cash', accountId: testAccounts.find(a=>a.role==='cash').id }, { id: 'pm2', type: 'bank', accountId: testAccounts.find(a=>a.role==='bank').id }];

  // Helper to extract lines from a specific entry
  const getEntryLines = (journal, id) => journal.find(j => j.id === id)?.lines || [];
  
  // 1. BASIC EXPENSE & BANK EXPENSE
  const exp1 = { id: 'e1', amount: 1000, categoryId: 'cat1', methodId: 'pm1', settled: true, date: '2026-01-01' };
  const exp2 = { id: 'e2', amount: 2500, categoryId: 'cat1', methodId: 'pm2', settled: true, date: '2026-01-01' };
  const jBasic = buildJournal({ expenses: [exp1, exp2], accounts: testAccounts, expenseCategories: [expCategory], paymentMethods });
  
  results.basic.push({
    test: 'Basic Cash Expense',
    hasExpenseDebit: getEntryLines(jBasic, 'exp-e1').some(l => l.account?.role === 'otherExpense' && l.debit === 1000),
    hasCashCredit: getEntryLines(jBasic, 'exp-e1').some(l => l.account?.role === 'cash' && l.credit === 1000)
  });
  results.basic.push({
    test: 'Bank Expense',
    hasExpenseDebit: getEntryLines(jBasic, 'exp-e2').some(l => l.account?.role === 'otherExpense' && l.debit === 2500),
    hasBankCredit: getEntryLines(jBasic, 'exp-e2').some(l => l.account?.role === 'bank' && l.credit === 2500)
  });

  // 4. UNPAID EXPENSE & SETTLEMENT
  const expUnpaid = { id: 'e3', amount: 1000, categoryId: 'cat1', target: { kind: 'vendor', id: 'v1' }, settled: false, date: '2026-01-01' };
  const jUnpaid = buildJournal({ expenses: [expUnpaid], accounts: testAccounts, expenseCategories: [expCategory] });
  results.unpaidAndSettlement.push({
    test: 'Unpaid Expense',
    hasExpenseDebit: getEntryLines(jUnpaid, 'exp-e3').some(l => l.account?.role === 'otherExpense' && l.debit === 1000),
    hasVendorPayableCredit: getEntryLines(jUnpaid, 'exp-e3').some(l => l.account?.role === 'vendorPayable' && l.credit === 1000)
  });

  // Settling the expense: what happens? The code says `if (expense.settled === false... vendorPayable) else cashOrBank`.
  // If we change settled to true, it just replaces the credit line in the single generated journal entry.
  const expSettled = { ...expUnpaid, settled: true, methodId: 'pm1' };
  const jSettled = buildJournal({ expenses: [expSettled], accounts: testAccounts, expenseCategories: [expCategory], paymentMethods });
  results.unpaidAndSettlement.push({
    test: 'Settled Expense',
    hasExpenseDebit: getEntryLines(jSettled, 'exp-e3').some(l => l.account?.role === 'otherExpense' && l.debit === 1000),
    hasVendorPayableCredit: getEntryLines(jSettled, 'exp-e3').some(l => l.account?.role === 'vendorPayable' && l.credit === 1000), // This should be FALSE now
    hasCashCredit: getEntryLines(jSettled, 'exp-e3').some(l => l.account?.role === 'cash' && l.credit === 1000),
    mutationConfirmed: true
  });

  // 8. CLIENT-FUNDED EXPENSE
  const expClient = { id: 'e4', amount: 500, categoryId: 'cat2', clientId: 'c1', settled: true, methodId: 'pm1', date: '2026-01-01' };
  const jClient = buildJournal({ expenses: [expClient], accounts: testAccounts, expenseCategories: [adCategory], paymentMethods });
  results.clientFunded.push({
    test: 'Client Funded Expense',
    hasAdBudgetHeldDebit: getEntryLines(jClient, 'exp-e4').some(l => l.account?.role === 'adBudgetHeld' && l.debit === 500),
    hasCashCredit: getEntryLines(jClient, 'exp-e4').some(l => l.account?.role === 'cash' && l.credit === 500)
  });

  // 9. CLIENT-FUNDED WITHOUT CLIENT
  const expNoClient = { id: 'e5', amount: 500, categoryId: 'cat2', clientId: null, settled: true, methodId: 'pm1', date: '2026-01-01' };
  const jNoClient = buildJournal({ expenses: [expNoClient], accounts: testAccounts, expenseCategories: [adCategory], paymentMethods });
  results.clientFunded.push({
    test: 'Ad Spend category without client ID',
    hasAdBudgetHeldDebit: getEntryLines(jNoClient, 'exp-e5').some(l => l.account?.role === 'adBudgetHeld' && l.debit === 500),
    hasExpenseDebit: getEntryLines(jNoClient, 'exp-e5').some(l => l.account?.role === 'otherExpense' && l.debit === 500)
  });

  // 11. NEGATIVE EXPENSE
  const expNeg = { id: 'e6', amount: -300, categoryId: 'cat1', settled: true, methodId: 'pm1', date: '2026-01-01' };
  const jNeg = buildJournal({ expenses: [expNeg], accounts: testAccounts, expenseCategories: [expCategory], paymentMethods });
  results.negative.push({
    test: 'Negative Expense',
    hasCashDebit: getEntryLines(jNeg, 'exp-e6').some(l => l.account?.role === 'cash' && l.debit === 300),
    hasExpenseCredit: getEntryLines(jNeg, 'exp-e6').some(l => l.account?.role === 'otherExpense' && l.credit === 300)
  });

  fs.writeFileSync('test03_results.json', JSON.stringify(results, null, 2));
}

runTests();
