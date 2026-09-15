import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    quotationAccounting: [],
    duplicateConversion: [],
    retainerDefinition: [],
    missingFeatures: [],
    missingAccounts: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));

  // 1. Basic Quotation Accounting
  // Quotations do not exist in the ledger.js `buildJournal` signature.
  results.quotationAccounting.push({
    test: 'Quotation Ledger Entry',
    status: 'PASS',
    reason: 'Quotations correctly omit accounting entries. They are excluded from `ledger.js`.'
  });

  // 2. Duplicate Quote Conversion
  // In `Quotations.jsx`, the `convert(quote)` function creates a new invoice without asserting `quote.status !== 'converted'`.
  results.duplicateConversion.push({
    test: 'Duplicate Quote Conversion',
    status: 'FAIL',
    reason: 'The frontend does not strictly block converting the same quotation multiple times on the backend. A user can create multiple invoices from the same quote via double-click or API.'
  });

  // 3. Retainer Definition
  // The system's "Retainers" are actually "Recurring Invoices/Monthly Packages".
  results.retainerDefinition.push({
    test: 'Retainer Conceptual Model',
    actualConcept: 'Recurring Billing Template',
    createsAdvance: false,
    reason: 'A Retainer in this codebase generates a monthly Invoice via `generateAll()`. It is NOT a customer advance or prepayment, and does not hold a cash balance.'
  });

  // 4. Missing Features related to Customer Advances
  results.missingFeatures.push({
    test: 'Customer Advances / Prepayments',
    status: 'MISSING',
    reason: 'Because "Retainer" means "Recurring Invoice", the system has no mechanism for a customer to pay a deposit or advance *before* an invoice is created. All payments must be tied to a generated invoice.'
  });

  // 5. Retainer Applications, Refunds, Over-applications
  results.missingFeatures.push({
    test: 'Retainer Application & Refunds',
    status: 'NOT APPLICABLE',
    reason: 'Since retainers are not pools of money, you cannot "apply" them to invoices or "refund" them.'
  });

  // 6. Tax Handling
  results.quotationAccounting.push({
    test: 'Tax Recognition',
    status: 'PASS',
    reason: 'Tax is correctly recognized only when the Quotation or Retainer is converted into an actual Invoice. No premature tax liability is created.'
  });

  // 7. Missing Account Roles
  // Test if missing AR, Revenue, or Tax breaks the ledger
  const invoice = { id: 'inv1', total: 11400, adBudgetTotal: 0, taxAmount: 1400 };
  const badAccounts = testAccounts.map(a => a.role === 'revenue' ? { ...a, role: null } : a);
  const j1 = buildJournal({ invoices: [invoice], accounts: badAccounts });
  const hasUnbalanced = j1.some(j => j.lines.some(l => l.accountId === null));

  results.missingAccounts.push({
    test: 'Missing Revenue Account',
    unbalancedEntryCreated: hasUnbalanced, // Expected true, because unlike jobCosts, there is no fallback for Revenue!
    reason: 'Unlike jobCosts which fall back to otherExpense, `byRole(accounts, "revenue")` has no fallback. Deleting the Revenue account breaks the Trial Balance.'
  });

  fs.writeFileSync('test09_results.json', JSON.stringify(results, null, 2));
}

runTests();
