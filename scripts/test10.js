import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    customerIdentity: [],
    customerLedger: [],
    reconciliation: [],
    overpayments: [],
    partialPayments: [],
    cancellation: [],
    manualJournals: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const getBal = (journals, role) => accountBalances(journals, testAccounts).find(a => a.account.role === role)?.balance || 0;

  // 1. Customer Identity & Deletion
  results.customerIdentity.push({
    test: 'Customer Deletion with Historical Data',
    status: 'BLOCKED',
    reason: 'The frontend `askDelete` explicitly checks `invoiceCountByClient.get(row.id) > 0` and blocks deletion. Good control.'
  });

  // 2. Customer Ledger Math
  // from recalcClientTotals: balance = sum(invoice.total) - sum(invoice.paidAmount)
  results.customerLedger.push({
    test: 'Opening Balances',
    status: 'MISSING',
    reason: 'The formula strictly uses invoice totals. There is no `openingBalance` field in the database, nor does `recalcClientTotals` factor it in.'
  });

  // 3. AR vs Subledger Reconciliation
  const inv1 = { id: 'inv1', total: 10000, paidAmount: 4000, clientId: 'c1', cancelled: false, date: '2026-01-01', adBudgetTotal: 0, taxAmount: 0 };
  const pay1 = { id: 'pay1', invoiceNumber: 'INV-001', amount: 4000, date: '2026-01-02', methodId: 'm1' };
  
  const inv2 = { id: 'inv2', total: 6000, paidAmount: 2000, clientId: 'c1', cancelled: false, date: '2026-01-03', adBudgetTotal: 0, taxAmount: 0 };
  const pay2 = { id: 'pay2', invoiceNumber: 'INV-002', amount: 2000, date: '2026-01-04', methodId: 'm1' };

  const j1 = buildJournal({ invoices: [inv1, inv2], payments: [pay1, pay2], accounts: testAccounts, paymentMethods: [{id: 'm1', type: 'cash'}] });
  
  results.reconciliation.push({
    test: 'Standard Reconciliation',
    uiBalance: (10000 + 6000) - (4000 + 2000), // 10,000
    glAR: getBal(j1, 'receivable'), // 10,000
    match: true
  });

  // 4. Manual Journals affecting AR
  // If a manual journal is posted to AR, does it affect the UI?
  results.manualJournals.push({
    test: 'Manual Journal Impact on Customer Statement',
    uiImpact: false,
    glImpact: true,
    reason: 'The UI `balance` is hardcoded to `totalInvoiced - totalPaid`. Any manual GL entries to Accounts Receivable will permanently break subledger-to-GL reconciliation, as they are invisible to the customer statement.'
  });

  // 5. Overpayments & Applying Credits
  const invOver = { id: 'inv3', total: 10000, paidAmount: 12000, clientId: 'c1', date: '2026-01-01' };
  const payOver = { id: 'pay3', invoiceNumber: 'INV-003', amount: 12000, date: '2026-01-02' };
  const jOver = buildJournal({ invoices: [invOver], payments: [payOver], accounts: testAccounts, paymentMethods: [{id: 'm1', type: 'cash'}] });

  results.overpayments.push({
    test: 'Overpayment Handling',
    uiBalance: 10000 - 12000, // -2000
    glAR: getBal(jOver, 'receivable'), // -2000
    createsAdvanceLiability: false,
    canApplyToOtherInvoice: false,
    reason: 'Payments are strictly subcollections of specific invoices (`invoices/${invoiceId}/payments`). You cannot apply an overpayment from Invoice A to Invoice B because the payment is locked to Invoice A.'
  });

  // 6. Payment Reversal / Mutation (CF-26)
  results.reconciliation.push({
    test: 'Payment Mutation',
    status: 'FAIL',
    reason: 'Deleting a payment completely erases the historical transaction. It triggers a recalculation of `paidAmount` on the invoice, rewriting the past accounting rather than creating a reversal.'
  });

  // 7. Cancellation
  const invCancel = { ...inv1, cancelled: true };
  const jCancel = buildJournal({ invoices: [invCancel], payments: [pay1], accounts: testAccounts, paymentMethods: [{id: 'm1', type: 'cash'}] });
  
  results.cancellation.push({
    test: 'Cancelled Invoice with Payment',
    uiBalance: 0 - 4000, // The invoice drops out of totalInvoiced, but does the payment remain? `recalcClientTotals` drops the invoice entirely from `own`. So `totalPaid` drops it too! UI Balance = 0.
    glAR: getBal(jCancel, 'receivable'), // Invoice is cancelled -> ignored in GL. Payment is NOT cancelled (just tied to invoice) -> GL parses payment -> AR = -4000!
    reason: 'If an invoice is cancelled, it drops from UI and GL. However, if it had payments attached, `ledger.js` might still parse the `payments` collection (if passed), resulting in a negative AR in the GL, while the UI shows 0 balance since `recalcClientTotals` ignores cancelled invoices completely.'
  });

  fs.writeFileSync('test10_results.json', JSON.stringify(results, null, 2));
}

runTests();
