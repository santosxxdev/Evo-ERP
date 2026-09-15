import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    receipt: [],
    expense: [],
    transfer: [],
    overpayment: [],
    multiTreasury: [],
    missing: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const getBal = (journals, role) => accountBalances(journals, testAccounts).find(a => a.account.role === role)?.balance || 0;
  const cashAcc = testAccounts.find(a => a.role === 'cash').id;
  const bankAcc = testAccounts.find(a => a.role === 'bank').id;

  const paymentMethods = [
    { id: 'pm1', type: 'cash', accountId: cashAcc },
    { id: 'pm2', type: 'bank', accountId: bankAcc }
  ];

  // 1. CASH RECEIPT (Customer Payment)
  const payment1 = { id: 'pay1', amount: 10000, methodId: 'pm1', date: '2026-01-01' };
  const jReceipt = buildJournal({ payments: [payment1], accounts: testAccounts, paymentMethods });

  results.receipt.push({
    test: 'Customer Payment 10,000 to Cash',
    cashBalance: getBal(jReceipt, 'cash'), // Expected 10000
    arBalance: getBal(jReceipt, 'receivable') // Expected -10000 (credit)
  });

  // 2. CASH PAYMENT (Expense)
  const expense1 = { id: 'e1', amount: 5000, settled: true, methodId: 'pm1', date: '2026-01-01', categoryId: 'cat1' };
  const jExpense = buildJournal({ expenses: [expense1], accounts: testAccounts, paymentMethods, expenseCategories: [{ id: 'cat1', name: 'General' }] });

  results.expense.push({
    test: 'Expense Payment 5,000 from Cash',
    cashBalance: getBal(jExpense, 'cash'), // Expected -5000
    expenseBalance: getBal(jExpense, 'otherExpense') // Expected 5000
  });

  // 3. TRANSFER
  const transferVoucher = { 
    id: 'v1', type: 'transfer', date: '2026-01-02', 
    lines: [
      { accountId: bankAcc, debit: 3000, credit: 0 },
      { accountId: cashAcc, debit: 0, credit: 3000 }
    ] 
  };
  const jTransfer = buildJournal({ vouchers: [transferVoucher], accounts: testAccounts });

  results.transfer.push({
    test: 'Transfer 3000 Cash -> Bank',
    cashBalance: getBal(jTransfer, 'cash'), // Expected -3000
    bankBalance: getBal(jTransfer, 'bank'), // Expected 3000
    isBalanced: getBal(jTransfer, 'cash') + getBal(jTransfer, 'bank') === 0
  });

  // 4. MULTIPLE TREASURY ACCOUNTS
  // If we create a custom account for another bank, say Bank B, and link a payment method to it.
  const customBankId = 'acc_custom_bank';
  const accountsMulti = [...testAccounts, { id: customBankId, code: '1113', role: 'custom', isGroup: false }];
  const paymentMethodsMulti = [...paymentMethods, { id: 'pm3', type: 'bank', accountId: customBankId }];
  
  const payment2 = { id: 'pay2', amount: 7000, methodId: 'pm3', date: '2026-01-03' };
  const jMulti = buildJournal({ payments: [payment1, payment2], accounts: accountsMulti, paymentMethods: paymentMethodsMulti });
  
  results.multiTreasury.push({
    test: 'Payment to Custom Bank B (7000) vs Cash (10000)',
    cashBalance: getBal(jMulti, 'cash'), // Expected 10000
    customBankBalance: accountBalances(jMulti, accountsMulti).find(a => a.account.id === customBankId)?.balance // Expected 7000
  });

  // 5. OVERPAYMENT (Customer)
  // Create an invoice for 10000. Pay 12000.
  const invoice1 = { id: 'inv1', total: 10000, date: '2026-01-01' };
  const paymentOver = { id: 'pay_over', invoiceId: 'inv1', amount: 12000, methodId: 'pm1', date: '2026-01-02' };
  const jOver = buildJournal({ invoices: [invoice1], payments: [paymentOver], accounts: testAccounts, paymentMethods });

  results.overpayment.push({
    test: 'Overpayment of 12,000 on 10,000 invoice',
    cashBalance: getBal(jOver, 'cash'), // Expected 12000
    arBalance: getBal(jOver, 'receivable'), // Expected -2000 (10000 debit, 12000 credit) -> Credit balance
    revenueBalance: getBal(jOver, 'revenue') // Expected -10000
  });

  // Missing features
  results.missing.push({
    test: 'Missing Controls',
    openingBalances: false, // Must use manual voucher
    negativeBalancePrevention: false, // No code in ledger.js blocks negative cash
    duplicatePaymentPrevention: false // Payments are just recorded, no idempotency checks in ledger derivation
  });

  fs.writeFileSync('test05_results.json', JSON.stringify(results, null, 2));
}

runTests();
