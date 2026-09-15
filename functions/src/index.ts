import * as functions from 'firebase-functions/v2';
import { getFirestore, FieldValue, Transaction } from 'firebase-admin/firestore';
import { 
  prepareAccountingTransaction,
  writeAccountingTransaction,
  prepareReverseAccountingTransaction,
  writeReverseAccountingTransaction,
  resolveAccountByRole,
  roundMoney,
  AccountingLine 
} from './accounting/accountingService';

const db = getFirestore();

async function resolveAccount(accountNumber: string, t: Transaction): Promise<any> {
    const acctSnap = await t.get(db.collection('accounts').where('code', '==', accountNumber).limit(1));
    if (acctSnap.empty) return null;
    const data = acctSnap.docs[0].data();
    if (data?.isGroup || data?.archived || data?.active === false) return null;
    return { id: acctSnap.docs[0].id, ...data };
}

async function resolvePaymentMethodAccount(methodId: string, t: Transaction): Promise<any> {
  const methodDoc = await t.get(db.collection('paymentMethods').doc(methodId));
  if (!methodDoc.exists || methodDoc.data()?.active === false || methodDoc.data()?.archived === true) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid or inactive payment method.');
  }
  const methodData = methodDoc.data();
  let treasuryAccount: any = null;

  if (methodData?.accountId) {
    const acctDoc = await t.get(db.collection('accounts').doc(methodData.accountId));
    if (acctDoc.exists && !acctDoc.data()?.archived && acctDoc.data()?.active !== false && !acctDoc.data()?.isGroup) {
      treasuryAccount = { id: acctDoc.id, ...acctDoc.data() };
    }
  }

  if (!treasuryAccount && methodData?.accountNumber) {
    const acctSnap = await t.get(db.collection('accounts').where('code', '==', methodData.accountNumber).limit(1));
    if (!acctSnap.empty && !acctSnap.docs[0].data()?.archived && acctSnap.docs[0].data()?.active !== false && !acctSnap.docs[0].data()?.isGroup) {
      treasuryAccount = { id: acctSnap.docs[0].id, ...acctSnap.docs[0].data() };
    }
  }

  if (!treasuryAccount && methodData?.type === 'cash') {
    treasuryAccount = await resolveAccountByRole('cash', t);
  }

  if (!treasuryAccount || treasuryAccount.isGroup) {
    throw new functions.https.HttpsError('failed-precondition', 'Payment method missing valid non-group account mapping.');
  }

  return treasuryAccount;
}


/**
 * Checks authorization for ops writing (sales, accountant, admin).
 */
async function authorizeOpsWrite(uid: string) {
  const userDoc = await db.collection('users').doc(uid).get();
  const role = userDoc.data()?.role;
  if (!role || (role !== 'admin' && role !== 'accountant' && role !== 'sales')) {
    throw new functions.https.HttpsError('permission-denied', 'Unauthorized to perform operational writes.');
  }
}

/**
 * Checks authorization for finance (admin, accountant).
 */
async function authorizeFinance(uid: string) {
  const userDoc = await db.collection('users').doc(uid).get();
  const role = userDoc.data()?.role;
  if (!role || (role !== 'admin' && role !== 'accountant')) {
    throw new functions.https.HttpsError('permission-denied', 'Unauthorized to perform finance writes.');
  }
}

/**
 * 1. createInvoice
 */
export const createInvoice = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { values, number, payment } = request.data;
  
  if (!values.date || !values.clientId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
  }

  // Calculate totals on backend with rounding
  const total = roundMoney(Number(values.total || 0));
  const adBudget = roundMoney(Number(values.adBudgetTotal || 0));
  const taxAmount = roundMoney(Number(values.taxAmount || 0));
  const fees = roundMoney(total - adBudget - taxAmount);

  if (total <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Invoice total must be greater than zero.');
  }
  if (fees < 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Invoice breakdown (ad budget + tax) exceeds total amount.');
  }

  try {
    let invoiceRef: any;
    await db.runTransaction(async (t: Transaction) => {
      // PHASE 1: READS
      const receivableAcct = await resolveAccountByRole('receivable', t);
      const revenueAcct = await resolveAccountByRole('revenue', t);
      const adHeldAcct = await resolveAccountByRole('adBudgetHeld', t);
      const taxAcct = await resolveAccountByRole('tax', t);

      const lines: AccountingLine[] = [
        { accountId: receivableAcct.id, debit: total, credit: 0 }
      ];

      if (fees > 0) lines.push({ accountId: revenueAcct.id, debit: 0, credit: fees });
      if (adBudget > 0) lines.push({ accountId: adHeldAcct.id, debit: 0, credit: adBudget });
      if (taxAmount > 0) lines.push({ accountId: taxAcct.id, debit: 0, credit: taxAmount });

      invoiceRef = db.collection('invoices').doc();

      const prepInvoiceTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `invoice:${invoiceRef.id}:issue`,
        transactionDate: values.date,
        sourceType: 'invoice',
        sourceId: invoiceRef.id,
        action: 'create',
        lines,
        createdBy: uid,
      });

      let paymentRef: any = null;
      let paymentAmount = 0;
      let prepPaymentTx: any = null;

      if (payment) {
        paymentAmount = roundMoney(Number(payment.amount));
        if (paymentAmount <= 0) {
          throw new Error('Payment amount must be greater than zero.');
        }

        const treasuryAccount = await resolvePaymentMethodAccount(payment.methodId, t);

        paymentRef = invoiceRef.collection('payments').doc();

        prepPaymentTx = await prepareAccountingTransaction(t, {
          idempotencyKey: `payment:${paymentRef.id}:post`,
          transactionDate: payment.date || values.date,
          sourceType: 'payment',
          sourceId: paymentRef.id,
          action: 'payment',
          lines: [
            { accountId: treasuryAccount.id, debit: paymentAmount, credit: 0 },
            { accountId: receivableAcct.id, debit: 0, credit: paymentAmount }
          ],
          createdBy: uid,
        });
      }

      // PHASE 2: WRITES
      t.set(invoiceRef, {
        ...values,
        number,
        total,
        adBudgetTotal: adBudget,
        taxAmount,
        paidAmount: payment ? paymentAmount : 0,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp()
      });

      writeAccountingTransaction(t, prepInvoiceTx);

      if (payment && paymentRef && prepPaymentTx) {
        t.set(paymentRef, {
          ...payment,
          amount: paymentAmount,
          createdAt: FieldValue.serverTimestamp(),
          createdBy: uid
        });
        writeAccountingTransaction(t, prepPaymentTx);
      }
    });

  } catch (error: any) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message || 'Internal error');
  }
});

/**
 * 2. createPayment
 */
export const createPayment = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { invoiceId, payment } = request.data;
  if (!invoiceId || !payment || !payment.methodId || Number(payment.amount) <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid payment data.');
  }

  try {
    let invoiceRef: any;
    await db.runTransaction(async (t: Transaction) => {
      // PHASE 1: READS
      const invoiceRef = db.collection('invoices').doc(invoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      
      if (!invoiceDoc.exists) {
        throw new Error('Invoice not found.');
      }
      if (invoiceDoc.data()?.cancelled) {
        throw new Error('Cannot add payment to a cancelled invoice.');
      }

      const totalInvoice = roundMoney(Number(invoiceDoc.data()?.total || 0));
      const oldPaidAmount = roundMoney(Number(invoiceDoc.data()?.paidAmount || 0));
      const remaining = roundMoney(totalInvoice - oldPaidAmount);

      const receivableAcct = await resolveAccountByRole('receivable', t);
      const paymentAmount = roundMoney(Number(payment.amount));

      if (paymentAmount > remaining + 0.0001) {
        throw new Error(`Payment amount (${paymentAmount}) exceeds invoice remaining balance (${remaining}).`);
      }

      const treasuryAccount = await resolvePaymentMethodAccount(payment.methodId, t);

      const paymentRef = invoiceRef.collection('payments').doc();

      const prepPaymentTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `payment:${paymentRef.id}:post`,
        transactionDate: payment.date,
        sourceType: 'payment',
        sourceId: paymentRef.id,
        action: 'payment',
        lines: [
          { accountId: treasuryAccount.id, debit: paymentAmount, credit: 0 },
          { accountId: receivableAcct.id, debit: 0, credit: paymentAmount }
        ],
        createdBy: uid,
      });

      // PHASE 2: WRITES
      t.set(paymentRef, {
        ...payment,
        amount: paymentAmount,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: uid
      });

      t.update(invoiceRef, { paidAmount: roundMoney(oldPaidAmount + paymentAmount) });

      writeAccountingTransaction(t, prepPaymentTx);
    });

    return { success: true, invoiceId: invoiceRef ? invoiceRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 4. reversePayment
 */
export const reversePayment = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { invoiceId, paymentId } = request.data;
  if (!invoiceId || !paymentId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing fields.');
  }

  try {
    await db.runTransaction(async (t: Transaction) => {
      // PHASE 1: READS
      const invoiceRef = db.collection('invoices').doc(invoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Invoice not found.');

      const paymentRef = invoiceRef.collection('payments').doc(paymentId);
      const paymentDoc = await t.get(paymentRef);
      if (!paymentDoc.exists) throw new Error('Payment not found.');
      const paymentData = paymentDoc.data();
      if (paymentData?.reversed) throw new Error('Payment is already reversed.');

      const paymentAmount = Number(paymentData?.amount || 0);

      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', paymentId)
          .where('sourceType', '==', 'payment')
          .where('action', '==', 'payment')
      );

      const activeTx = querySnap.docs.find(d => !d.data().reversedBy);
      if (!activeTx) {
        throw new Error(`Original payment accounting transaction not found or already reversed for payment ${paymentId}.`);
      }

      const revDate = new Date().toISOString().split('T')[0];
      const prepReversal = await prepareReverseAccountingTransaction(t, {
        originalTxId: activeTx.id,
        reversalDate: paymentData?.date || revDate,
        reversalReason: 'Payment reversed by user',
        idempotencyKey: `payment:${paymentId}:reverse`,
        createdBy: uid
      });

      // PHASE 2: WRITES
      writeReverseAccountingTransaction(t, prepReversal);

      t.update(paymentRef, {
        reversed: true,
        reversedAt: FieldValue.serverTimestamp(),
        reversedBy: uid
      });

      const oldPaidAmount = invoiceDoc.data()?.paidAmount || 0;
      t.update(invoiceRef, { paidAmount: Math.max(0, oldPaidAmount - paymentAmount) });
    });

    return { success: true };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 5. editInvoice
 */
export const editInvoice = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { invoiceId, values, editVersion } = request.data;
  if (!invoiceId || !values || !editVersion) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing fields.');
  }

  try {
    let invoiceRef: any;
    await db.runTransaction(async (t: Transaction) => {
      // PHASE 1: READS
      const invoiceRef = db.collection('invoices').doc(invoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Invoice not found');
      if (invoiceDoc.data()?.cancelled) throw new Error('Cannot edit a cancelled invoice.');

      const total = roundMoney(Number(values.total || 0));
      const adBudget = roundMoney(Number(values.adBudgetTotal || 0));
      const taxAmount = roundMoney(Number(values.taxAmount || 0));
      const fees = roundMoney(total - adBudget - taxAmount);

      if (total <= 0) {
        throw new Error('Invoice total must be greater than zero.');
      }
      if (fees < 0) {
        throw new Error('Invoice breakdown (ad budget + tax) exceeds total amount.');
      }
      const currentPaid = roundMoney(Number(invoiceDoc.data()?.paidAmount || 0));
      if (total < currentPaid) {
        throw new Error(`New invoice total (${total}) cannot be less than already paid amount (${currentPaid}).`);
      }

      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', invoiceId)
          .where('sourceType', '==', 'invoice')
          .where('action', '==', 'create')
          .limit(1)
      );

      let prepReversal: any = null;
      let prepNewTx: any = null;

      if (!querySnap.empty) {
        const txDoc = querySnap.docs[0];
        prepReversal = await prepareReverseAccountingTransaction(t, {
          originalTxId: txDoc.id,
          reversalDate: invoiceDoc.data()?.date || new Date().toISOString().split('T')[0],
          reversalReason: 'Invoice edited',
          idempotencyKey: `invoice:${invoiceId}:edit:${editVersion}`,
          createdBy: uid
        });

        const receivableAcct = await resolveAccountByRole('receivable', t);
        const revenueAcct = await resolveAccountByRole('revenue', t);
        const adHeldAcct = await resolveAccountByRole('adBudgetHeld', t);
        const taxAcct = await resolveAccountByRole('tax', t);

        const lines: AccountingLine[] = [
          { accountId: receivableAcct.id, debit: total, credit: 0 }
        ];

        if (fees > 0) lines.push({ accountId: revenueAcct.id, debit: 0, credit: fees });
        if (adBudget > 0) lines.push({ accountId: adHeldAcct.id, debit: 0, credit: adBudget });
        if (taxAmount > 0) lines.push({ accountId: taxAcct.id, debit: 0, credit: taxAmount });

        prepNewTx = await prepareAccountingTransaction(t, {
          idempotencyKey: `invoice:${invoiceId}:edit:${editVersion}:post`,
          transactionDate: values.date,
          sourceType: 'invoice',
          sourceId: invoiceId,
          action: 'edit',
          lines,
          createdBy: uid,
        });
      }

      // PHASE 2: WRITES
      t.update(invoiceRef, { ...values, total, adBudgetTotal: adBudget, taxAmount, updatedAt: FieldValue.serverTimestamp() });

      if (prepReversal) writeReverseAccountingTransaction(t, prepReversal);
      if (prepNewTx) writeAccountingTransaction(t, prepNewTx);
    });

    return { success: true, invoiceId: invoiceRef ? invoiceRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 4. cancelInvoice
 */
export const cancelInvoice = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { invoiceId, cancelReason, cancelledDate } = request.data;
  if (!invoiceId || !cancelledDate) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing fields.');
  }

  try {
    let invoiceRef: any;
    await db.runTransaction(async (t: Transaction) => {
      // PHASE 1: READS
      const invoiceRef = db.collection('invoices').doc(invoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Invoice not found');
      if (invoiceDoc.data()?.cancelled) throw new Error('Invoice already cancelled');

      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', invoiceId)
          .where('sourceType', '==', 'invoice')
          .where('action', 'in', ['create', 'edit'])
      );

      const activeTx = querySnap.docs.find(d => !d.data().reversedBy);
      let prepReversal: any = null;

      if (activeTx) {
        prepReversal = await prepareReverseAccountingTransaction(t, {
          originalTxId: activeTx.id,
          reversalDate: cancelledDate,
          reversalReason: `Cancellation: ${cancelReason}`,
          idempotencyKey: `invoice:${invoiceId}:cancel`,
          createdBy: uid
        });
      }

      // PHASE 2: WRITES
      t.update(invoiceRef, { 
        cancelled: true, 
        cancelReason: cancelReason || '', 
        cancelledDate 
      });

      if (prepReversal) {
        writeReverseAccountingTransaction(t, prepReversal);
      }
    });

    return { success: true, invoiceId: invoiceRef ? invoiceRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 6. deleteInvoice
 */
export const deleteInvoice = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { invoiceId } = request.data;
  if (!invoiceId) throw new functions.https.HttpsError('invalid-argument', 'Missing fields.');

  try {
    await db.runTransaction(async (t: Transaction) => {
      // Prevent deletion of invoices with posted accounting history or payments
      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', invoiceId)
          .where('sourceType', '==', 'invoice')
          .limit(1)
      );
      if (!querySnap.empty) {
        throw new Error('Cannot physically delete an invoice with accounting history. Use cancellation instead.');
      }

      const paymentsSnap = await t.get(
        db.collection('invoices').doc(invoiceId).collection('payments').limit(1)
      );
      if (!paymentsSnap.empty) {
        throw new Error('Cannot physically delete an invoice with existing payment records.');
      }

      const invoiceRef = db.collection('invoices').doc(invoiceId);
      t.delete(invoiceRef);
    });
    return { success: true };
  } catch (error: any) {
    throw new functions.https.HttpsError('failed-precondition', error.message);
  }
});

/**
 * 7. restoreInvoice
 */
export const restoreInvoice = functions.https.onCall(async (request: any) => {
  // If the current accounting model cannot safely support restoration, disable/restrict it.
  throw new functions.https.HttpsError('failed-precondition', 'Invoice restoration is disabled in strict accounting mode. Create a new invoice instead.');
});

/**
 * 8. postManualVoucher
 */
export const postManualVoucher = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeFinance(uid);

  const { values } = request.data;
  
  if (!values.date || !values.lines || values.lines.length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid voucher data.');
  }

  try {
    let invoiceRef: any;
    await db.runTransaction(async (t: Transaction) => {
      for (const line of values.lines) {
        if (line.accountId) {
          await resolveAccount(line.accountId, t);
        }
      }

      const voucherRef = db.collection('journalEntries').doc();
      const accountingLines = values.lines.map((l: any) => ({
        accountId: l.accountId,
        debit: Number(l.debit || 0),
        credit: Number(l.credit || 0)
      }));

      const prepVoucherTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `voucher:${voucherRef.id}:post`,
        transactionDate: values.date,
        sourceType: 'voucher',
        sourceId: voucherRef.id,
        action: 'manual',
        lines: accountingLines,
        createdBy: uid,
      });

      // PHASE 2: WRITES
      const voucherData = {
        ...values,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp()
      };
      
      t.set(voucherRef, voucherData);
      writeAccountingTransaction(t, prepVoucherTx);
    });

    return { success: true, invoiceId: invoiceRef ? invoiceRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 9. createPurchaseInvoice
 */
export const createPurchaseInvoice = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { vendorId, invoiceNumber, date, invoiceDate, dueDate, description, purchaseType, subtotal: rawSubtotal, taxAmount: rawTax, total: rawTotal, accountId } = request.data;
  
  const trDate = date || invoiceDate;
  if (!vendorId || !trDate) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields (vendorId, date).');
  }

  const subtotal = roundMoney(Number(rawSubtotal || 0));
  const taxAmount = roundMoney(Number(rawTax || 0));
  const total = roundMoney(Number(rawTotal || 0));

  if (subtotal < 0 || taxAmount < 0 || total <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Purchase invoice amounts must be valid positive numbers.');
  }

  if (roundMoney(subtotal + taxAmount) !== total) {
    throw new functions.https.HttpsError('invalid-argument', `Purchase breakdown (subtotal ${subtotal} + tax ${taxAmount}) does not equal total (${total}).`);
  }

  try {
    let purchaseRef: any;
    await db.runTransaction(async (t: Transaction) => {
      // READS
      const vendorDoc = await t.get(db.collection('vendors').doc(vendorId));
      if (!vendorDoc.exists || vendorDoc.data()?.active === false || vendorDoc.data()?.archived === true) {
        throw new functions.https.HttpsError('failed-precondition', 'Vendor does not exist or is inactive.');
      }

      const vendorPayableAcct = await resolveAccountByRole('vendorPayable', t);
      
      let taxReceivableAcct: any = null;
      if (taxAmount > 0) {
        taxReceivableAcct = await resolveAccountByRole('taxReceivable', t);
      }

      let targetAccount: any = null;
      if (accountId) {
        targetAccount = await resolveAccount(accountId, t);
        if (targetAccount.isGroup) {
          throw new functions.https.HttpsError('invalid-argument', `Target account ${targetAccount.name} is a parent group account and cannot accept postings.`);
        }
      } else {
        const typeStr = (purchaseType || 'expense').toLowerCase();
        if (typeStr === 'asset') {
          targetAccount = await resolveAccountByRole('equipment', t);
        } else if (typeStr === 'inventory') {
          targetAccount = await resolveAccountByRole('inventory', t);
        } else {
          targetAccount = await resolveAccountByRole('costOther', t);
        }
      }

      const lines: AccountingLine[] = [
        { accountId: targetAccount.id, debit: subtotal, credit: 0 }
      ];

      if (taxAmount > 0 && taxReceivableAcct) {
        lines.push({ accountId: taxReceivableAcct.id, debit: taxAmount, credit: 0 });
      }

      lines.push({ accountId: vendorPayableAcct.id, debit: 0, credit: total });

      purchaseRef = db.collection('purchaseInvoices').doc();

      const prepInvoiceTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `purchase:${purchaseRef.id}:post`,
        transactionDate: trDate,
        sourceType: 'purchaseInvoice',
        sourceId: purchaseRef.id,
        action: 'create',
        lines,
        createdBy: uid,
      });

      // WRITES
      const invoiceData = {
        vendorId,
        number: invoiceNumber || '',
        invoiceNumber: invoiceNumber || '',
        date: trDate,
        invoiceDate: trDate,
        dueDate: dueDate || trDate,
        description: description || '',
        purchaseType: purchaseType || 'expense',
        accountId: targetAccount.id,
        subtotal,
        taxAmount,
        total,
        paidAmount: 0,
        remainingAmount: total,
        status: 'unpaid',
        cancelled: false,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      t.set(purchaseRef, invoiceData);
      writeAccountingTransaction(t, prepInvoiceTx);
    });

    return { success: true, purchaseInvoiceId: purchaseRef ? purchaseRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 10. createVendorPayment
 */
export const createVendorPayment = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { purchaseInvoiceId, payment } = request.data;
  if (!purchaseInvoiceId || !payment || !payment.methodId || Number(payment.amount) <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid payment data.');
  }

  try {
    let paymentRef: any;
    await db.runTransaction(async (t: Transaction) => {
      // READS
      const invoiceRef = db.collection('purchaseInvoices').doc(purchaseInvoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Purchase invoice not found.');
      if (invoiceDoc.data()?.cancelled) throw new Error('Cannot add payment to a cancelled purchase invoice.');

      const totalInvoice = roundMoney(Number(invoiceDoc.data()?.total || 0));
      const oldPaidAmount = roundMoney(Number(invoiceDoc.data()?.paidAmount || 0));
      const remaining = roundMoney(totalInvoice - oldPaidAmount);
      const paymentAmount = roundMoney(Number(payment.amount));

      if (paymentAmount > remaining + 0.0001) {
        throw new Error(`Payment amount (${paymentAmount}) exceeds remaining payable (${remaining}).`);
      }

      const vendorPayableAcct = await resolveAccountByRole('vendorPayable', t);

      const treasuryAccount = await resolvePaymentMethodAccount(payment.methodId, t);

      paymentRef = invoiceRef.collection('payments').doc();

      const prepPaymentTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `vendor-payment:${paymentRef.id}:post`,
        transactionDate: payment.date || new Date().toISOString().split('T')[0],
        sourceType: 'vendorPayment',
        sourceId: paymentRef.id,
        action: 'payment',
        lines: [
          { accountId: vendorPayableAcct.id, debit: paymentAmount, credit: 0 },
          { accountId: treasuryAccount.id, debit: 0, credit: paymentAmount }
        ],
        createdBy: uid,
      });

      // WRITES
      const newPaidAmount = roundMoney(oldPaidAmount + paymentAmount);
      const newRemaining = roundMoney(totalInvoice - newPaidAmount);
      const status = newRemaining <= 0.001 ? 'paid' : 'partial';

      t.set(paymentRef, {
        purchaseInvoiceId,
        vendorId: invoiceDoc.data()?.vendorId,
        amount: paymentAmount,
        methodId: payment.methodId,
        date: payment.date || new Date().toISOString().split('T')[0],
        notes: payment.notes || '',
        createdAt: FieldValue.serverTimestamp(),
        createdBy: uid
      });

      t.update(invoiceRef, {
        paidAmount: newPaidAmount,
        remainingAmount: newRemaining,
        status,
        updatedAt: FieldValue.serverTimestamp()
      });

      writeAccountingTransaction(t, prepPaymentTx);
    });

    return { success: true, paymentId: paymentRef ? paymentRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 11. reverseVendorPayment
 */
export const reverseVendorPayment = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { purchaseInvoiceId, paymentId, reversalReason, reversalDate } = request.data;
  if (!purchaseInvoiceId || !paymentId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields (purchaseInvoiceId, paymentId).');
  }

  try {
    await db.runTransaction(async (t: Transaction) => {
      // READS
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

      const revDate = reversalDate || new Date().toISOString().split('T')[0];
      const prepReversal = await prepareReverseAccountingTransaction(t, {
        originalTxId: activeTx.id,
        reversalDate: paymentData?.date || revDate,
        reversalReason: reversalReason || 'Vendor payment reversed by user',
        idempotencyKey: `vendor-payment:${paymentId}:reverse`,
        createdBy: uid
      });

      // WRITES
      writeReverseAccountingTransaction(t, prepReversal);

      t.update(paymentRef, {
        reversed: true,
        reversedAt: FieldValue.serverTimestamp(),
        reversedBy: uid,
        reversalReason: reversalReason || ''
      });

      const totalInvoice = roundMoney(Number(invoiceDoc.data()?.total || 0));
      const oldPaidAmount = roundMoney(Number(invoiceDoc.data()?.paidAmount || 0));
      const newPaidAmount = Math.max(0, roundMoney(oldPaidAmount - paymentAmount));
      const newRemaining = roundMoney(totalInvoice - newPaidAmount);
      const status = newPaidAmount === 0 ? 'unpaid' : (newRemaining <= 0.001 ? 'paid' : 'partial');

      t.update(invoiceRef, {
        paidAmount: newPaidAmount,
        remainingAmount: newRemaining,
        status,
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    return { success: true };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 12. cancelPurchaseInvoice
 */
export const cancelPurchaseInvoice = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { purchaseInvoiceId, cancelReason, cancelledDate } = request.data;
  if (!purchaseInvoiceId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing purchaseInvoiceId.');
  }

  try {
    await db.runTransaction(async (t: Transaction) => {
      // READS
      const invoiceRef = db.collection('purchaseInvoices').doc(purchaseInvoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Purchase invoice not found.');
      if (invoiceDoc.data()?.cancelled) throw new Error('Purchase invoice already cancelled.');

      const paymentsSnap = await t.get(invoiceRef.collection('payments'));
      const activePayments = paymentsSnap.docs.filter(d => !d.data()?.reversed);
      if (activePayments.length > 0) {
        throw new Error('Cannot cancel a purchase invoice with active payments. Reverse all payments first.');
      }

      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', purchaseInvoiceId)
          .where('sourceType', '==', 'purchaseInvoice')
          .where('action', '==', 'create')
      );

      const activeTx = querySnap.docs.find(d => !d.data().reversedBy);
      let prepReversal: any = null;

      if (activeTx) {
        prepReversal = await prepareReverseAccountingTransaction(t, {
          originalTxId: activeTx.id,
          reversalDate: cancelledDate || new Date().toISOString().split('T')[0],
          reversalReason: `Cancellation: ${cancelReason || ''}`,
          idempotencyKey: `purchase:${purchaseInvoiceId}:cancel`,
          createdBy: uid
        });
      }

      // WRITES
      t.update(invoiceRef, {
        cancelled: true,
        status: 'cancelled',
        cancelReason: cancelReason || '',
        cancelledDate: cancelledDate || new Date().toISOString().split('T')[0],
        updatedAt: FieldValue.serverTimestamp()
      });

      if (prepReversal) {
        writeReverseAccountingTransaction(t, prepReversal);
      }
    });

    return { success: true };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 13. createPurchaseReturn
 */
export const createPurchaseReturn = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { purchaseInvoiceId, returnDate, subtotal: rawSub, taxAmount: rawTax, reason } = request.data;
  if (!purchaseInvoiceId || !returnDate) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields (purchaseInvoiceId, returnDate).');
  }

  const subtotal = roundMoney(Number(rawSub || 0));
  const taxAmount = roundMoney(Number(rawTax || 0));
  const total = roundMoney(subtotal + taxAmount);

  if (total <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Return total must be greater than zero.');
  }

  try {
    let returnRef: any;
    await db.runTransaction(async (t: Transaction) => {
      const invoiceRef = db.collection('purchaseInvoices').doc(purchaseInvoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Purchase invoice not found.');
      const invoiceData = invoiceDoc.data();
      if (invoiceData?.cancelled) throw new Error('Cannot create return for a cancelled purchase invoice.');

      const existingReturnsSnap = await t.get(
        db.collection('purchaseReturns').where('purchaseInvoiceId', '==', purchaseInvoiceId)
      );
      let existingReturnsTotal = 0;
      existingReturnsSnap.docs.forEach(doc => {
        if (!doc.data()?.cancelled) {
          existingReturnsTotal += Number(doc.data()?.total || 0);
        }
      });
      existingReturnsTotal = roundMoney(existingReturnsTotal);

      const invoiceTotal = roundMoney(Number(invoiceData?.total || 0));
      const maxReturnable = roundMoney(invoiceTotal - existingReturnsTotal);

      if (total > maxReturnable + 0.0001) {
        throw new Error(`Return total (${total}) exceeds remaining returnable invoice amount (${maxReturnable}).`);
      }

      const vendorPayableAcct = await resolveAccountByRole('vendorPayable', t);
      let taxReceivableAcct: any = null;
      if (taxAmount > 0) {
        taxReceivableAcct = await resolveAccountByRole('taxReceivable', t);
      }

      let targetAccount: any = null;
      if (invoiceData?.accountId) {
        const acctDoc = await t.get(db.collection('accounts').doc(invoiceData.accountId));
        if (acctDoc.exists) targetAccount = { id: acctDoc.id, ...acctDoc.data() };
      }
      if (!targetAccount) {
        targetAccount = await resolveAccountByRole('costOther', t);
      }

      const lines: AccountingLine[] = [
        { accountId: vendorPayableAcct.id, debit: total, credit: 0 },
        { accountId: targetAccount.id, debit: 0, credit: subtotal }
      ];
      if (taxAmount > 0 && taxReceivableAcct) {
        lines.push({ accountId: taxReceivableAcct.id, debit: 0, credit: taxAmount });
      }

      returnRef = db.collection('purchaseReturns').doc();

      const prepReturnTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `purchase-return:${returnRef.id}:post`,
        transactionDate: returnDate,
        sourceType: 'purchaseReturn',
        sourceId: returnRef.id,
        action: 'return',
        lines,
        createdBy: uid,
      });

      t.set(returnRef, {
        purchaseInvoiceId,
        vendorId: invoiceData?.vendorId,
        number: `RET-${Date.now().toString().slice(-4)}`,
        returnDate,
        reason: reason || '',
        subtotal,
        taxAmount,
        total,
        purchaseType: invoiceData?.purchaseType || 'expense',
        targetAccountId: targetAccount.id,
        cancelled: false,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp()
      });

      const newReturnedTotal = roundMoney(existingReturnsTotal + total);
      t.update(invoiceRef, {
        returnedAmount: newReturnedTotal,
        updatedAt: FieldValue.serverTimestamp()
      });

      writeAccountingTransaction(t, prepReturnTx);
    });

    return { success: true, returnId: returnRef ? returnRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 14. cancelPurchaseReturn
 */
export const cancelPurchaseReturn = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { returnId, cancelReason, cancelledDate } = request.data;
  if (!returnId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing returnId.');
  }

  try {
    await db.runTransaction(async (t: Transaction) => {
      const returnRef = db.collection('purchaseReturns').doc(returnId);
      const returnDoc = await t.get(returnRef);
      if (!returnDoc.exists) throw new Error('Purchase return not found.');
      if (returnDoc.data()?.cancelled) throw new Error('Purchase return already cancelled.');

      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', returnId)
          .where('sourceType', '==', 'purchaseReturn')
          .where('action', '==', 'return')
      );

      const activeTx = querySnap.docs.find(d => !d.data().reversedBy);
      let prepReversal: any = null;
      if (activeTx) {
        prepReversal = await prepareReverseAccountingTransaction(t, {
          originalTxId: activeTx.id,
          reversalDate: cancelledDate || new Date().toISOString().split('T')[0],
          reversalReason: `Cancellation: ${cancelReason || ''}`,
          idempotencyKey: `purchase-return:${returnId}:cancel`,
          createdBy: uid
        });
      }

      t.update(returnRef, {
        cancelled: true,
        cancelReason: cancelReason || '',
        cancelledDate: cancelledDate || new Date().toISOString().split('T')[0],
        updatedAt: FieldValue.serverTimestamp()
      });

      if (prepReversal) {
        writeReverseAccountingTransaction(t, prepReversal);
      }
    });

    return { success: true };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 15. createSupplierCreditNote
 */
export const createSupplierCreditNote = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { vendorId, purchaseInvoiceId, creditNoteDate, subtotal: rawSub, taxAmount: rawTax, reason } = request.data;
  if (!vendorId || !creditNoteDate) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields (vendorId, creditNoteDate).');
  }

  const subtotal = roundMoney(Number(rawSub || 0));
  const taxAmount = roundMoney(Number(rawTax || 0));
  const total = roundMoney(subtotal + taxAmount);

  if (total <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Credit note total must be greater than zero.');
  }

  try {
    let creditNoteRef: any;
    await db.runTransaction(async (t: Transaction) => {
      const vendorDoc = await t.get(db.collection('vendors').doc(vendorId));
      if (!vendorDoc.exists || vendorDoc.data()?.active === false || vendorDoc.data()?.archived === true) {
        throw new Error('Vendor does not exist or is inactive.');
      }

      let targetAccount: any = null;
      if (purchaseInvoiceId) {
        const invDoc = await t.get(db.collection('purchaseInvoices').doc(purchaseInvoiceId));
        if (invDoc.exists && invDoc.data()?.accountId) {
          const acctDoc = await t.get(db.collection('accounts').doc(invDoc.data()?.accountId));
          if (acctDoc.exists) targetAccount = { id: acctDoc.id, ...acctDoc.data() };
        }
      }
      if (!targetAccount) {
        targetAccount = await resolveAccountByRole('costOther', t);
      }

      const vendorPayableAcct = await resolveAccountByRole('vendorPayable', t);
      let taxReceivableAcct: any = null;
      if (taxAmount > 0) {
        taxReceivableAcct = await resolveAccountByRole('taxReceivable', t);
      }

      const lines: AccountingLine[] = [
        { accountId: vendorPayableAcct.id, debit: total, credit: 0 },
        { accountId: targetAccount.id, debit: 0, credit: subtotal }
      ];
      if (taxAmount > 0 && taxReceivableAcct) {
        lines.push({ accountId: taxReceivableAcct.id, debit: 0, credit: taxAmount });
      }

      creditNoteRef = db.collection('supplierCreditNotes').doc();

      const prepTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `supplier-credit-note:${creditNoteRef.id}:post`,
        transactionDate: creditNoteDate,
        sourceType: 'supplierCreditNote',
        sourceId: creditNoteRef.id,
        action: 'creditNote',
        lines,
        createdBy: uid,
      });

      t.set(creditNoteRef, {
        vendorId,
        purchaseInvoiceId: purchaseInvoiceId || null,
        creditNoteNumber: `SCN-${Date.now().toString().slice(-4)}`,
        creditNoteDate,
        reason: reason || '',
        subtotal,
        taxAmount,
        total,
        cancelled: false,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp()
      });

      writeAccountingTransaction(t, prepTx);
    });

    return { success: true, creditNoteId: creditNoteRef ? creditNoteRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 16. cancelSupplierCreditNote
 */
export const cancelSupplierCreditNote = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { creditNoteId, cancelReason, cancelledDate } = request.data;
  if (!creditNoteId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing creditNoteId.');
  }

  try {
    await db.runTransaction(async (t: Transaction) => {
      const cnRef = db.collection('supplierCreditNotes').doc(creditNoteId);
      const cnDoc = await t.get(cnRef);
      if (!cnDoc.exists) throw new Error('Supplier credit note not found.');
      if (cnDoc.data()?.cancelled) throw new Error('Supplier credit note already cancelled.');

      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', creditNoteId)
          .where('sourceType', '==', 'supplierCreditNote')
          .where('action', '==', 'creditNote')
      );

      const activeTx = querySnap.docs.find(d => !d.data().reversedBy);
      let prepReversal: any = null;
      if (activeTx) {
        prepReversal = await prepareReverseAccountingTransaction(t, {
          originalTxId: activeTx.id,
          reversalDate: cancelledDate || new Date().toISOString().split('T')[0],
          reversalReason: `Cancellation: ${cancelReason || ''}`,
          idempotencyKey: `supplier-credit-note:${creditNoteId}:cancel`,
          createdBy: uid
        });
      }

      t.update(cnRef, {
        cancelled: true,
        cancelReason: cancelReason || '',
        cancelledDate: cancelledDate || new Date().toISOString().split('T')[0],
        updatedAt: FieldValue.serverTimestamp()
      });

      if (prepReversal) {
        writeReverseAccountingTransaction(t, prepReversal);
      }
    });

    return { success: true };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 17. createVendorAdvance
 */
export const createVendorAdvance = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { vendorId, amount: rawAmount, paymentMethodId, advanceDate, reference, notes } = request.data;
  if (!vendorId || !paymentMethodId || !advanceDate) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
  }

  const amount = roundMoney(Number(rawAmount || 0));
  if (amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Vendor advance amount must be greater than zero.');
  }

  try {
    let advanceRef: any;
    await db.runTransaction(async (t: Transaction) => {
      const vendorDoc = await t.get(db.collection('vendors').doc(vendorId));
      if (!vendorDoc.exists || vendorDoc.data()?.active === false || vendorDoc.data()?.archived === true) {
        throw new Error('Vendor does not exist or is inactive.');
      }

      const treasuryAccount = await resolvePaymentMethodAccount(paymentMethodId, t);

      const vendorAdvanceAcct = await resolveAccountByRole('vendorAdvance', t);

      const lines: AccountingLine[] = [
        { accountId: vendorAdvanceAcct.id, debit: amount, credit: 0 },
        { accountId: treasuryAccount.id, debit: 0, credit: amount }
      ];

      advanceRef = db.collection('vendorAdvances').doc();

      const prepAdvanceTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `vendor-advance:${advanceRef.id}:post`,
        transactionDate: advanceDate,
        sourceType: 'vendorAdvance',
        sourceId: advanceRef.id,
        action: 'advance',
        lines,
        createdBy: uid,
      });

      t.set(advanceRef, {
        vendorId,
        amount,
        remainingAmount: amount,
        paymentMethodId,
        advanceDate,
        reference: reference || '',
        notes: notes || '',
        status: 'active',
        reversed: false,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp()
      });

      writeAccountingTransaction(t, prepAdvanceTx);
    });

    return { success: true, advanceId: advanceRef ? advanceRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 18. applyVendorAdvance
 */
export const applyVendorAdvance = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { advanceId, purchaseInvoiceId, amount: rawAmount, applyDate } = request.data;
  if (!advanceId || !purchaseInvoiceId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing advanceId or purchaseInvoiceId.');
  }

  const applyAmount = roundMoney(Number(rawAmount || 0));
  if (applyAmount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Application amount must be greater than zero.');
  }

  try {
    let appRef: any;
    await db.runTransaction(async (t: Transaction) => {
      const advanceRef = db.collection('vendorAdvances').doc(advanceId);
      const advanceDoc = await t.get(advanceRef);
      if (!advanceDoc.exists) throw new Error('Vendor advance not found.');
      const advanceData = advanceDoc.data();
      if (advanceData?.reversed) throw new Error('Cannot apply a reversed vendor advance.');

      const remainingAdvance = roundMoney(Number(advanceData?.remainingAmount || 0));
      if (applyAmount > remainingAdvance + 0.0001) {
        throw new Error(`Application amount (${applyAmount}) exceeds remaining advance balance (${remainingAdvance}).`);
      }

      const invoiceRef = db.collection('purchaseInvoices').doc(purchaseInvoiceId);
      const invoiceDoc = await t.get(invoiceRef);
      if (!invoiceDoc.exists) throw new Error('Purchase invoice not found.');
      const invoiceData = invoiceDoc.data();
      if (invoiceData?.cancelled) throw new Error('Cannot apply advance to a cancelled purchase invoice.');

      if (invoiceData?.vendorId !== advanceData?.vendorId) {
        throw new Error('Vendor advance can only be applied to invoices belonging to the same vendor.');
      }

      const totalInvoice = roundMoney(Number(invoiceData?.total || 0));
      const oldPaid = roundMoney(Number(invoiceData?.paidAmount || 0));
      const remainingInvoice = roundMoney(totalInvoice - oldPaid);

      if (applyAmount > remainingInvoice + 0.0001) {
        throw new Error(`Application amount (${applyAmount}) exceeds remaining invoice balance (${remainingInvoice}).`);
      }

      const vendorPayableAcct = await resolveAccountByRole('vendorPayable', t);
      const vendorAdvanceAcct = await resolveAccountByRole('vendorAdvance', t);

      appRef = advanceRef.collection('applications').doc();

      const prepTx = await prepareAccountingTransaction(t, {
        idempotencyKey: `vendor-advance:${advanceId}:apply:${appRef.id}`,
        transactionDate: applyDate || new Date().toISOString().split('T')[0],
        sourceType: 'vendorAdvanceApplication',
        sourceId: appRef.id,
        action: 'applyAdvance',
        lines: [
          { accountId: vendorPayableAcct.id, debit: applyAmount, credit: 0 },
          { accountId: vendorAdvanceAcct.id, debit: 0, credit: applyAmount }
        ],
        createdBy: uid,
      });

      const newRemainingAdvance = roundMoney(remainingAdvance - applyAmount);
      const advanceStatus = newRemainingAdvance <= 0.001 ? 'fully_applied' : 'active';

      const newPaidInvoice = roundMoney(oldPaid + applyAmount);
      const newRemainingInvoice = roundMoney(totalInvoice - newPaidInvoice);
      const invoiceStatus = newRemainingInvoice <= 0.001 ? 'paid' : 'partial';

      t.set(appRef, {
        advanceId,
        purchaseInvoiceId,
        vendorId: advanceData?.vendorId,
        amount: applyAmount,
        date: applyDate || new Date().toISOString().split('T')[0],
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp()
      });

      t.update(advanceRef, {
        remainingAmount: newRemainingAdvance,
        status: advanceStatus,
        updatedAt: FieldValue.serverTimestamp()
      });

      t.update(invoiceRef, {
        paidAmount: newPaidInvoice,
        remainingAmount: newRemainingInvoice,
        status: invoiceStatus,
        updatedAt: FieldValue.serverTimestamp()
      });

      writeAccountingTransaction(t, prepTx);
    });

    return { success: true, applicationId: appRef ? appRef.id : undefined };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * 19. reverseVendorAdvance
 */
export const reverseVendorAdvance = functions.https.onCall(async (request: any) => {
  const uid = request.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  await authorizeOpsWrite(uid);

  const { advanceId, reversalReason, reversalDate } = request.data;
  if (!advanceId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing advanceId.');
  }

  try {
    await db.runTransaction(async (t: Transaction) => {
      const advanceRef = db.collection('vendorAdvances').doc(advanceId);
      const advanceDoc = await t.get(advanceRef);
      if (!advanceDoc.exists) throw new Error('Vendor advance not found.');
      const advanceData = advanceDoc.data();
      if (advanceData?.reversed) throw new Error('Vendor advance is already reversed.');

      const origAmount = roundMoney(Number(advanceData?.amount || 0));
      const remainingAmount = roundMoney(Number(advanceData?.remainingAmount || 0));

      if (Math.abs(origAmount - remainingAmount) > 0.001) {
        throw new Error('Cannot reverse a vendor advance that has active invoice applications. Unapply applications first.');
      }

      const querySnap = await t.get(
        db.collection('accountingTransactions')
          .where('sourceId', '==', advanceId)
          .where('sourceType', '==', 'vendorAdvance')
          .where('action', '==', 'advance')
      );

      const activeTx = querySnap.docs.find(d => !d.data().reversedBy);
      if (!activeTx) {
        throw new Error(`Original advance accounting transaction not found or already reversed for advance ${advanceId}.`);
      }

      const prepReversal = await prepareReverseAccountingTransaction(t, {
        originalTxId: activeTx.id,
        reversalDate: reversalDate || new Date().toISOString().split('T')[0],
        reversalReason: reversalReason || 'Vendor advance reversed by user',
        idempotencyKey: `vendor-advance:${advanceId}:reverse`,
        createdBy: uid
      });

      t.update(advanceRef, {
        reversed: true,
        status: 'reversed',
        remainingAmount: 0,
        reversedAt: FieldValue.serverTimestamp(),
        reversedBy: uid,
        reversalReason: reversalReason || ''
      });

      writeReverseAccountingTransaction(t, prepReversal);
    });

    return { success: true };
  } catch (error: any) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});


