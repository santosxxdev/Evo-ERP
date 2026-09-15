"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.postManualVoucher = exports.cancelInvoice = exports.editInvoice = exports.createPayment = exports.createInvoice = void 0;
const functions = __importStar(require("firebase-functions/v2"));
const admin = __importStar(require("firebase-admin"));
const accountingService_1 = require("./accounting/accountingService");
const db = admin.firestore();
/**
 * Checks authorization for ops writing (sales, accountant, admin).
 */
async function authorizeOpsWrite(uid) {
    const userDoc = await db.collection('users').doc(uid).get();
    const role = userDoc.data()?.role;
    if (!role || (role !== 'admin' && role !== 'accountant' && role !== 'sales')) {
        throw new functions.https.HttpsError('permission-denied', 'Unauthorized to perform operational writes.');
    }
}
/**
 * Checks authorization for finance (admin, accountant).
 */
async function authorizeFinance(uid) {
    const userDoc = await db.collection('users').doc(uid).get();
    const role = userDoc.data()?.role;
    if (!role || (role !== 'admin' && role !== 'accountant')) {
        throw new functions.https.HttpsError('permission-denied', 'Unauthorized to perform finance writes.');
    }
}
/**
 * 1. createInvoice
 */
exports.createInvoice = functions.https.onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
    await authorizeOpsWrite(uid);
    const { values, number, payment } = request.data;
    if (!values.date || !values.clientId) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
    }
    // Calculate totals on backend
    const total = Number(values.total || 0);
    const adBudget = Number(values.adBudgetTotal || 0);
    const taxAmount = Number(values.taxAmount || 0);
    const fees = total - adBudget - taxAmount;
    if (total <= 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Invoice total must be greater than zero.');
    }
    try {
        await db.runTransaction(async (t) => {
            const receivableAcct = await (0, accountingService_1.resolveAccountByRole)('receivable', t);
            const revenueAcct = await (0, accountingService_1.resolveAccountByRole)('revenue', t);
            const adHeldAcct = await (0, accountingService_1.resolveAccountByRole)('adBudgetHeld', t);
            const taxAcct = await (0, accountingService_1.resolveAccountByRole)('tax', t);
            const lines = [
                { accountId: receivableAcct.id, debit: total, credit: 0 }
            ];
            if (fees > 0)
                lines.push({ accountId: revenueAcct.id, debit: 0, credit: fees });
            if (adBudget > 0)
                lines.push({ accountId: adHeldAcct.id, debit: 0, credit: adBudget });
            if (taxAmount > 0)
                lines.push({ accountId: taxAcct.id, debit: 0, credit: taxAmount });
            // Create invoice doc
            const invoiceRef = db.collection('invoices').doc();
            const invoiceData = {
                ...values,
                number,
                paidAmount: payment ? Number(payment.amount) : 0,
                createdBy: uid,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            t.set(invoiceRef, invoiceData);
            // Post Accounting Transaction
            await (0, accountingService_1.postAccountingTransaction)(t, {
                idempotencyKey: `invoice:${invoiceRef.id}:issue`,
                transactionDate: values.date,
                sourceType: 'invoice',
                sourceId: invoiceRef.id,
                action: 'create',
                lines,
                createdBy: uid,
            });
            // Handle Initial Payment
            if (payment) {
                const paymentAmount = Number(payment.amount);
                if (paymentAmount <= 0) {
                    throw new Error('Payment amount must be greater than zero.');
                }
                const paymentRef = invoiceRef.collection('payments').doc();
                t.set(paymentRef, {
                    ...payment,
                    amount: paymentAmount,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdBy: uid
                });
                // Resolve Payment Method securely
                const methodDoc = await t.get(db.collection('paymentMethods').doc(payment.methodId));
                if (!methodDoc.exists || !methodDoc.data()?.active) {
                    throw new functions.https.HttpsError('failed-precondition', 'Invalid or inactive payment method.');
                }
                const methodData = methodDoc.data();
                if (!methodData?.accountNumber) {
                    throw new functions.https.HttpsError('failed-precondition', 'Payment method is missing a treasury account mapping.');
                }
                const treasuryAccount = await resolveAccount(methodData.accountNumber, t);
                if (!treasuryAccount || treasuryAccount.archived) {
                    throw new functions.https.HttpsError('failed-precondition', 'Resolved treasury account is invalid or archived.');
                }
                await (0, accountingService_1.postAccountingTransaction)(t, {
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
        });
        return { success: true };
    }
    catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});
/**
 * 2. createPayment
 */
exports.createPayment = functions.https.onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
    await authorizeOpsWrite(uid);
    const { invoiceId, payment } = request.data;
    if (!invoiceId || !payment || !payment.methodId || Number(payment.amount) <= 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid payment data.');
    }
    try {
        await db.runTransaction(async (t) => {
            const invoiceRef = db.collection('invoices').doc(invoiceId);
            const invoiceDoc = await t.get(invoiceRef);
            if (!invoiceDoc.exists) {
                throw new Error('Invoice not found.');
            }
            const receivableAcct = await (0, accountingService_1.resolveAccountByRole)('receivable', t);
            const paymentAmount = Number(payment.amount);
            const paymentRef = invoiceRef.collection('payments').doc();
            t.set(paymentRef, {
                ...payment,
                amount: paymentAmount,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdBy: uid
            });
            const oldPaidAmount = invoiceDoc.data()?.paidAmount || 0;
            t.update(invoiceRef, { paidAmount: oldPaidAmount + paymentAmount });
            const methodDoc = await t.get(db.collection('paymentMethods').doc(payment.methodId));
            if (!methodDoc.exists || !methodDoc.data()?.active) {
                throw new functions.https.HttpsError('failed-precondition', 'Invalid or inactive payment method.');
            }
            const methodData = methodDoc.data();
            if (!methodData?.accountNumber) {
                throw new functions.https.HttpsError('failed-precondition', 'Payment method missing account mapping.');
            }
            const treasuryAccount = await resolveAccount(methodData.accountNumber, t);
            if (!treasuryAccount || treasuryAccount.archived) {
                throw new functions.https.HttpsError('failed-precondition', 'Resolved account is invalid or archived.');
            }
            await (0, accountingService_1.postAccountingTransaction)(t, {
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
        });
        return { success: true };
    }
    catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});
/**
 * 3. editInvoice
 */
exports.editInvoice = functions.https.onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
    await authorizeOpsWrite(uid);
    const { invoiceId, values, editVersion } = request.data;
    if (!invoiceId || !values || !editVersion) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing fields.');
    }
    try {
        await db.runTransaction(async (t) => {
            const invoiceRef = db.collection('invoices').doc(invoiceId);
            const invoiceDoc = await t.get(invoiceRef);
            if (!invoiceDoc.exists)
                throw new Error('Invoice not found');
            // Update operational document
            t.update(invoiceRef, { ...values, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            // Calculate new totals
            const total = Number(values.total || 0);
            const adBudget = Number(values.adBudgetTotal || 0);
            const taxAmount = Number(values.taxAmount || 0);
            const fees = total - adBudget - taxAmount;
            // Reverse old accounting transaction
            const querySnap = await t.get(db.collection('accountingTransactions')
                .where('sourceId', '==', invoiceId)
                .where('sourceType', '==', 'invoice')
                .where('action', '==', 'create')
                .limit(1));
            if (!querySnap.empty) {
                const originalTxId = querySnap.docs[0].id;
                await (0, accountingService_1.reverseAccountingTransaction)(t, {
                    originalTxId,
                    reversalDate: values.date, // Reverse on the new effective date, or today? Typically original date or today. We'll use values.date
                    reversalReason: `Edit version ${editVersion}`,
                    idempotencyKey: `invoice:${invoiceId}:edit:${editVersion}:reverse`,
                    createdBy: uid
                });
                // Post new transaction
                const receivableAcct = await (0, accountingService_1.resolveAccountByRole)('receivable', t);
                const revenueAcct = await (0, accountingService_1.resolveAccountByRole)('revenue', t);
                const adHeldAcct = await (0, accountingService_1.resolveAccountByRole)('adBudgetHeld', t);
                const taxAcct = await (0, accountingService_1.resolveAccountByRole)('tax', t);
                const lines = [
                    { accountId: receivableAcct.id, debit: total, credit: 0 }
                ];
                if (fees > 0)
                    lines.push({ accountId: revenueAcct.id, debit: 0, credit: fees });
                if (adBudget > 0)
                    lines.push({ accountId: adHeldAcct.id, debit: 0, credit: adBudget });
                if (taxAmount > 0)
                    lines.push({ accountId: taxAcct.id, debit: 0, credit: taxAmount });
                await (0, accountingService_1.postAccountingTransaction)(t, {
                    idempotencyKey: `invoice:${invoiceId}:edit:${editVersion}:post`,
                    transactionDate: values.date,
                    sourceType: 'invoice',
                    sourceId: invoiceId,
                    action: 'edit',
                    lines,
                    createdBy: uid,
                });
            }
        });
        return { success: true };
    }
    catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});
/**
 * 4. cancelInvoice
 */
exports.cancelInvoice = functions.https.onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
    await authorizeOpsWrite(uid);
    const { invoiceId, cancelReason, cancelledDate } = request.data;
    if (!invoiceId || !cancelledDate) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing fields.');
    }
    try {
        await db.runTransaction(async (t) => {
            const invoiceRef = db.collection('invoices').doc(invoiceId);
            const invoiceDoc = await t.get(invoiceRef);
            if (!invoiceDoc.exists)
                throw new Error('Invoice not found');
            if (invoiceDoc.data()?.cancelled)
                throw new Error('Invoice already cancelled');
            t.update(invoiceRef, {
                cancelled: true,
                cancelReason: cancelReason || '',
                cancelledDate
            });
            const querySnap = await t.get(db.collection('accountingTransactions')
                .where('sourceId', '==', invoiceId)
                .where('sourceType', '==', 'invoice')
                .where('action', 'in', ['create', 'edit'])
            // Ideally we fetch the active one. Reversed transactions have reversedBy set.
            );
            // Find the active un-reversed transaction
            const activeTx = querySnap.docs.find(d => !d.data().reversedBy);
            if (activeTx) {
                await (0, accountingService_1.reverseAccountingTransaction)(t, {
                    originalTxId: activeTx.id,
                    reversalDate: cancelledDate,
                    reversalReason: `Cancellation: ${cancelReason}`,
                    idempotencyKey: `invoice:${invoiceId}:cancel`,
                    createdBy: uid
                });
            }
        });
        return { success: true };
    }
    catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});
/**
 * 5. postManualVoucher
 */
exports.postManualVoucher = functions.https.onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
    await authorizeFinance(uid);
    const { values } = request.data;
    if (!values.date || !values.lines || values.lines.length < 2) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid voucher data.');
    }
    try {
        await db.runTransaction(async (t) => {
            const voucherRef = db.collection('journalEntries').doc();
            const voucherData = {
                ...values,
                createdBy: uid,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            t.set(voucherRef, voucherData);
            // Validate lines explicitly via accounting service
            const accountingLines = values.lines.map((l) => ({
                accountId: l.accountId,
                debit: Number(l.debit || 0),
                credit: Number(l.credit || 0)
            }));
            await (0, accountingService_1.postAccountingTransaction)(t, {
                idempotencyKey: `voucher:${voucherRef.id}:post`,
                transactionDate: values.date,
                sourceType: 'voucher',
                sourceId: voucherRef.id,
                action: 'manual',
                lines: accountingLines,
                createdBy: uid,
            });
        });
        return { success: true };
    }
    catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});
//# sourceMappingURL=index.js.map