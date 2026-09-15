"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.roundMoney = roundMoney;
exports.validateAccountingPeriod = validateAccountingPeriod;
exports.resolveAccount = resolveAccount;
exports.resolveAccountByRole = resolveAccountByRole;
exports.validateAccountingTransaction = validateAccountingTransaction;
exports.prepareAccountingTransaction = prepareAccountingTransaction;
exports.writeAccountingTransaction = writeAccountingTransaction;
exports.prepareReverseAccountingTransaction = prepareReverseAccountingTransaction;
exports.writeReverseAccountingTransaction = writeReverseAccountingTransaction;
exports.postAccountingTransaction = postAccountingTransaction;
exports.reverseAccountingTransaction = reverseAccountingTransaction;
const firestore_1 = require("firebase-admin/firestore");
const app_1 = require("firebase-admin/app");
if (!(0, app_1.getApps)().length) {
    (0, app_1.initializeApp)();
}
const db = (0, firestore_1.getFirestore)();
/**
 * Rounds monetary amounts to 2 decimal places to prevent float errors.
 */
function roundMoney(amount) {
    return Math.round((amount + Number.EPSILON) * 100) / 100;
}
/**
 * Validates the transaction dates against the period lock.
 */
async function validateAccountingPeriod(transactionDate, transaction) {
    const settingsDoc = await transaction.get(db.collection('settings').doc('default'));
    if (settingsDoc.exists) {
        const closedBefore = settingsDoc.data()?.closedPeriodBefore;
        if (closedBefore && transactionDate < closedBefore) {
            throw new Error(`Accounting period is closed before ${closedBefore}. Transaction date ${transactionDate} is rejected.`);
        }
    }
}
/**
 * Fetches an account by ID and verifies it exists and is active.
 */
async function resolveAccount(accountId, transaction) {
    if (!accountId) {
        throw new Error('Account ID is required.');
    }
    const accountDoc = await transaction.get(db.collection('accounts').doc(accountId));
    if (!accountDoc.exists) {
        throw new Error(`Account with ID ${accountId} does not exist.`);
    }
    const data = accountDoc.data();
    if (data?.archived || data?.active === false) {
        throw new Error(`Account ${accountId} (${data?.name || ''}) is inactive or archived.`);
    }
    if (data?.isGroup) {
        throw new Error(`Account ${accountId} (${data?.code} - ${data?.name}) is a parent group account and cannot receive direct postings.`);
    }
    return { id: accountDoc.id, ...data };
}
/**
 * Fetches an active account by role.
 */
async function resolveAccountByRole(role, transaction) {
    const querySnapshot = await transaction.get(db.collection('accounts').where('role', '==', role).limit(10));
    if (querySnapshot.empty) {
        throw new Error(`Missing required account role: ${role}`);
    }
    const activeDoc = querySnapshot.docs.find(d => !d.data().archived && d.data().active !== false && !d.data().isGroup);
    if (!activeDoc) {
        throw new Error(`Account role '${role}' maps to an inactive, archived, or group account.`);
    }
    return { id: activeDoc.id, ...activeDoc.data() };
}
/**
 * Validates double-entry rules.
 */
function validateAccountingTransaction(lines) {
    if (!lines || lines.length < 2) {
        throw new Error('Transaction must have at least two lines.');
    }
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of lines) {
        if (typeof line.debit !== 'number' || typeof line.credit !== 'number' || isNaN(line.debit) || isNaN(line.credit)) {
            throw new Error('Debit and credit must be valid numbers.');
        }
        if (line.debit < 0 || line.credit < 0) {
            throw new Error('Debit and credit must be non-negative numbers.');
        }
        if (line.debit > 0 && line.credit > 0) {
            throw new Error('A single line cannot have both a debit and a credit.');
        }
        if (line.debit === 0 && line.credit === 0) {
            throw new Error('Line debit and credit cannot both be zero.');
        }
        line.debit = roundMoney(line.debit);
        line.credit = roundMoney(line.credit);
        totalDebit = roundMoney(totalDebit + line.debit);
        totalCredit = roundMoney(totalCredit + line.credit);
    }
    const diff = Math.abs(totalDebit - totalCredit);
    if (diff > 0.0001) {
        throw new Error(`Transaction is not balanced. Total Debit: ${totalDebit}, Total Credit: ${totalCredit}`);
    }
    if (totalDebit <= 0) {
        throw new Error('Transaction total must be greater than zero.');
    }
    return { totalDebit, totalCredit };
}
/**
 * Prepares an accounting transaction by performing ALL required reads upfront.
 */
async function prepareAccountingTransaction(t, params) {
    // 1. Check idempotency (READ)
    const querySnap = await t.get(db.collection('accountingTransactions').where('idempotencyKey', '==', params.idempotencyKey).limit(1));
    if (!querySnap.empty) {
        return { isDuplicate: true, existingId: querySnap.docs[0].id, txRef: null, txData: null };
    }
    // 2. Validate period (READ)
    await validateAccountingPeriod(params.transactionDate, t);
    // 3. Validate lines and resolve accounts (READ)
    const { totalDebit, totalCredit } = validateAccountingTransaction(params.lines);
    for (const line of params.lines) {
        await resolveAccount(line.accountId, t);
    }
    // 4. Build doc data
    const txRef = db.collection('accountingTransactions').doc();
    const txData = {
        idempotencyKey: params.idempotencyKey,
        transactionDate: params.transactionDate,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        action: params.action,
        lines: params.lines,
        totalDebit,
        totalCredit,
        createdBy: params.createdBy,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    };
    return { isDuplicate: false, existingId: null, txRef, txData };
}
/**
 * Writes a prepared accounting transaction (WRITE ONLY).
 */
function writeAccountingTransaction(t, prepared) {
    if (prepared.isDuplicate)
        return prepared.existingId;
    t.set(prepared.txRef, prepared.txData);
    return prepared.txRef.id;
}
/**
 * Prepares a reversal by performing ALL required reads upfront.
 */
async function prepareReverseAccountingTransaction(t, params) {
    // 1. Check idempotency for reversal (READ)
    const querySnap = await t.get(db.collection('accountingTransactions').where('idempotencyKey', '==', params.idempotencyKey).limit(1));
    if (!querySnap.empty) {
        return { isDuplicate: true, existingId: querySnap.docs[0].id, reversalRef: null, reversalData: null, originalRef: null, originalUpdate: null };
    }
    // 2. Load original (READ)
    const originalRef = db.collection('accountingTransactions').doc(params.originalTxId);
    const originalDoc = await t.get(originalRef);
    if (!originalDoc.exists) {
        throw new Error(`Cannot reverse transaction ${params.originalTxId}: Does not exist.`);
    }
    const originalData = originalDoc.data();
    if (originalData.reversedBy) {
        throw new Error(`Transaction ${params.originalTxId} is already reversed by ${originalData.reversedBy}.`);
    }
    // 3. Period lock check (READ)
    await validateAccountingPeriod(params.reversalDate, t);
    // 4. Create reversed lines
    const reversedLines = originalData.lines.map(line => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
    }));
    const reversalRef = db.collection('accountingTransactions').doc();
    const reversalData = {
        idempotencyKey: params.idempotencyKey,
        transactionDate: params.reversalDate,
        sourceType: originalData.sourceType,
        sourceId: originalData.sourceId,
        action: 'cancel',
        lines: reversedLines,
        totalDebit: originalData.totalDebit,
        totalCredit: originalData.totalCredit,
        createdBy: params.createdBy,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
        reversalOf: params.originalTxId,
    };
    const originalUpdate = {
        reversedBy: reversalRef.id,
        reversalDate: params.reversalDate,
        reversalReason: params.reversalReason
    };
    return { isDuplicate: false, existingId: null, reversalRef, reversalData, originalRef, originalUpdate };
}
/**
 * Writes a prepared reversal transaction (WRITE ONLY).
 */
function writeReverseAccountingTransaction(t, prepared) {
    if (prepared.isDuplicate)
        return prepared.existingId;
    t.set(prepared.reversalRef, prepared.reversalData);
    t.update(prepared.originalRef, prepared.originalUpdate);
    return prepared.reversalRef.id;
}
/**
 * Legacy wrappers for backward compatibility.
 */
async function postAccountingTransaction(t, params) {
    const prepared = await prepareAccountingTransaction(t, params);
    return writeAccountingTransaction(t, prepared);
}
async function reverseAccountingTransaction(t, params) {
    const prepared = await prepareReverseAccountingTransaction(t, params);
    return writeReverseAccountingTransaction(t, prepared);
}
//# sourceMappingURL=accountingService.js.map