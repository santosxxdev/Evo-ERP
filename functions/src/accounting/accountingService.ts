import { getFirestore, FieldValue, Timestamp, Transaction } from 'firebase-admin/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

export interface AccountingLine {
  accountId: string;
  debit: number;
  credit: number;
}

export interface AccountingTransaction {
  idempotencyKey: string;
  transactionDate: string; // YYYY-MM-DD
  sourceType: string;
  sourceId: string;
  action: 'create' | 'edit' | 'cancel' | 'payment' | 'manual' | 'return' | 'creditNote' | 'advance' | 'applyAdvance';
  lines: AccountingLine[];
  totalDebit: number;
  totalCredit: number;
  createdBy: string;
  createdAt: Timestamp;
  reversalOf?: string;
  reversedBy?: string;
  reversalReason?: string;
  reversalDate?: string;
}

/**
 * Rounds monetary amounts to 2 decimal places to prevent float errors.
 */
export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * Validates the transaction dates against the period lock.
 */
export async function validateAccountingPeriod(transactionDate: string, transaction: Transaction) {
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
export async function resolveAccount(accountId: string, transaction: Transaction) {
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
export async function resolveAccountByRole(role: string, transaction: Transaction) {
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
export function validateAccountingTransaction(lines: AccountingLine[]) {
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
export async function prepareAccountingTransaction(
  t: Transaction,
  params: {
    idempotencyKey: string;
    transactionDate: string;
    sourceType: string;
    sourceId: string;
    action: AccountingTransaction['action'];
    lines: AccountingLine[];
    createdBy: string;
  }
) {
  // 1. Check idempotency (READ)
  const querySnap = await t.get(
    db.collection('accountingTransactions').where('idempotencyKey', '==', params.idempotencyKey).limit(1)
  );
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
  const txData: AccountingTransaction = {
    idempotencyKey: params.idempotencyKey,
    transactionDate: params.transactionDate,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    action: params.action,
    lines: params.lines,
    totalDebit,
    totalCredit,
    createdBy: params.createdBy,
    createdAt: FieldValue.serverTimestamp() as Timestamp,
  };

  return { isDuplicate: false, existingId: null, txRef, txData };
}

/**
 * Writes a prepared accounting transaction (WRITE ONLY).
 */
export function writeAccountingTransaction(t: Transaction, prepared: { isDuplicate: boolean; existingId?: string | null; txRef: any; txData: any }) {
  if (prepared.isDuplicate) return prepared.existingId;
  t.set(prepared.txRef, prepared.txData);
  return prepared.txRef.id;
}

/**
 * Prepares a reversal by performing ALL required reads upfront.
 */
export async function prepareReverseAccountingTransaction(
  t: Transaction,
  params: {
    originalTxId: string;
    reversalDate: string;
    reversalReason: string;
    idempotencyKey: string;
    createdBy: string;
  }
) {
  // 1. Check idempotency for reversal (READ)
  const querySnap = await t.get(
    db.collection('accountingTransactions').where('idempotencyKey', '==', params.idempotencyKey).limit(1)
  );
  if (!querySnap.empty) {
    return { isDuplicate: true, existingId: querySnap.docs[0].id, reversalRef: null, reversalData: null, originalRef: null, originalUpdate: null };
  }

  // 2. Load original (READ)
  const originalRef = db.collection('accountingTransactions').doc(params.originalTxId);
  const originalDoc = await t.get(originalRef);
  if (!originalDoc.exists) {
    throw new Error(`Cannot reverse transaction ${params.originalTxId}: Does not exist.`);
  }

  const originalData = originalDoc.data() as AccountingTransaction;
  if (originalData.reversedBy) {
    throw new Error(`Transaction ${params.originalTxId} is already reversed by ${originalData.reversedBy}.`);
  }

  // 3. Period lock check (READ)
  await validateAccountingPeriod(params.reversalDate, t);

  // 4. Create reversed lines
  const reversedLines: AccountingLine[] = originalData.lines.map(line => ({
    accountId: line.accountId,
    debit: line.credit,
    credit: line.debit,
  }));

  const reversalRef = db.collection('accountingTransactions').doc();
  const reversalData: AccountingTransaction = {
    idempotencyKey: params.idempotencyKey,
    transactionDate: params.reversalDate,
    sourceType: originalData.sourceType,
    sourceId: originalData.sourceId,
    action: 'cancel',
    lines: reversedLines,
    totalDebit: originalData.totalDebit,
    totalCredit: originalData.totalCredit,
    createdBy: params.createdBy,
    createdAt: FieldValue.serverTimestamp() as Timestamp,
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
export function writeReverseAccountingTransaction(t: Transaction, prepared: { isDuplicate: boolean; existingId?: string | null; reversalRef: any; reversalData: any; originalRef: any; originalUpdate: any }) {
  if (prepared.isDuplicate) return prepared.existingId;
  t.set(prepared.reversalRef, prepared.reversalData);
  t.update(prepared.originalRef, prepared.originalUpdate);
  return prepared.reversalRef.id;
}

/**
 * Legacy wrappers for backward compatibility.
 */
export async function postAccountingTransaction(t: Transaction, params: any) {
  const prepared = await prepareAccountingTransaction(t, params);
  return writeAccountingTransaction(t, prepared);
}

export async function reverseAccountingTransaction(t: Transaction, params: any) {
  const prepared = await prepareReverseAccountingTransaction(t, params);
  return writeReverseAccountingTransaction(t, prepared);
}
