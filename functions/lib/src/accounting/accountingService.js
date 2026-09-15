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
exports.validateAccountingPeriod = validateAccountingPeriod;
exports.resolveAccount = resolveAccount;
exports.resolveAccountByRole = resolveAccountByRole;
exports.validateAccountingTransaction = validateAccountingTransaction;
exports.postAccountingTransaction = postAccountingTransaction;
exports.reverseAccountingTransaction = reverseAccountingTransaction;
const admin = __importStar(require("firebase-admin"));
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
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
 * Fetches an account by ID and verifies it exists.
 */
async function resolveAccount(accountId, transaction) {
    if (!accountId) {
        throw new Error('Account ID is required.');
    }
    const accountDoc = await transaction.get(db.collection('accounts').doc(accountId));
    if (!accountDoc.exists) {
        throw new Error(`Account with ID ${accountId} does not exist.`);
    }
    return accountDoc.data();
}
/**
 * Fetches an account by role.
 */
async function resolveAccountByRole(role, transaction) {
    // Since we are in a transaction and Firestore doesn't support query in transaction easily without limits,
    // wait, transaction.get(query) IS supported, but it's better to fetch all accounts and filter if small,
    // or query. Let's query.
    const querySnapshot = await transaction.get(db.collection('accounts').where('role', '==', role).limit(1));
    if (querySnapshot.empty) {
        throw new Error(`Missing required account role: ${role}`);
    }
    const doc = querySnapshot.docs[0];
    return { id: doc.id, ...doc.data() };
}
/**
 * Validates double-entry rules.
 */
function validateAccountingTransaction(lines) {
    if (lines.length < 2) {
        throw new Error('Transaction must have at least two lines.');
    }
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of lines) {
        if (typeof line.debit !== 'number' || typeof line.credit !== 'number') {
            throw new Error('Debit and credit must be valid numbers.');
        }
        if (line.debit < 0 || line.credit < 0) {
            throw new Error('Debit and credit must be positive numbers.');
        }
        if (line.debit > 0 && line.credit > 0) {
            throw new Error('A single line cannot have both a debit and a credit.');
        }
        totalDebit += line.debit;
        totalCredit += line.credit;
    }
    // Use a small epsilon for floating point comparison if needed, but assuming exact numbers for currency if multiplied, 
    // or just round to 4 decimals.
    const diff = Math.abs(totalDebit - totalCredit);
    if (diff > 0.0001) {
        throw new Error(`Transaction is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`);
    }
    if (totalDebit <= 0) {
        throw new Error('Transaction must have a positive total debit.');
    }
    return { totalDebit, totalCredit };
}
/**
 * Core posting service. Must be called inside a Firestore Transaction or Batch.
 */
async function postAccountingTransaction(t, params) {
    // 1. Check idempotency
    const querySnap = await t.get(db.collection('accountingTransactions').where('idempotencyKey', '==', params.idempotencyKey).limit(1));
    if (!querySnap.empty) {
        // Return existing to prevent duplicates
        return querySnap.docs[0].id;
    }
    // 2. Validate period
    await validateAccountingPeriod(params.transactionDate, t);
    // 3. Validate lines and accounts
    const { totalDebit, totalCredit } = validateAccountingTransaction(params.lines);
    for (const line of params.lines) {
        await resolveAccount(line.accountId, t);
    }
    // 4. Create transaction document
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    t.set(txRef, txData);
    return txRef.id;
}
/**
 * Reverses a transaction safely.
 */
async function reverseAccountingTransaction(t, params) {
    // Check idempotency for reversal
    const querySnap = await t.get(db.collection('accountingTransactions').where('idempotencyKey', '==', params.idempotencyKey).limit(1));
    if (!querySnap.empty) {
        return querySnap.docs[0].id;
    }
    // Load original
    const originalRef = db.collection('accountingTransactions').doc(params.originalTxId);
    const originalDoc = await t.get(originalRef);
    if (!originalDoc.exists) {
        throw new Error(`Cannot reverse transaction ${params.originalTxId}: Does not exist.`);
    }
    const originalData = originalDoc.data();
    if (originalData.reversedBy) {
        throw new Error(`Transaction ${params.originalTxId} is already reversed by ${originalData.reversedBy}.`);
    }
    await validateAccountingPeriod(params.reversalDate, t);
    // Create reversed lines
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        reversalOf: params.originalTxId,
    };
    t.set(reversalRef, reversalData);
    // Link original
    t.update(originalRef, {
        reversedBy: reversalRef.id,
        reversalDate: params.reversalDate,
        reversalReason: params.reversalReason
    });
    return reversalRef.id;
}
//# sourceMappingURL=accountingService.js.map