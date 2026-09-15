import { DEFAULT_ACCOUNTS, ACCOUNT_TYPES } from '../src/lib/accounts.js';
import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import fs from 'fs';

// Helper to find account by role
function byRole(role) {
  return DEFAULT_ACCOUNTS.find(a => a.role === role);
}

// Map DEFAULT_ACCOUNTS to flat list with generated IDs
const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));

function getTestAccountByRole(role) {
    return testAccounts.find(a => a.role === role);
}

function runTests() {
  const results = {
    roles: [],
    normalBalance: [],
    manualJournal: [],
    multiLine: [],
    invalidJournal: [],
    missingRole: []
  };

  // 1 & 2. Roles mapping
  const expectedRoles = {
    'cash': 'asset', 'bank': 'asset', 'receivable': 'asset', 
    'vendorPayable': 'liability', 'employeePayable': 'liability', 
    'tax': 'liability', 'capital': 'equity', 'retained': 'equity', 
    'drawings': 'equity', 'revenue': 'revenue', 'salaryExpense': 'expense', 
    'maintenance': 'expense', 'depreciation': 'expense', 'otherExpense': 'expense',
    'equipment': 'asset', 'accumDep': 'asset', 'costModel': 'expense',
    'costVideo': 'expense', 'costDesign': 'expense', 'costEquipment': 'expense',
    'costCommission': 'expense', 'costOther': 'expense', 'adBudgetHeld': 'liability'
  };

  for (const role in expectedRoles) {
    const acc = byRole(role);
    const expectedType = expectedRoles[role];
    const actualType = acc ? acc.type : 'MISSING';
    results.roles.push({
      role,
      accountName: acc ? acc.name : 'N/A',
      actualType,
      expectedType,
      correct: actualType === expectedType
    });
  }

  // 3. Normal Balance Test
  // We'll run a voucher debiting/crediting an asset and an equity to see how accountBalances responds.
  const cashAcc = getTestAccountByRole('cash');
  const equityAcc = getTestAccountByRole('capital');
  
  const testVoucher1 = {
    id: 'v1', date: '2026-01-01', type: 'manual',
    lines: [
      { accountId: cashAcc.id, debit: 1000, credit: 0 },
      { accountId: equityAcc.id, debit: 0, credit: 1000 }
    ]
  };
  const testVoucher2 = {
    id: 'v2', date: '2026-01-02', type: 'manual',
    lines: [
      { accountId: cashAcc.id, debit: 0, credit: 300 },
      { accountId: equityAcc.id, debit: 300, credit: 0 }
    ]
  };

  const journal = buildJournal({ vouchers: [testVoucher1, testVoucher2], accounts: testAccounts });
  const balances = accountBalances(journal, testAccounts);
  
  const cashBal = balances.find(b => b.account.id === cashAcc.id);
  const eqBal = balances.find(b => b.account.id === equityAcc.id);

  results.normalBalance.push({
    test: 'Asset (Debit +1000, Credit -300)',
    expectedNet: 700,
    actualNet: cashBal.net,
    expectedBalance: 700,
    actualBalance: cashBal.balance, // normal = debit -> balance = raw
    pass: cashBal.balance === 700
  });

  results.normalBalance.push({
    test: 'Equity (Credit +1000, Debit -300)',
    expectedNet: -700, // debit - credit = 300 - 1000 = -700
    actualNet: eqBal.net,
    expectedBalance: 700, // normal = credit -> balance = -raw = -(-700) = 700
    actualBalance: eqBal.balance,
    pass: eqBal.balance === 700
  });

  // 4. Manual Journal Test A
  const revAcc = getTestAccountByRole('revenue');
  const jA = buildJournal({
    vouchers: [{ id: 'A', lines: [{ accountId: cashAcc.id, debit: 1000 }, { accountId: revAcc.id, credit: 1000 }] }],
    accounts: testAccounts
  });
  const bA = accountBalances(jA, testAccounts);
  results.manualJournal.push({
    test: 'Test A',
    cash: bA.find(b => b.account.id === cashAcc.id)?.balance || 0,
    revenue: bA.find(b => b.account.id === revAcc.id)?.balance || 0,
    pass: (bA.find(b => b.account.id === cashAcc.id)?.balance === 1000) && (bA.find(b => b.account.id === revAcc.id)?.balance === 1000)
  });

  // Test B
  const expAcc = getTestAccountByRole('otherExpense');
  const jB = buildJournal({
    vouchers: [{ id: 'B', lines: [{ accountId: expAcc.id, debit: 300 }, { accountId: cashAcc.id, credit: 300 }] }],
    accounts: testAccounts
  });
  const bB = accountBalances(jB, testAccounts);
  results.manualJournal.push({
    test: 'Test B',
    expense: bB.find(b => b.account.id === expAcc.id)?.balance || 0,
    cash: bB.find(b => b.account.id === cashAcc.id)?.balance || 0, // Should be -300 since normal debit
    pass: (bB.find(b => b.account.id === expAcc.id)?.balance === 300) && (bB.find(b => b.account.id === cashAcc.id)?.balance === -300)
  });

  // 5. Multi-line Test
  const expAcc2 = getTestAccountByRole('maintenance');
  const payAcc = getTestAccountByRole('vendorPayable');
  
  const jMulti = buildJournal({
    vouchers: [{ id: 'M', lines: [
      { accountId: expAcc.id, debit: 1000, credit: 0 },
      { accountId: expAcc2.id, debit: 500, credit: 0 },
      { accountId: cashAcc.id, debit: 0, credit: 1200 },
      { accountId: payAcc.id, debit: 0, credit: 300 }
    ]}], accounts: testAccounts
  });
  
  const bMulti = accountBalances(jMulti, testAccounts);
  const mTotalDebit = jMulti[0].total; // Total debit is calculated in ledger
  
  results.multiLine.push({
    test: 'Multi-line',
    totalDebit: mTotalDebit,
    pass: mTotalDebit === 1500
  });

  // 6. Invalid Journal Tests
  // Debit only
  const jInvalid1 = buildJournal({
    vouchers: [{ id: 'Inv1', lines: [{ accountId: cashAcc.id, debit: 1000, credit: 0 }] }],
    accounts: testAccounts
  });
  results.invalidJournal.push({
    test: 'Debit only',
    journalLength: jInvalid1.length,
    lines: jInvalid1[0]?.lines.length,
    totalDebit: jInvalid1[0]?.total,
    balanced: jInvalid1[0]?.lines.reduce((s,l)=>s+l.debit,0) === jInvalid1[0]?.lines.reduce((s,l)=>s+l.credit,0)
  });

  // 8. Missing Role Failure Test
  // Generate an invoice, but remove 'receivable' role
  const badAccounts = testAccounts.map(a => a.role === 'receivable' ? { ...a, role: null } : a);
  const invoice = { id: 'inv1', total: 1000, taxAmount: 0, adBudgetTotal: 0 };
  const jMissingRole = buildJournal({ invoices: [invoice], accounts: badAccounts });
  
  results.missingRole.push({
    test: 'Invoice missing receivable role',
    generatedEntries: jMissingRole.length
  });

  fs.writeFileSync('test_results.json', JSON.stringify(results, null, 2));
  console.log('Tests executed, results saved to test_results.json');
}

runTests();
