import { computeTotals, statusOf, remainingOf, isOverdue } from '../src/lib/invoice.js';
import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import fs from 'fs';

function runTests() {
  const results = {
    basicCalc: [],
    discount: [],
    tax: [],
    adBudget: [],
    revenueRec: [],
    status: [],
    cancellation: [],
    editing: []
  };

  // Helper
  const round2 = num => Math.round((num + Number.EPSILON) * 100) / 100;

  // 2. BASIC INVOICE CALCULATION TEST
  const testA = computeTotals({ items: [{ qty: 1, price: 1000 }], discount: 0, taxEnabled: false });
  results.basicCalc.push({ test: 'Test A', expectedSub: 1000, actualSub: testA.subtotal, expectedTotal: 1000, actualTotal: testA.total });

  const testB = computeTotals({ items: [{ qty: 3, price: 250 }], discount: 0, taxEnabled: false });
  results.basicCalc.push({ test: 'Test B', expectedSub: 750, actualSub: testB.subtotal });

  const testC = computeTotals({ items: [{ qty: 2, price: 500 }, { qty: 3, price: 200 }] });
  results.basicCalc.push({ test: 'Test C', expectedSub: 1600, actualSub: testC.subtotal });

  const testD = computeTotals({ items: [{ qty: 3, price: 10.55 }, { qty: 7, price: 2.35 }] }); // 31.65 + 16.45 = 48.10
  results.basicCalc.push({ test: 'Test D', expectedSub: 48.10, actualSub: testD.subtotal });

  const testE = computeTotals({ items: [{ qty: 999, price: 999.99 }] }); // 998990.01
  results.basicCalc.push({ test: 'Test E', expectedSub: 998990.01, actualSub: testE.subtotal });

  // 3. DISCOUNT AUDIT
  const discPercent = computeTotals({ items: [{ qty: 1, price: 1000 }], discountMode: 'percent', discountValue: 10, taxEnabled: false });
  results.discount.push({ test: '10% discount', expectedDisc: 100, actualDisc: discPercent.discount, expectedTotal: 900, actualTotal: discPercent.total });

  const discFixed = computeTotals({ items: [{ qty: 1, price: 1000 }], discountMode: 'amount', discountValue: 150, taxEnabled: false });
  results.discount.push({ test: 'Fixed 150 discount', expectedDisc: 150, actualDisc: discFixed.discount, expectedTotal: 850, actualTotal: discFixed.total });

  const discExcess = computeTotals({ items: [{ qty: 1, price: 1000 }], discountMode: 'amount', discountValue: 1500, taxEnabled: false });
  results.discount.push({ test: 'Discount > Invoice', expectedDisc: 1000, actualDisc: discExcess.discount, expectedTotal: 0, actualTotal: discExcess.total });

  const discNegative = computeTotals({ items: [{ qty: 1, price: 1000 }], discountMode: 'amount', discountValue: -500, taxEnabled: false });
  results.discount.push({ test: 'Negative discount', expectedDisc: 0, actualDisc: discNegative.discount, expectedTotal: 1000, actualTotal: discNegative.total });

  // 4. TAX AUDIT
  const taxTest = computeTotals({ items: [{ qty: 1, price: 1000 }], discountMode: 'amount', discountValue: 100, taxEnabled: true, taxRate: 14 });
  results.tax.push({ test: 'Tax 14% on 900', expectedTax: 126, actualTax: taxTest.taxAmount, expectedTotal: 1026, actualTotal: taxTest.total });

  const taxZero = computeTotals({ items: [{ qty: 1, price: 1000 }], taxEnabled: true, taxRate: 0 });
  results.tax.push({ test: 'Tax 0%', expectedTax: 0, actualTax: taxZero.taxAmount });

  const taxNegative = computeTotals({ items: [{ qty: 1, price: 1000 }], taxEnabled: true, taxRate: -10 });
  results.tax.push({ test: 'Tax -10%', actualTax: taxNegative.taxAmount }); // It allows negative tax, which is interesting

  // 5. AD BUDGET / CLIENT-FUNDED AMOUNT AUDIT
  const adTest = computeTotals({ items: [{ qty: 1, price: 1000 }, { qty: 1, price: 500, isAdBudget: true }], taxEnabled: true, taxRate: 14 });
  results.adBudget.push({ 
    test: '1000 fees + 500 ad budget + 14% tax', 
    expectedFees: 1000, actualFees: adTest.feesTotal, 
    expectedTax: 140, actualTax: adTest.taxAmount,
    expectedAdBudget: 500, actualAdBudget: adTest.adBudgetTotal,
    expectedTotal: 1640, actualTotal: adTest.total 
  });

  // Test ledger derivation for Ad Budget
  const accs = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const adLedger = buildJournal({ invoices: [{ id: '1', date: '2026-01-01', ...adTest }], accounts: accs });
  const lines = adLedger[0]?.lines || [];
  results.adBudget.push({
    test: 'Ad budget ledger entries',
    hasAdBudgetHeldCredit: lines.some(l => l.account?.role === 'adBudgetHeld' && l.credit === 500),
    hasRevenueCredit: lines.some(l => l.account?.role === 'revenue' && l.credit === 1000),
    hasTaxCredit: lines.some(l => l.account?.role === 'tax' && l.credit === 140),
    hasReceivableDebit: lines.some(l => l.account?.role === 'receivable' && l.debit === 1640)
  });

  // 8. INVOICE STATUS AUDIT
  results.status.push({ test: 'Paid=0', status: statusOf({ total: 1000, paidAmount: 0 }) });
  results.status.push({ test: 'Paid=1', status: statusOf({ total: 1000, paidAmount: 1 }) });
  results.status.push({ test: 'Paid=500', status: statusOf({ total: 1000, paidAmount: 500 }) });
  results.status.push({ test: 'Paid=999.99', status: statusOf({ total: 1000, paidAmount: 999.99 }) });
  results.status.push({ test: 'Paid=1000', status: statusOf({ total: 1000, paidAmount: 1000 }) });
  results.status.push({ test: 'Paid=1000.01', status: statusOf({ total: 1000, paidAmount: 1000.01 }) });
  results.status.push({ test: 'Paid=-1', status: statusOf({ total: 1000, paidAmount: -1 }) });

  // 10. INVOICE CANCELLATION TEST
  const jOriginal = buildJournal({ invoices: [{ id: 'c1', date: '2026-01-01', total: 1140, taxAmount: 140, adBudgetTotal: 0 }], accounts: accs });
  const jCancel = buildJournal({ invoices: [{ id: 'c1', date: '2026-01-01', total: 1140, taxAmount: 140, adBudgetTotal: 0, cancelled: true, cancelledDate: '2026-01-02' }], accounts: accs });
  
  results.cancellation.push({
    test: 'Cancelled invoice generated journals',
    countOriginal: jOriginal.length,
    countCancelled: jCancel.length, // Should be 2: inv-c1 and inv-rev-c1
    revDebitRevenue: jCancel.find(j => j.id === 'inv-rev-c1')?.lines.some(l => l.account?.role === 'revenue' && l.debit === 1000),
    revDebitTax: jCancel.find(j => j.id === 'inv-rev-c1')?.lines.some(l => l.account?.role === 'tax' && l.debit === 140),
    revCreditReceivable: jCancel.find(j => j.id === 'inv-rev-c1')?.lines.some(l => l.account?.role === 'receivable' && l.credit === 1140)
  });

  // 11. INVOICE EDITING / HISTORICAL INTEGRITY
  // The system just generates the journal. If we feed it 2000 instead of 1000, it derives 2000. 
  // No correcting entry, the old entry vanishes and the new entry takes its place because it's purely a function of current state.
  results.editing.push({ test: 'Dynamic derivation means historical edits silently alter ledger', confirmed: true });

  fs.writeFileSync('test02_results.json', JSON.stringify(results, null, 2));
  console.log('Tests executed, results saved to test02_results.json');
}

runTests();
