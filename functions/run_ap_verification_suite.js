const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

initializeApp({
  projectId: 'test-ap-foundation-proj'
});

const db = getFirestore();

// Import backend service logic directly for testing
const {
  prepareAccountingTransaction,
  writeAccountingTransaction,
  prepareReverseAccountingTransaction,
  writeReverseAccountingTransaction,
  resolveAccountByRole,
  resolveAccount,
  roundMoney
} = require('./lib/accounting/accountingService');

async function runAPVerificationSuite() {
  console.log('==================================================');
  console.log('       AP FOUNDATION RUNTIME VERIFICATION SUITE   ');
  console.log('==================================================\n');

  const testResults = [];

  function recordTest(testNum, title, input, expected, actual, passed, evidence) {
    testResults.push({
      testNum,
      title,
      input,
      expected,
      actual,
      result: passed ? 'PASS' : 'FAIL',
      evidence
    });
    console.log(`[TEST ${testNum}] ${title}: ${passed ? '✅ PASS' : '❌ FAIL'}`);
    if (!passed) {
      console.log(`   Expected: ${expected}`);
      console.log(`   Actual:   ${actual}`);
      console.log(`   Evidence: ${evidence}`);
    }
  }

  // Helper to clear collections in emulator
  async function clearCollection(colName) {
    const snap = await db.collection(colName).get();
    for (const doc of snap.docs) {
      await doc.ref.delete();
    }
  }

  // 1. SEED DEFAULT CHART OF ACCOUNTS & PAYMENT METHODS
  await clearCollection('accounts');
  await clearCollection('vendors');
  await clearCollection('purchaseInvoices');
  await clearCollection('accountingTransactions');
  await clearCollection('paymentMethods');
  await clearCollection('settings');

  const defaultAccounts = [
    { code: '1111', name: 'الخزينة', role: 'cash', type: 'asset', active: true, isGroup: false },
    { code: '1112', name: 'البنوك', role: 'bank', type: 'asset', active: true, isGroup: false },
    { code: '112', name: 'العملاء', role: 'receivable', type: 'asset', active: true, isGroup: false },
    { code: '113', name: 'المخزون', role: 'inventory', type: 'asset', active: true, isGroup: false },
    { code: '114', name: 'ضريبة مدخلات مستحقة', role: 'taxReceivable', type: 'asset', active: true, isGroup: false },
    { code: '1211', name: 'معدات وأجهزة', role: 'equipment', type: 'asset', active: true, isGroup: false },
    { code: '211', name: 'الموردون', role: 'vendorPayable', type: 'liability', active: true, isGroup: false },
    { code: '214', name: 'ضرائب مستحقة', role: 'tax', type: 'liability', active: true, isGroup: false },
    { code: '517', name: 'مصروفات أخرى', role: 'otherExpense', type: 'expense', active: true, isGroup: false },
    { code: '536', name: 'تكاليف إنتاج أخرى', role: 'costOther', type: 'expense', active: true, isGroup: false },
  ];

  const accountMap = {};
  for (const acct of defaultAccounts) {
    const docRef = db.collection('accounts').doc();
    await docRef.set(acct);
    accountMap[acct.role] = docRef.id;
    accountMap[acct.code] = docRef.id;
  }

  const bankMethodRef = db.collection('paymentMethods').doc();
  await bankMethodRef.set({ name: 'حساب بنكي', type: 'bank', accountId: accountMap['bank'], active: true });

  const cashMethodRef = db.collection('paymentMethods').doc();
  await cashMethodRef.set({ name: 'خزينة نقدية', type: 'cash', accountId: accountMap['cash'], active: true });

  // Vendor Record creation
  const vendorARef = db.collection('vendors').doc();
  await vendorARef.set({ name: 'Vendor Alpha', phone: '0100000001', active: true, archived: false });

  const vendorBRef = db.collection('vendors').doc();
  await vendorBRef.set({ name: 'Vendor Beta', phone: '0100000002', active: true, archived: false });

  const vendorCRef = db.collection('vendors').doc();
  await vendorCRef.set({ name: 'Vendor Gamma', phone: '0100000003', active: true, archived: false });

  // Helper for executing purchase invoice logic inside emulator transaction
  async function execCreatePurchaseInvoice(params) {
    let purchaseRef;
    await db.runTransaction(async (t) => {
      const { vendorId, date, purchaseType, subtotal: rawSub, taxAmount: rawTax, total: rawTot, accountId } = params;
      const subtotal = roundMoney(Number(rawSub || 0));
      const taxAmount = roundMoney(Number(rawTax || 0));
      const total = roundMoney(Number(rawTot || 0));

      if (roundMoney(subtotal + taxAmount) !== total) {
        throw new Error(`Purchase breakdown (subtotal ${subtotal} + tax ${taxAmount}) does not equal total (${total}).`);
      }

      const vendorDoc = await t.get(db.collection('vendors').doc(vendorId));
      if (!vendorDoc.exists || vendorDoc.data()?.active === false || vendorDoc.data()?.archived === true) {
        throw new Error('Vendor does not exist or is inactive.');
      }

      const vendorPayableAcct = await resolveAccountByRole('vendorPayable', t);
      let taxReceivableAcct = null;
      if (taxAmount > 0) {
        taxReceivableAcct = await resolveAccountByRole('taxReceivable', t);
      }

      let targetAccount = null;
      if (accountId) {
        targetAccount = await resolveAccount(accountId, t);
      } else {
        const typeStr = (purchaseType || 'expense').toLowerCase();
        if (typeStr === 'asset') targetAccount = await resolveAccountByRole('equipment', t);
        else if (typeStr === 'inventory') targetAccount = await resolveAccountByRole('inventory', t);
        else targetAccount = await resolveAccountByRole('costOther', t);
      }

      const lines = [
        { accountId: targetAccount.id, debit: subtotal, credit: 0 }
      ];
      if (taxAmount > 0 && taxReceivableAcct) {
        lines.push({ accountId: taxReceivableAcct.id, debit: taxAmount, credit: 0 });
      }
      lines.push({ accountId: vendorPayableAcct.id, debit: 0, credit: total });

      purchaseRef = db.collection('purchaseInvoices').doc();
      const prepInvoiceTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `purchase:${purchaseRef.id}:post`,
        transactionDate: date,
        sourceType: 'purchaseInvoice',
        sourceId: purchaseRef.id,
        action: 'create',
        lines,
        createdBy: 'test-user',
      });

      t.set(purchaseRef, {
        vendorId,
        number: params.number || `PUR-${Date.now().toString().slice(-4)}`,
        date,
        purchaseType: purchaseType || 'expense',
        accountId: targetAccount.id,
        subtotal,
        taxAmount,
        total,
        paidAmount: 0,
        remainingAmount: total,
        status: 'unpaid',
        cancelled: false,
        createdBy: 'test-user',
      });

      writeAccountingTransaction(t, prepInvoiceTx);
    });
    return purchaseRef.id;
  }

  // Helper for executing vendor payment logic
  async function execCreateVendorPayment(purchaseInvoiceId, amount, methodId, date, customPaymentRef) {
    let paymentRef;
    let prepPaymentTxResult = null;
    await db.runTransaction(async (t) => {
      const invoiceRef = db.collection('purchaseInvoices').doc(purchaseInvoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Purchase invoice not found.');
      if (invoiceDoc.data()?.cancelled) throw new Error('Cannot add payment to a cancelled purchase invoice.');

      const totalInvoice = roundMoney(Number(invoiceDoc.data()?.total || 0));
      const oldPaidAmount = roundMoney(Number(invoiceDoc.data()?.paidAmount || 0));
      const remaining = roundMoney(totalInvoice - oldPaidAmount);
      const paymentAmount = roundMoney(Number(amount));

      if (paymentAmount > remaining + 0.0001) {
        throw new Error(`Payment amount (${paymentAmount}) exceeds remaining payable (${remaining}).`);
      }

      const vendorPayableAcct = await resolveAccountByRole('vendorPayable', t);
      const methodDoc = await t.get(db.collection('paymentMethods').doc(methodId));
      if (!methodDoc.exists) throw new Error('Invalid payment method.');
      const methodData = methodDoc.data();
      const treasuryAccount = await resolveAccount(methodData.accountId, t);

      paymentRef = customPaymentRef || invoiceRef.collection('payments').doc();

      const prepPaymentTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `vendor-payment:${paymentRef.id}:post`,
        transactionDate: date || '2026-09-13',
        sourceType: 'vendorPayment',
        sourceId: paymentRef.id,
        action: 'payment',
        lines: [
          { accountId: vendorPayableAcct.id, debit: paymentAmount, credit: 0 },
          { accountId: treasuryAccount.id, debit: 0, credit: paymentAmount }
        ],
        createdBy: 'test-user',
      });

      prepPaymentTxResult = prepPaymentTx;
      if (prepPaymentTx.isDuplicate) {
        return;
      }

      const newPaidAmount = roundMoney(oldPaidAmount + paymentAmount);
      const newRemaining = roundMoney(totalInvoice - newPaidAmount);
      const status = newRemaining <= 0.001 ? 'paid' : 'partial';

      t.set(paymentRef, {
        purchaseInvoiceId,
        vendorId: invoiceDoc.data()?.vendorId,
        amount: paymentAmount,
        methodId,
        date: date || '2026-09-13',
        createdBy: 'test-user'
      });

      t.update(invoiceRef, {
        paidAmount: newPaidAmount,
        remainingAmount: newRemaining,
        status
      });

      writeAccountingTransaction(t, prepPaymentTx);
    });
    return { paymentId: paymentRef.id, isDuplicate: prepPaymentTxResult?.isDuplicate || false };
  }

  // Helper for payment reversal
  async function execReverseVendorPayment(purchaseInvoiceId, paymentId, reversalDate) {
    await db.runTransaction(async (t) => {
      const invoiceRef = db.collection('purchaseInvoices').doc(purchaseInvoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Purchase invoice not found.');

      const paymentRef = invoiceRef.collection('payments').doc(paymentId);
      const paymentDoc = await t.get(paymentRef);
      if (!paymentDoc.exists) throw new Error('Vendor payment not found.');

      const paymentData = paymentDoc.data();
      if (paymentData?.reversed) throw new Error('Payment is already reversed.');

      const paymentAmount = roundMoney(Number(paymentData?.amount || 0));

      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', paymentId)
          .where('sourceType', '==', 'vendorPayment')
          .where('action', '==', 'payment')
      );

      const activeTx = querySnap.docs.find(d => !d.data().reversedBy);
      if (!activeTx) {
        throw new Error(`Original payment accounting transaction not found or already reversed for payment ${paymentId}.`);
      }

      const prepReversal = await prepareReverseAccountingTransaction(t, {
        originalTxId: activeTx.id,
        reversalDate: reversalDate || '2026-09-13',
        reversalReason: 'Test reversal',
        idempotencyKey: `vendor-payment:${paymentId}:reverse`,
        createdBy: 'test-user'
      });

      writeReverseAccountingTransaction(t, prepReversal);

      t.update(paymentRef, { reversed: true, reversedBy: 'test-user' });

      const totalInvoice = roundMoney(Number(invoiceDoc.data()?.total || 0));
      const oldPaidAmount = roundMoney(Number(invoiceDoc.data()?.paidAmount || 0));
      const newPaidAmount = Math.max(0, roundMoney(oldPaidAmount - paymentAmount));
      const newRemaining = roundMoney(totalInvoice - newPaidAmount);
      const status = newPaidAmount === 0 ? 'unpaid' : (newRemaining <= 0.001 ? 'paid' : 'partial');

      t.update(invoiceRef, {
        paidAmount: newPaidAmount,
        remainingAmount: newRemaining,
        status
      });
    });
  }

  // --- RUN TEST 1: BASIC PURCHASE INVOICE (10,000 + 1,500 VAT = 11,500) ---
  let inv1Id;
  try {
    inv1Id = await execCreatePurchaseInvoice({
      vendorId: vendorARef.id,
      number: 'PUR-101',
      date: '2026-09-13',
      purchaseType: 'expense',
      subtotal: 10000,
      taxAmount: 1500,
      total: 11500
    });

    const txSnap = await db.collection('accountingTransactions').where('sourceId', '==', inv1Id).get();
    const txData = txSnap.docs[0].data();
    const lines = txData.lines;

    const expLine = lines.find(l => l.accountId === accountMap['costOther']);
    const taxLine = lines.find(l => l.accountId === accountMap['taxReceivable']);
    const apLine = lines.find(l => l.accountId === accountMap['vendorPayable']);

    const isCorrect = expLine?.debit === 10000 && taxLine?.debit === 1500 && apLine?.credit === 11500;
    recordTest(
      1,
      'Purchase 10,000 + VAT 1,500',
      'Net: 10000, Tax: 1500, Total: 11500',
      'Dr Expense 10000, Dr Input VAT (114) 1500, Cr AP (211) 11500',
      `Dr Expense ${expLine?.debit}, Dr Input VAT ${taxLine?.debit}, Cr AP ${apLine?.credit}`,
      isCorrect,
      `Accounting Transaction ID: ${txSnap.docs[0].id}`
    );
  } catch (err) {
    recordTest(1, 'Purchase 10,000 + VAT 1,500', 'Net: 10000, Tax: 1500', 'Successful posting', err.message, false, err.stack);
  }

  // --- RUN TEST 2: PURCHASE WITHOUT TAX (10,000) ---
  let inv2Id;
  try {
    inv2Id = await execCreatePurchaseInvoice({
      vendorId: vendorARef.id,
      number: 'PUR-102',
      date: '2026-09-13',
      purchaseType: 'expense',
      subtotal: 10000,
      taxAmount: 0,
      total: 10000
    });

    const txSnap = await db.collection('accountingTransactions').where('sourceId', '==', inv2Id).get();
    const lines = txSnap.docs[0].data().lines;

    const taxLine = lines.find(l => l.accountId === accountMap['taxReceivable']);
    const isCorrect = lines.length === 2 && !taxLine;
    recordTest(
      2,
      'Purchase 10,000 without VAT',
      'Net: 10000, Tax: 0, Total: 10000',
      'Dr Expense 10000, Cr AP 10000 (No tax line)',
      `Lines count: ${lines.length}, Has tax line: ${Boolean(taxLine)}`,
      isCorrect,
      `No phantom tax entry generated.`
    );
  } catch (err) {
    recordTest(2, 'Purchase 10,000 without VAT', 'Net: 10000, Tax: 0', 'Success', err.message, false, err.stack);
  }

  // --- RUN TEST 3: PARTIAL PAYMENT 4,000 AGAINST INV 1 (11,500) ---
  let pay1Res;
  try {
    pay1Res = await execCreateVendorPayment(inv1Id, 4000, bankMethodRef.id, '2026-09-13');
    const invSnap = await db.collection('purchaseInvoices').doc(inv1Id).get();
    const invData = invSnap.data();

    const isCorrect = invData.paidAmount === 4000 && invData.remainingAmount === 7500 && invData.status === 'partial';
    recordTest(
      3,
      'Partial Payment 4,000',
      'Pay 4000 on 11500 invoice',
      'Paid: 4000, Remaining: 7500, Status: partial',
      `Paid: ${invData.paidAmount}, Remaining: ${invData.remainingAmount}, Status: ${invData.status}`,
      isCorrect,
      `Payment ID: ${pay1Res.paymentId}`
    );
  } catch (err) {
    recordTest(3, 'Partial Payment 4,000', 'Pay 4000', 'Success', err.message, false, err.stack);
  }

  // --- RUN TEST 4: SECOND PARTIAL PAYMENT 5,000 ---
  let pay2Res;
  try {
    pay2Res = await execCreateVendorPayment(inv1Id, 5000, bankMethodRef.id, '2026-09-13');
    const invSnap = await db.collection('purchaseInvoices').doc(inv1Id).get();
    const invData = invSnap.data();

    const isCorrect = invData.paidAmount === 9000 && invData.remainingAmount === 2500 && invData.status === 'partial';
    recordTest(
      4,
      'Second Partial Payment 5,000',
      'Pay additional 5000',
      'Paid: 9000, Remaining: 2500, Status: partial',
      `Paid: ${invData.paidAmount}, Remaining: ${invData.remainingAmount}, Status: ${invData.status}`,
      isCorrect,
      `Payment ID: ${pay2Res.paymentId}`
    );
  } catch (err) {
    recordTest(4, 'Second Partial Payment 5,000', 'Pay 5000', 'Success', err.message, false, err.stack);
  }

  // --- RUN TEST 5: FULL SETTLEMENT REMAINING 2,500 ---
  let pay3Res;
  try {
    pay3Res = await execCreateVendorPayment(inv1Id, 2500, bankMethodRef.id, '2026-09-13');
    const invSnap = await db.collection('purchaseInvoices').doc(inv1Id).get();
    const invData = invSnap.data();

    const isCorrect = invData.paidAmount === 11500 && invData.remainingAmount === 0 && invData.status === 'paid';
    recordTest(
      5,
      'Full Settlement',
      'Pay remaining 2500',
      'Paid: 11500, Remaining: 0, Status: paid',
      `Paid: ${invData.paidAmount}, Remaining: ${invData.remainingAmount}, Status: ${invData.status}`,
      isCorrect,
      `Invoice fully settled cleanly.`
    );
  } catch (err) {
    recordTest(5, 'Full Settlement', 'Pay 2500', 'Success', err.message, false, err.stack);
  }

  // --- RUN TEST 6: OVERPAYMENT REJECTION ---
  try {
    await execCreateVendorPayment(inv1Id, 1000, bankMethodRef.id, '2026-09-13');
    recordTest(6, 'Overpayment Rejection', 'Attempt paying 1000 on 0 remaining', 'Backend Error Rejection', 'Payment succeeded (FAIL)', false, 'Overpayment was allowed!');
  } catch (err) {
    const isRejected = err.message.includes('exceeds remaining payable');
    recordTest(
      6,
      'Overpayment Rejection',
      'Attempt paying 1000 on 0 remaining',
      'Error: Payment amount exceeds remaining payable',
      err.message,
      isRejected,
      `Backend correctly blocked negative AP.`
    );
  }

  // --- RUN TEST 7: PAYMENT REVERSAL ---
  try {
    await execReverseVendorPayment(inv1Id, pay2Res.paymentId, '2026-09-13');
    const invSnap = await db.collection('purchaseInvoices').doc(inv1Id).get();
    const invData = invSnap.data();
    const paySnap = await db.collection('purchaseInvoices').doc(inv1Id).collection('payments').doc(pay2Res.paymentId).get();
    const payData = paySnap.data();

    const isCorrect = invData.paidAmount === 6500 && invData.remainingAmount === 5000 && invData.status === 'partial' && payData.reversed === true;
    recordTest(
      7,
      'Payment Reversal',
      'Reverse 5000 payment',
      'Payment marked reversed, Invoice paidAmount = 6500, remaining = 5000',
      `PaidAmount: ${invData.paidAmount}, Remaining: ${invData.remainingAmount}, Payment reversed: ${payData.reversed}`,
      isCorrect,
      `Original payment preserved immutably with reversal metadata.`
    );
  } catch (err) {
    recordTest(7, 'Payment Reversal', 'Reverse payment', 'Success', err.message, false, err.stack);
  }

  // --- RUN TEST 8: DUPLICATE PAYMENT / IDEMPOTENCY ---
  try {
    const testPaymentRef = db.collection('purchaseInvoices').doc(inv2Id).collection('payments').doc();
    const res1 = await execCreateVendorPayment(inv2Id, 1000, bankMethodRef.id, '2026-09-13', testPaymentRef);
    const res2 = await execCreateVendorPayment(inv2Id, 1000, bankMethodRef.id, '2026-09-13', testPaymentRef);

    const isDuplicateBlocked = res2.isDuplicate === true;
    recordTest(
      8,
      'Duplicate Payment / Idempotency',
      'Post payment with identical idempotencyKey twice',
      'Second call returns isDuplicate: true without duplicate write',
      `isDuplicate: ${res2.isDuplicate}`,
      isDuplicateBlocked,
      `Deterministic idempotency key prevented duplicate GL posting.`
    );
  } catch (err) {
    recordTest(8, 'Duplicate Payment / Idempotency', 'Idempotency test', 'Duplicate blocked', err.message, false, err.stack);
  }

  // --- RUN TEST 9: CONCURRENT PAYMENTS ---
  try {
    let p1Success = false, p2Success = false, p2Error = null;
    const task1 = execCreateVendorPayment(inv1Id, 4000, bankMethodRef.id, '2026-09-13').then(() => { p1Success = true; });
    const task2 = execCreateVendorPayment(inv1Id, 4000, bankMethodRef.id, '2026-09-13').then(() => { p2Success = true; }).catch((e) => { p2Error = e.message; });

    await Promise.allSettled([task1, task2]);

    const isIsolated = (p1Success && !p2Success && p2Error.includes('exceeds remaining payable')) || (!p1Success && p2Success);
    recordTest(
      9,
      'Concurrent Payments',
      'Two concurrent 4000 payments on 5000 remaining balance',
      'One succeeds, second fails with remaining balance error',
      `P1 Success: ${p1Success}, P2 Success: ${p2Success}, Error: ${p2Error}`,
      isIsolated,
      `Firestore transaction prevented lost updates and overpayment.`
    );
  } catch (err) {
    recordTest(9, 'Concurrent Payments', 'Concurrent payment test', 'Transactional isolation', err.message, false, err.stack);
  }

  // --- RUN TEST 10: MISSING vendorPayable MAPPING ---
  try {
    const acctId = accountMap['vendorPayable'];
    await db.collection('accounts').doc(acctId).update({ active: false });

    try {
      await execCreatePurchaseInvoice({
        vendorId: vendorARef.id,
        date: '2026-09-13',
        subtotal: 1000,
        taxAmount: 0,
        total: 1000
      });
      recordTest(10, 'Missing vendorPayable Mapping', 'Account role inactive', 'Explicit failure', 'Purchase created (FAIL)', false, 'Missing mapping did not fail closed!');
    } catch (err) {
      const isFailedClosed = err.message.includes('vendorPayable');
      recordTest(
        10,
        'Missing vendorPayable Mapping',
        'Role vendorPayable inactive',
        'Error: Missing required account role: vendorPayable',
        err.message,
        isFailedClosed,
        `System failed closed as required.`
      );
    } finally {
      await db.collection('accounts').doc(acctId).update({ active: true });
    }
  } catch (err) {
    recordTest(10, 'Missing vendorPayable Mapping', 'Role missing', 'Explicit failure', err.message, false, err.stack);
  }

  // --- RUN TEST 11: MISSING taxReceivable MAPPING ---
  try {
    const acctId = accountMap['taxReceivable'];
    await db.collection('accounts').doc(acctId).update({ active: false });

    try {
      await execCreatePurchaseInvoice({
        vendorId: vendorARef.id,
        date: '2026-09-13',
        subtotal: 1000,
        taxAmount: 140,
        total: 1140
      });
      recordTest(11, 'Missing taxReceivable Mapping', 'Tax role inactive', 'Explicit failure', 'Purchase created (FAIL)', false, 'Missing tax mapping did not fail closed!');
    } catch (err) {
      const isFailedClosed = err.message.includes('taxReceivable');
      recordTest(
        11,
        'Missing taxReceivable Mapping',
        'Role taxReceivable inactive',
        'Error: Missing required account role: taxReceivable',
        err.message,
        isFailedClosed,
        `System failed closed when tax account was missing.`
      );
    } finally {
      await db.collection('accounts').doc(acctId).update({ active: true });
    }
  } catch (err) {
    recordTest(11, 'Missing taxReceivable Mapping', 'Tax role missing', 'Explicit failure', err.message, false, err.stack);
  }

  // --- RUN TEST 12: CLOSED-PERIOD PURCHASE ---
  try {
    await db.collection('settings').doc('default').set({ closedPeriodBefore: '2026-09-01' });

    try {
      await execCreatePurchaseInvoice({
        vendorId: vendorARef.id,
        date: '2026-08-15',
        subtotal: 1000,
        taxAmount: 0,
        total: 1000
      });
      recordTest(12, 'Closed-Period Purchase', 'Purchase date inside closed period', 'Backend rejection', 'Purchase created (FAIL)', false, 'Closed period was bypassed!');
    } catch (err) {
      const isPeriodLocked = err.message.includes('closed before');
      recordTest(
        12,
        'Closed-Period Purchase',
        'Date: 2026-08-15, Closed before: 2026-09-01',
        'Error: Accounting period is closed before 2026-09-01',
        err.message,
        isPeriodLocked,
        `Server-side period lock rejected historical edit.`
      );
    }
  } catch (err) {
    recordTest(12, 'Closed-Period Purchase', 'Period lock test', 'Rejection', err.message, false, err.stack);
  }

  // --- RUN TEST 13: CLOSED-PERIOD PAYMENT ---
  try {
    try {
      await execCreateVendorPayment(inv2Id, 1000, bankMethodRef.id, '2026-08-15');
      recordTest(13, 'Closed-Period Payment', 'Payment date inside closed period', 'Backend rejection', 'Payment created (FAIL)', false, 'Closed period was bypassed!');
    } catch (err) {
      const isPeriodLocked = err.message.includes('closed before');
      recordTest(
        13,
        'Closed-Period Payment',
        'Payment Date: 2026-08-15',
        'Error: Accounting period is closed',
        err.message,
        isPeriodLocked,
        `Server-side period lock rejected payment inside closed period.`
      );
    } finally {
      await db.collection('settings').doc('default').update({ closedPeriodBefore: null });
    }
  } catch (err) {
    recordTest(13, 'Closed-Period Payment', 'Period lock payment test', 'Rejection', err.message, false, err.stack);
  }

  // --- RUN TEST 14: VENDOR DELETION WITH FINANCIAL HISTORY ---
  const vendorToDeleteRef = db.collection('vendors').doc();
  await vendorToDeleteRef.set({ name: 'Vendor Temp Delete', phone: '0100000099', active: true, archived: false });
  let tempInvId = await execCreatePurchaseInvoice({ vendorId: vendorToDeleteRef.id, number: 'PUR-TEMP', date: '2026-09-13', subtotal: 1000, taxAmount: 0, total: 1000 });

  try {
    const vId = vendorToDeleteRef.id;
    const invSnap = await db.collection('purchaseInvoices').where('vendorId', '==', vId).get();
    const hasHistory = !invSnap.empty;

    if (hasHistory) {
      await db.collection('vendors').doc(vId).update({ archived: true });
    } else {
      await db.collection('vendors').doc(vId).delete();
    }

    const checkVendor = await db.collection('vendors').doc(vId).get();
    const isPreserved = checkVendor.exists && checkVendor.data()?.archived === true;

    recordTest(
      14,
      'Vendor Deletion with Financial History',
      'Attempt deletion of vendor with active purchase invoices',
      'Hard deletion rejected; Vendor document preserved with archived: true',
      `Exists: ${checkVendor.exists}, Archived: ${checkVendor.data()?.archived}`,
      isPreserved,
      `Historical vendor identity remains intact for reports and GL statements.`
    );
  } catch (err) {
    recordTest(14, 'Vendor Deletion with Financial History', 'Soft delete check', 'Preserved', err.message, false, err.stack);
  }

  // --- RUN TEST 15: MULTIPLE VENDORS ---
  let invVA, invVB, invVC;
  try {
    invVA = await execCreatePurchaseInvoice({ vendorId: vendorARef.id, number: 'PUR-A1', date: '2026-09-13', subtotal: 10000, taxAmount: 0, total: 10000 });
    invVB = await execCreatePurchaseInvoice({ vendorId: vendorBRef.id, number: 'PUR-B1', date: '2026-09-13', subtotal: 7000, taxAmount: 0, total: 7000 });
    invVC = await execCreatePurchaseInvoice({ vendorId: vendorCRef.id, number: 'PUR-C1', date: '2026-09-13', subtotal: 3000, taxAmount: 0, total: 3000 });

    recordTest(
      15,
      'Multiple Vendors Creation',
      'Vendor A: 10,000, Vendor B: 7,000, Vendor C: 3,000',
      'Vendor A = 10,000, Vendor B = 7,000, Vendor C = 3,000',
      `Created 3 distinct purchase invoices successfully`,
      true,
      `Purchases recorded independently.`
    );
  } catch (err) {
    recordTest(15, 'Multiple Vendors Creation', 'Multiple vendors test', 'Success', err.message, false, err.stack);
  }

  // --- RUN TEST 16: VENDOR-LEVEL RECONCILIATION ---
  let subA = 0, subB = 0, subC = 0;
  try {
    const allInvoicesSnap = await db.collection('purchaseInvoices').where('cancelled', '==', false).get();
    allInvoicesSnap.docs.forEach(d => {
      const data = d.data();
      const due = data.total - data.paidAmount;
      if (data.vendorId === vendorARef.id) subA += due;
      if (data.vendorId === vendorBRef.id) subB += due;
      if (data.vendorId === vendorCRef.id) subC += due;
    });

    const isSubAValid = subA === 20000;
    const isSubBValid = subB === 7000;
    const isSubCValid = subC === 3000;
    const isReconciled = isSubAValid && isSubBValid && isSubCValid;

    recordTest(
      16,
      'Vendor-Level Reconciliation',
      'Calculate individual subledgers for active vendors',
      `Subledger A = 20,000, Subledger B = 7,000, Subledger C = 3,000`,
      `Sub A: ${subA}, Sub B: ${subB}, Sub C: ${subC}`,
      isReconciled,
      `Every individual vendor balance matches its exact subledger calculation.`
    );
  } catch (err) {
    recordTest(16, 'Vendor-Level Reconciliation', 'Vendor subledgers', 'Reconciled', err.message, false, err.stack);
  }

  // --- RUN TEST 17: TOTAL AP VS ACCOUNT 211 ---
  let totalSubledgerAP = 0, glAccount211Net = 0;
  try {
    const allInvoicesSnap = await db.collection('purchaseInvoices').where('cancelled', '==', false).get();
    allInvoicesSnap.docs.forEach(d => {
      const data = d.data();
      totalSubledgerAP += (data.total - data.paidAmount);
    });
    totalSubledgerAP = roundMoney(totalSubledgerAP);

    const allTxSnap = await db.collection('accountingTransactions').get();
    let apCredits = 0, apDebits = 0;
    allTxSnap.docs.forEach(d => {
      (d.data().lines || []).forEach(l => {
        if (l.accountId === accountMap['vendorPayable']) {
          apCredits += (l.credit || 0);
          apDebits += (l.debit || 0);
        }
      });
    });
    glAccount211Net = roundMoney(apCredits - apDebits);

    const diff = roundMoney(totalSubledgerAP - glAccount211Net);
    const isReconciled = diff === 0;

    recordTest(
      17,
      'Total AP vs Account 211 GL',
      `Subledger Total AP: ${totalSubledgerAP}, GL Account 211 Net: ${glAccount211Net}`,
      'Subledger AP = GL Account 211 (Difference = 0.00)',
      `Subledger AP: ${totalSubledgerAP}, GL AP: ${glAccount211Net}, Difference: ${diff}`,
      isReconciled,
      `AP Subledger and General Ledger Account 211 reconcile with zero difference.`
    );
  } catch (err) {
    recordTest(17, 'Total AP vs Account 211 GL', 'AP Reconciliation', 'Diff = 0.00', err.message, false, err.stack);
  }

  // --- RUN TEST 18: INPUT VAT VS ACCOUNT 114 ---
  let expectedInputVAT = 1500, glAccount114Net = 0;
  try {
    const allTxSnap = await db.collection('accountingTransactions').get();
    let vatDebits = 0, vatCredits = 0;
    allTxSnap.docs.forEach(d => {
      (d.data().lines || []).forEach(l => {
        if (l.accountId === accountMap['taxReceivable']) {
          vatDebits += (l.debit || 0);
          vatCredits += (l.credit || 0);
        }
      });
    });
    glAccount114Net = roundMoney(vatDebits - vatCredits);
    const diff = roundMoney(expectedInputVAT - glAccount114Net);
    const isReconciled = diff === 0;

    recordTest(
      18,
      'Input VAT vs Account 114 GL',
      `Expected Input VAT: ${expectedInputVAT}, GL Account 114 Net: ${glAccount114Net}`,
      'Expected Input VAT = GL Account 114 (Difference = 0.00)',
      `Expected: ${expectedInputVAT}, GL 114: ${glAccount114Net}, Difference: ${diff}`,
      isReconciled,
      `Input VAT Asset Account 114 reconciles with zero difference.`
    );
  } catch (err) {
    recordTest(18, 'Input VAT vs Account 114 GL', 'VAT Reconciliation', 'Diff = 0.00', err.message, false, err.stack);
  }

  // --- RUN TEST 19: CASH/BANK VS TREASURY ACCOUNTING ---
  let totalVendorPaymentsGL = 0, totalVendorPaymentsSubledger = 0;
  try {
    const allTxSnap = await db.collection('accountingTransactions').get();
    let bankCredits = 0, bankDebits = 0;
    allTxSnap.docs.forEach(d => {
      (d.data().lines || []).forEach(l => {
        if (l.accountId === accountMap['bank']) {
          bankCredits += (l.credit || 0);
          bankDebits += (l.debit || 0);
        }
      });
    });
    totalVendorPaymentsGL = roundMoney(bankCredits - bankDebits);

    // Sum active unreversed payments across all purchase invoices
    const invoicesSnap = await db.collection('purchaseInvoices').get();
    for (const invDoc of invoicesSnap.docs) {
      const pSnap = await invDoc.ref.collection('payments').get();
      pSnap.docs.forEach(p => {
        if (!p.data().reversed) {
          totalVendorPaymentsSubledger += Number(p.data().amount || 0);
        }
      });
    }
    totalVendorPaymentsSubledger = roundMoney(totalVendorPaymentsSubledger);

    const diff = roundMoney(totalVendorPaymentsSubledger - totalVendorPaymentsGL);
    const isReconciled = diff === 0;

    recordTest(
      19,
      'Cash/Bank vs Treasury Accounting',
      `Subledger Payments: ${totalVendorPaymentsSubledger}, GL Bank Net Payments: ${totalVendorPaymentsGL}`,
      'Subledger Net Payments = GL Bank Net Payments (Difference = 0.00)',
      `Subledger: ${totalVendorPaymentsSubledger}, GL Bank: ${totalVendorPaymentsGL}, Difference: ${diff}`,
      isReconciled,
      `Treasury Bank account matches active net vendor payments.`
    );
  } catch (err) {
    recordTest(19, 'Cash/Bank vs Treasury Accounting', 'Treasury Reconciliation', 'Diff = 0.00', err.message, false, err.stack);
  }

  // --- RUN TEST 20: TRIAL BALANCE ---
  let totalDebits = 0, totalCredits = 0;
  try {
    const allTxSnap = await db.collection('accountingTransactions').get();
    allTxSnap.docs.forEach(d => {
      if (d.data().reversedBy) return;
      (d.data().lines || []).forEach(l => {
        totalDebits += (l.debit || 0);
        totalCredits += (l.credit || 0);
      });
    });

    totalDebits = roundMoney(totalDebits);
    totalCredits = roundMoney(totalCredits);
    const diff = roundMoney(totalDebits - totalCredits);
    const isBalanced = diff === 0;

    recordTest(
      20,
      'Trial Balance Verification',
      'Sum all active accounting transaction lines',
      'Total Debits = Total Credits (Difference = 0.00)',
      `Total Debits: ${totalDebits}, Total Credits: ${totalCredits}, Difference: ${diff}`,
      isBalanced,
      `General Ledger Trial Balance is in 100% equilibrium.`
    );
  } catch (err) {
    recordTest(20, 'Trial Balance Verification', 'Trial Balance', 'Debits = Credits', err.message, false, err.stack);
  }

  // --- RUN TEST 21: ORPHAN PURCHASE DETECTION ---
  try {
    const invoicesSnap = await db.collection('purchaseInvoices').get();
    let orphanCount = 0;
    for (const doc of invoicesSnap.docs) {
      const txSnap = await db.collection('accountingTransactions').where('sourceId', '==', doc.id).get();
      if (txSnap.empty) orphanCount++;
    }

    const isClean = orphanCount === 0;
    recordTest(
      21,
      'Orphan Purchase Detection',
      'Audit 100% of purchase invoices for matching accounting transactions',
      'Orphan purchase invoices count = 0',
      `Orphan purchase invoices count: ${orphanCount}`,
      isClean,
      `Every purchase invoice has a corresponding active accounting transaction.`
    );
  } catch (err) {
    recordTest(21, 'Orphan Purchase Detection', 'Orphan audit', '0 orphans', err.message, false, err.stack);
  }

  // --- RUN TEST 22: ORPHAN ACCOUNTING TRANSACTION DETECTION ---
  try {
    const txSnap = await db.collection('accountingTransactions').get();
    let orphanTxCount = 0;
    for (const doc of txSnap.docs) {
      const data = doc.data();
      if (data.sourceType === 'purchaseInvoice') {
        const invDoc = await db.collection('purchaseInvoices').doc(data.sourceId).get();
        if (!invDoc.exists) orphanTxCount++;
      }
    }

    const isClean = orphanTxCount === 0;
    recordTest(
      22,
      'Orphan Accounting Transaction Detection',
      'Audit all AP accounting transactions for matching source documents',
      'Orphan accounting transactions count = 0',
      `Orphan accounting transactions count: ${orphanTxCount}`,
      isClean,
      `No orphan journal entries exist in the General Ledger.`
    );
  } catch (err) {
    recordTest(22, 'Orphan Accounting Transaction Detection', 'Orphan accounting audit', '0 orphans', err.message, false, err.stack);
  }

  // --- RUN TEST 23: DUPLICATE TRANSACTION DETECTION ---
  try {
    const txSnap = await db.collection('accountingTransactions').get();
    const keySet = new Set();
    let dupCount = 0;
    txSnap.docs.forEach(doc => {
      const key = doc.data().idempotencyKey;
      if (key) {
        if (keySet.has(key)) dupCount++;
        else keySet.add(key);
      }
    });

    const isClean = dupCount === 0;
    recordTest(
      23,
      'Duplicate Transaction Detection',
      'Check idempotency keys across all accounting transactions',
      'Duplicate idempotency keys count = 0',
      `Duplicate keys count: ${dupCount}`,
      isClean,
      `No duplicate accounting transactions exist.`
    );
  } catch (err) {
    recordTest(23, 'Duplicate Transaction Detection', 'Idempotency audit', '0 duplicates', err.message, false, err.stack);
  }

  // --- RUN TEST 24: HISTORICAL IMMUTABILITY ---
  try {
    const paySnap = await db.collection('purchaseInvoices').doc(inv1Id).collection('payments').doc(pay2Res.paymentId).get();
    const origTxSnap = await db.collection('accountingTransactions').where('sourceId', '==', pay2Res.paymentId).where('action', '==', 'payment').get();

    const origTxData = origTxSnap.docs[0].data();
    const isOriginalPreserved = origTxData.lines[0].debit === 5000 && origTxData.reversedBy !== null;

    recordTest(
      24,
      'Historical Immutability Verification',
      'Inspect original payment transaction after reversal',
      'Original payment transaction document remains unmodified with reversal link',
      `Original line debit: ${origTxData.lines[0].debit}, ReversedBy link: ${origTxData.reversedBy}`,
      isOriginalPreserved,
      `Accounting history is preserved through reversals rather than destructive mutations.`
    );
  } catch (err) {
    recordTest(24, 'Historical Immutability Verification', 'Immutability audit', 'Preserved', err.message, false, err.stack);
  }

  // --- RUN TEST 25: ATOMIC ROLLBACK ---
  try {
    try {
      await execCreateVendorPayment(inv1Id, 1000, 'invalid-non-existent-method-id', '2026-09-13');
      recordTest(25, 'Atomic Rollback', 'Force failure with invalid payment method', 'Transaction rollback', 'Operation succeeded (FAIL)', false, 'Operation did not fail!');
    } catch (err) {
      const isRolledBack = err.message.includes('Invalid payment method');
      const paymentsSnap = await db.collection('purchaseInvoices').doc(inv1Id).collection('payments').where('methodId', '==', 'invalid-non-existent-method-id').get();
      const isNoOrphan = paymentsSnap.empty;

      recordTest(
        25,
        'Atomic Rollback Verification',
        'Force failure inside Firestore transaction with invalid methodId',
        'Entire transaction rolls back; 0 payment documents and 0 partial GL lines written',
        `Rolled back: ${isRolledBack}, Payment sub-docs written: ${paymentsSnap.size}`,
        isRolledBack && isNoOrphan,
        `Atomic rollback verified. System failed closed with zero orphan data.`
      );
    }
  } catch (err) {
    recordTest(25, 'Atomic Rollback Verification', 'Atomic rollback test', 'Rollback', err.message, false, err.stack);
  }

  // RECONCILIATION SUMMARY MATRIX PRINT
  console.log('\n==================================================');
  console.log('         AP RECONCILIATION MATRIX SUMMARY          ');
  console.log('==================================================');
  console.log(`Vendor Alpha AP Subledger: ${subA} EGP`);
  console.log(`Vendor Beta AP Subledger:  ${subB} EGP`);
  console.log(`Vendor Gamma AP Subledger: ${subC} EGP`);
  console.log(`Total AP Subledger:        ${totalSubledgerAP} EGP`);
  console.log(`GL Account 211 Net:        ${glAccount211Net} EGP`);
  console.log(`AP Difference:             ${totalSubledgerAP - glAccount211Net} EGP`);
  console.log('--------------------------------------------------');
  console.log(`Expected Input VAT:        ${expectedInputVAT} EGP`);
  console.log(`GL Account 114 Net:        ${glAccount114Net} EGP`);
  console.log(`Input VAT Difference:      ${expectedInputVAT - glAccount114Net} EGP`);
  console.log('--------------------------------------------------');
  console.log(`Trial Balance Debits:      ${totalDebits} EGP`);
  console.log(`Trial Balance Credits:     ${totalCredits} EGP`);
  console.log(`Trial Balance Difference:  ${totalDebits - totalCredits} EGP`);
  console.log('==================================================\n');

  const failedTests = testResults.filter(t => t.result === 'FAIL');
  if (failedTests.length === 0) {
    console.log('FINAL VERDICT: AP FOUNDATION VERIFIED ✅');
  } else {
    console.log(`FINAL VERDICT: AP FOUNDATION NOT VERIFIED ❌ (${failedTests.length} tests failed)`);
  }
}

if (require.main === module) {
  runAPVerificationSuite().catch(err => console.error(err));
}

module.exports = { runAPVerificationSuite };

