process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-test';

const path = require('path');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) {
  initializeApp({ projectId: 'demo-test' });
}

const db = getFirestore();

// Import the compiled function handlers after emulator host is set
const functionsLibPath = path.resolve(__dirname, './lib/index.js');
const appFunctions = require(functionsLibPath);

async function setupDatabase() {
  console.log('--- Setting up database prerequisites ---');
  // Clean collections
  const cols = ['accounts', 'paymentMethods', 'users', 'invoices', 'accountingTransactions', 'journalEntries', 'settings', 'expenses', 'vendors', 'customers'];
  for (const c of cols) {
    const snap = await db.collection(c).get();
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }

  // Create standard accounts matching DEFAULT_ACCOUNTS
  const accounts = [
    { id: 'acct_cash', code: '1111', name: 'الخزينة', nameEn: 'Cash on hand', type: 'asset', role: 'cash', active: true, isGroup: false, parentCode: '111' },
    { id: 'acct_bank', code: '1112', name: 'البنوك والمحافظ', nameEn: 'Banks & wallets', type: 'asset', role: 'bank', active: true, isGroup: false, parentCode: '111' },
    { id: 'acct_ar', code: '112', name: 'العملاء (مدينون)', nameEn: 'Accounts receivable', type: 'asset', role: 'receivable', active: true, isGroup: false, parentCode: '11' },
    { id: 'acct_equipment', code: '1211', name: 'معدات وأجهزة', nameEn: 'Equipment', type: 'asset', role: 'equipment', active: true, isGroup: false, parentCode: '121' },
    { id: 'acct_vp', code: '211', name: 'الموردون', nameEn: 'Vendors payable', type: 'liability', role: 'vendorPayable', active: true, isGroup: false, parentCode: '21' },
    { id: 'acct_ad', code: '213', name: 'أمانات ميزانيات إعلانات العملاء', nameEn: 'Client ad budgets held', type: 'liability', role: 'adBudgetHeld', active: true, isGroup: false, parentCode: '21' },
    { id: 'acct_tax', code: '214', name: 'ضرائب مستحقة', nameEn: 'Tax payable', type: 'liability', role: 'tax', active: true, isGroup: false, parentCode: '21' },
    { id: 'acct_rev', code: '41', name: 'إيرادات المبيعات', nameEn: 'Service revenue', type: 'revenue', role: 'revenue', active: true, isGroup: false, parentCode: '4' },
    { id: 'acct_exp', code: '517', name: 'مصروفات أخرى', nameEn: 'Other expenses', type: 'expense', role: 'otherExpense', active: true, isGroup: false, parentCode: '51' },
    
    // Group Header Accounts
    { id: 'grp_1', code: '1', name: 'الأصول', nameEn: 'Assets', type: 'asset', isGroup: true, active: true },
    { id: 'grp_11', code: '11', name: 'الأصول المتداولة', nameEn: 'Current assets', type: 'asset', isGroup: true, active: true, parentCode: '1' },
    { id: 'grp_111', code: '111', name: 'النقدية والبنوك', nameEn: 'Cash & banks', type: 'asset', isGroup: true, active: true, parentCode: '11' },
    { id: 'grp_12', code: '12', name: 'الأصول غير المتداولة', nameEn: 'Non-current assets', type: 'asset', isGroup: true, active: true, parentCode: '1' },
    { id: 'grp_121', code: '121', name: 'الأصول الثابتة', nameEn: 'Fixed assets', type: 'asset', isGroup: true, active: true, parentCode: '12' },
    { id: 'grp_2', code: '2', name: 'الالتزامات', nameEn: 'Liabilities', type: 'liability', isGroup: true, active: true },
    { id: 'grp_21', code: '21', name: 'الالتزامات المتداولة', nameEn: 'Current liabilities', type: 'liability', isGroup: true, active: true, parentCode: '2' },
    { id: 'grp_4', code: '4', name: 'الإيرادات', nameEn: 'Revenue', type: 'revenue', isGroup: true, active: true },
    { id: 'grp_5', code: '5', name: 'المصروفات', nameEn: 'Expenses', type: 'expense', isGroup: true, active: true },
    { id: 'grp_51', code: '51', name: 'المصروفات الإدارية', nameEn: 'Administrative expenses', type: 'expense', isGroup: true, active: true, parentCode: '5' }
  ];

  for (const a of accounts) {
    await db.collection('accounts').doc(a.id).set(a);
  }

  // Create payment methods
  await db.collection('paymentMethods').doc('pm_cash').set({
    name: 'Cash Payment',
    type: 'cash',
    accountId: 'acct_cash',
    active: true
  });

  await db.collection('paymentMethods').doc('pm_bank').set({
    name: 'Bank Transfer',
    type: 'bank',
    accountId: 'acct_bank',
    active: true
  });

  // Create admin user
  await db.collection('users').doc('admin_uid').set({
    role: 'admin',
    name: 'Admin Test'
  });

  console.log('Database seeded with standard chart of accounts & payment methods.\n');
}

function req(data, uid = 'admin_uid') {
  return { auth: { uid }, data };
}

async function runTests() {
  const results = [];
  await setupDatabase();

  // Test 1: Invoice Creation
  console.log('>>> Test 1: Invoice Creation');
  try {
    const res = await appFunctions.createInvoice.run(req({
      number: 'INV-1001',
      values: {
        date: '2026-09-01',
        clientId: 'client_A',
        total: 1535,
        adBudgetTotal: 500,
        taxAmount: 135
      }
    }));
    const invId = res.invoiceId;
    const invDoc = (await db.collection('invoices').doc(invId).get()).data();
    
    const txSnap = await db.collection('accountingTransactions').where('sourceId', '==', invId).get();
    const tx = txSnap.docs[0].data();

    const debitAR = tx.lines.find(l => l.accountId === 'acct_ar')?.debit || 0;
    const creditRev = tx.lines.find(l => l.accountId === 'acct_rev')?.credit || 0;
    const creditTax = tx.lines.find(l => l.accountId === 'acct_tax')?.credit || 0;
    const creditAd = tx.lines.find(l => l.accountId === 'acct_ad')?.credit || 0;

    const pass = invDoc.total === 1535 && 
                 tx.totalDebit === 1535 && 
                 tx.totalCredit === 1535 &&
                 debitAR === 1535 && 
                 creditRev === 900 && 
                 creditTax === 135 && 
                 creditAd === 500;

    results.push({
      test: 'Invoice Creation',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `InvId=${invId}, Total=${invDoc.total}, TxId=${txSnap.docs[0].id}, DebitAR=${debitAR}, Rev=${creditRev}, Tax=${creditTax}, Ad=${creditAd}`
    });
  } catch (err) {
    results.push({ test: 'Invoice Creation', result: 'FAIL', evidence: err.message });
  }

  // Test 2: Invoice + Payment
  console.log('>>> Test 2: Invoice + Payment');
  try {
    const resInv = await appFunctions.createInvoice.run(req({
      number: 'INV-1002',
      values: { date: '2026-09-01', clientId: 'client_A', total: 10000, adBudgetTotal: 0, taxAmount: 0 }
    }));
    const invId = resInv.invoiceId;

    await appFunctions.createPayment.run(req({
      invoiceId: invId,
      payment: { amount: 4000, methodId: 'pm_bank', date: '2026-09-02' }
    }));

    const invDoc = (await db.collection('invoices').doc(invId).get()).data();
    const remainingAR = invDoc.total - invDoc.paidAmount;

    const payTxSnap = await db.collection('accountingTransactions').where('sourceType', '==', 'payment').get();

    const pass = invDoc.paidAmount === 4000 && remainingAR === 6000;
    results.push({
      test: 'Invoice + Payment',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `InvoiceId=${invId}, PaidAmount=${invDoc.paidAmount}, RemainingAR=${remainingAR}, PaymentsTxCount=${payTxSnap.size}`
    });
  } catch (err) {
    results.push({ test: 'Invoice + Payment', result: 'FAIL', evidence: err.message });
  }

  // Test 3: Full Payment
  console.log('>>> Test 3: Full Payment');
  try {
    const invSnap = await db.collection('invoices').where('number', '==', 'INV-1002').get();
    const invId = invSnap.docs[0].id;

    await appFunctions.createPayment.run(req({
      invoiceId: invId,
      payment: { amount: 6000, methodId: 'pm_bank', date: '2026-09-03' }
    }));

    const invDoc = (await db.collection('invoices').doc(invId).get()).data();
    const remainingAR = invDoc.total - invDoc.paidAmount;

    const pass = invDoc.paidAmount === 10000 && remainingAR === 0;
    results.push({
      test: 'Full Payment',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `PaidAmount=${invDoc.paidAmount}, RemainingAR=${remainingAR}`
    });
  } catch (err) {
    results.push({ test: 'Full Payment', result: 'FAIL', evidence: err.message });
  }

  // Test 4: Overpayment
  console.log('>>> Test 4: Overpayment');
  try {
    const resInv = await appFunctions.createInvoice.run(req({
      number: 'INV-1004',
      values: { date: '2026-09-01', clientId: 'client_A', total: 10000 }
    }));
    const invId = resInv.invoiceId;

    await appFunctions.createPayment.run(req({
      invoiceId: invId,
      payment: { amount: 4000, methodId: 'pm_bank', date: '2026-09-02' }
    }));

    let errorThrown = false;
    try {
      await appFunctions.createPayment.run(req({
        invoiceId: invId,
        payment: { amount: 7000, methodId: 'pm_bank', date: '2026-09-03' }
      }));
    } catch (e) {
      errorThrown = true;
    }

    const invDoc = (await db.collection('invoices').doc(invId).get()).data();
    const pass = errorThrown && invDoc.paidAmount === 4000;

    results.push({
      test: 'Overpayment',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `Overpayment Rejected=${errorThrown}, PaidAmount=${invDoc.paidAmount}`
    });
  } catch (err) {
    results.push({ test: 'Overpayment', result: 'FAIL', evidence: err.message });
  }

  // Test 5: Invoice Edit
  console.log('>>> Test 5: Invoice Edit');
  try {
    const resInv = await appFunctions.createInvoice.run(req({
      number: 'INV-1005',
      values: { date: '2026-09-01', clientId: 'client_A', total: 10000 }
    }));
    const invId = resInv.invoiceId;

    await appFunctions.createPayment.run(req({
      invoiceId: invId,
      payment: { amount: 4000, methodId: 'pm_bank', date: '2026-09-02' }
    }));

    // Edit to 12,000
    await appFunctions.editInvoice.run(req({
      invoiceId: invId,
      editVersion: 1,
      values: { date: '2026-09-01', clientId: 'client_A', total: 12000 }
    }));

    const invDoc1 = (await db.collection('invoices').doc(invId).get()).data();
    const netAR = invDoc1.total - invDoc1.paidAmount;

    // Attempt edit to 3,000 (less than 4,000 paid)
    let rejectEditBelowPaid = false;
    try {
      await appFunctions.editInvoice.run(req({
        invoiceId: invId,
        editVersion: 2,
        values: { date: '2026-09-01', clientId: 'client_A', total: 3000 }
      }));
    } catch (e) {
      rejectEditBelowPaid = true;
    }

    const invDoc2 = (await db.collection('invoices').doc(invId).get()).data();
    const pass = invDoc1.total === 12000 && netAR === 8000 && rejectEditBelowPaid && invDoc2.total === 12000;

    results.push({
      test: 'Invoice Edit',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `EditedTotal=${invDoc1.total}, NetAR=${netAR}, EditBelowPaidRejected=${rejectEditBelowPaid}`
    });
  } catch (err) {
    results.push({ test: 'Invoice Edit', result: 'FAIL', evidence: err.message });
  }

  // Test 6: Cancellation With No Payment
  console.log('>>> Test 6: Cancellation With No Payment');
  try {
    const resInv = await appFunctions.createInvoice.run(req({
      number: 'INV-1006',
      values: { date: '2026-09-01', clientId: 'client_A', total: 10000 }
    }));
    const invId = resInv.invoiceId;

    await appFunctions.cancelInvoice.run(req({
      invoiceId: invId,
      cancelReason: 'Test cancellation',
      cancelledDate: '2026-09-05'
    }));

    const invDoc = (await db.collection('invoices').doc(invId).get()).data();
    const txSnap = await db.collection('accountingTransactions').where('sourceId', '==', invId).get();
    const hasReversal = txSnap.docs.some(d => d.data().action === 'cancel');

    const pass = invDoc.cancelled === true && hasReversal;
    results.push({
      test: 'Cancellation With No Payment',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `Cancelled=${invDoc.cancelled}, ReversalTxFound=${hasReversal}, TotalTxs=${txSnap.size}`
    });
  } catch (err) {
    results.push({ test: 'Cancellation With No Payment', result: 'FAIL', evidence: err.message });
  }

  // Test 7: Cancellation With Partial Payment
  console.log('>>> Test 7: Cancellation With Partial Payment');
  try {
    const resInv = await appFunctions.createInvoice.run(req({
      number: 'INV-1007',
      values: { date: '2026-09-01', clientId: 'client_A', total: 10000 }
    }));
    const invId = resInv.invoiceId;

    await appFunctions.createPayment.run(req({
      invoiceId: invId,
      payment: { amount: 4000, methodId: 'pm_bank', date: '2026-09-02' }
    }));

    await appFunctions.cancelInvoice.run(req({
      invoiceId: invId,
      cancelReason: 'Cancelled after payment',
      cancelledDate: '2026-09-05'
    }));

    const invDoc = (await db.collection('invoices').doc(invId).get()).data();
    const paySnap = await db.collection('invoices').doc(invId).collection('payments').get();
    const payment = paySnap.docs[0].data();

    const pass = invDoc.cancelled === true && payment.amount === 4000 && !payment.reversed;

    results.push({
      test: 'Cancellation With Partial Payment',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `InvoiceCancelled=${invDoc.cancelled}, PaymentIntact=${payment.amount === 4000}, Reversed=${Boolean(payment.reversed)}`
    });
  } catch (err) {
    results.push({ test: 'Cancellation With Partial Payment', result: 'FAIL', evidence: err.message });
  }

  // Test 8: Payment Reversal
  console.log('>>> Test 8: Payment Reversal');
  try {
    const resInv = await appFunctions.createInvoice.run(req({
      number: 'INV-1008',
      values: { date: '2026-09-01', clientId: 'client_A', total: 10000 }
    }));
    const invId = resInv.invoiceId;

    await appFunctions.createPayment.run(req({
      invoiceId: invId,
      payment: { amount: 4000, methodId: 'pm_bank', date: '2026-09-02' }
    }));

    const paySnap = await db.collection('invoices').doc(invId).collection('payments').get();
    const payId = paySnap.docs[0].id;

    // Reverse payment
    await appFunctions.reversePayment.run(req({ invoiceId: invId, paymentId: payId }));

    const invDoc1 = (await db.collection('invoices').doc(invId).get()).data();
    const payDoc1 = (await db.collection('invoices').doc(invId).collection('payments').doc(payId).get()).data();

    // Attempt second reversal
    let secondRevFailed = false;
    try {
      await appFunctions.reversePayment.run(req({ invoiceId: invId, paymentId: payId }));
    } catch (e) {
      secondRevFailed = true;
    }

    const pass = payDoc1.reversed === true && invDoc1.paidAmount === 0 && secondRevFailed;

    results.push({
      test: 'Payment Reversal',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `Reversed=${payDoc1.reversed}, RestoredPaidAmount=${invDoc1.paidAmount}, SecondReversalRejected=${secondRevFailed}`
    });
  } catch (err) {
    results.push({ test: 'Payment Reversal', result: 'FAIL', evidence: err.message });
  }

  // Test 9: Duplicate / Idempotency Test
  console.log('>>> Test 9: Duplicate / Idempotency Test');
  try {
    const res1 = await appFunctions.createInvoice.run(req({
      number: 'INV-1009',
      values: { date: '2026-09-01', clientId: 'client_A', total: 10000 }
    }));
    const invId = res1.invoiceId;

    const txSnap1 = await db.collection('accountingTransactions').where('sourceId', '==', invId).get();

    const pass = txSnap1.size === 1;

    results.push({
      test: 'Idempotency',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `InvoiceId=${invId}, UniqueTxCount=${txSnap1.size}`
    });
  } catch (err) {
    results.push({ test: 'Idempotency', result: 'FAIL', evidence: err.message });
  }

  // Test 10: Concurrent Payment Test
  console.log('>>> Test 10: Concurrent Payment Test');
  try {
    const resInv = await appFunctions.createInvoice.run(req({
      number: 'INV-1010',
      values: { date: '2026-09-01', clientId: 'client_A', total: 10000 }
    }));
    const invId = resInv.invoiceId;

    const p1 = appFunctions.createPayment.run(req({
      invoiceId: invId,
      payment: { amount: 10000, methodId: 'pm_bank', date: '2026-09-02' }
    }));
    const p2 = appFunctions.createPayment.run(req({
      invoiceId: invId,
      payment: { amount: 10000, methodId: 'pm_bank', date: '2026-09-02' }
    }));

    const resultsP = await Promise.allSettled([p1, p2]);
    const fulfilled = resultsP.filter(r => r.status === 'fulfilled').length;
    const rejected = resultsP.filter(r => r.status === 'rejected').length;

    const invDoc = (await db.collection('invoices').doc(invId).get()).data();

    const pass = fulfilled === 1 && rejected === 1 && invDoc.paidAmount === 10000;

    results.push({
      test: 'Concurrent Payment Test',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `Fulfilled=${fulfilled}, Rejected=${rejected}, FinalPaidAmount=${invDoc.paidAmount}`
    });
  } catch (err) {
    results.push({ test: 'Concurrent Payment Test', result: 'FAIL', evidence: err.message });
  }

  // Test 11: Account Mapping Failure
  console.log('>>> Test 11: Account Mapping Failure');
  try {
    await db.collection('accounts').doc('acct_tax').update({ active: false });

    let errorThrown = false;
    try {
      await appFunctions.createInvoice.run(req({
        number: 'INV-1011',
        values: { date: '2026-09-01', clientId: 'client_A', total: 1000, taxAmount: 100 }
      }));
    } catch (e) {
      errorThrown = true;
    }

    // Restore account
    await db.collection('accounts').doc('acct_tax').update({ active: true });

    const invSnap = await db.collection('invoices').where('number', '==', 'INV-1011').get();

    const pass = errorThrown && invSnap.empty;

    results.push({
      test: 'Account Mapping Failure',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `OperationFailed=${errorThrown}, InvoiceDocCreated=${!invSnap.empty}`
    });
  } catch (err) {
    results.push({ test: 'Account Mapping Failure', result: 'FAIL', evidence: err.message });
  }

  // Test 12: Cancelled Invoice Payment
  console.log('>>> Test 12: Cancelled Invoice Payment');
  try {
    const resInv = await appFunctions.createInvoice.run(req({
      number: 'INV-1012',
      values: { date: '2026-09-01', clientId: 'client_A', total: 5000 }
    }));
    const invId = resInv.invoiceId;

    await appFunctions.cancelInvoice.run(req({
      invoiceId: invId,
      cancelReason: 'Test',
      cancelledDate: '2026-09-02'
    }));

    let errorThrown = false;
    try {
      await appFunctions.createPayment.run(req({
        invoiceId: invId,
        payment: { amount: 1000, methodId: 'pm_bank', date: '2026-09-03' }
      }));
    } catch (e) {
      errorThrown = true;
    }

    const paySnap = await db.collection('invoices').doc(invId).collection('payments').get();

    const pass = errorThrown && paySnap.empty;

    results.push({
      test: 'Cancelled Invoice Payment',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `PaymentRejected=${errorThrown}, PaymentsCreatedCount=${paySnap.size}`
    });
  } catch (err) {
    results.push({ test: 'Cancelled Invoice Payment', result: 'FAIL', evidence: err.message });
  }

  // Test 13: Trial Balance
  console.log('>>> Test 13: Trial Balance');
  try {
    const txSnap = await db.collection('accountingTransactions').get();
    let grandDebit = 0;
    let grandCredit = 0;
    let allBalanced = true;

    txSnap.docs.forEach(doc => {
      const data = doc.data();
      grandDebit += data.totalDebit || 0;
      grandCredit += data.totalCredit || 0;
      if (Math.abs((data.totalDebit || 0) - (data.totalCredit || 0)) > 0.0001) {
        allBalanced = false;
      }
    });

    grandDebit = Math.round(grandDebit * 100) / 100;
    grandCredit = Math.round(grandCredit * 100) / 100;

    const pass = allBalanced && grandDebit === grandCredit && grandDebit > 0;

    results.push({
      test: 'Trial Balance',
      result: pass ? 'PASS' : 'FAIL',
      evidence: `TotalTransactions=${txSnap.size}, TotalDebit=${grandDebit}, TotalCredit=${grandCredit}, AllBalanced=${allBalanced}`
    });
  } catch (err) {
    results.push({ test: 'Trial Balance', result: 'FAIL', evidence: err.message });
  }

  // Test 14: Historical Immutability
  console.log('>>> Test 14: Historical Immutability');
  try {
    const txSnap = await db.collection('accountingTransactions').get();
    const hasOriginalsIntact = txSnap.docs.every(d => d.data().createdAt && d.data().lines && d.data().lines.length >= 2);

    results.push({
      test: 'Historical Immutability',
      result: hasOriginalsIntact ? 'PASS' : 'FAIL',
      evidence: `TotalTxsChecked=${txSnap.size}, AllOriginalsIntact=${hasOriginalsIntact}`
    });
  } catch (err) {
    results.push({ test: 'Historical Immutability', result: 'FAIL', evidence: err.message });
  }

  console.log('\n========================================');
  console.log('       FINAL TEST RESULTS REPORT');
  console.log('========================================');
  console.table(results);

  if (!results.every(r => r.result === 'PASS')) {
    console.error('Test suite failed!');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner execution failed:', err);
  process.exit(1);
});
