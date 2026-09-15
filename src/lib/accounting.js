import { round2, toNumber } from './format.js'
import { byRole } from './accounts.js'

/**
 * Validates an accounting transaction before posting.
 * Throws an error if validation fails.
 */
export function validateTransaction(transaction) {
  if (!transaction) throw new Error('Transaction is null or undefined')
  if (!transaction.lines || !Array.isArray(transaction.lines)) {
    throw new Error('Transaction lines must be an array')
  }
  
  if (transaction.lines.length < 2) {
    throw new Error('Transaction must contain at least 2 lines')
  }

  let totalDebit = 0
  let totalCredit = 0

  for (let i = 0; i < transaction.lines.length; i++) {
    const line = transaction.lines[i]
    if (!line.accountId) throw new Error(`Line ${i + 1} is missing an accountId`)
    
    const debit = round2(toNumber(line.debit))
    const credit = round2(toNumber(line.credit))

    if (debit < 0) throw new Error(`Line ${i + 1} debit cannot be negative`)
    if (credit < 0) throw new Error(`Line ${i + 1} credit cannot be negative`)
    
    if (debit > 0 && credit > 0) {
      throw new Error(`Line ${i + 1} cannot have both debit and credit`)
    }

    totalDebit = round2(totalDebit + debit)
    totalCredit = round2(totalCredit + credit)
  }

  if (Math.abs(totalDebit - totalCredit) >= 0.01) {
    throw new Error(`Unbalanced transaction: Debits (${totalDebit}) != Credits (${totalCredit})`)
  }

  return true
}

/**
 * Resolves an account by role and throws an error if missing.
 */
export function requireRole(accounts, role, sourceDocDescription = '') {
  const account = byRole(accounts, role)
  if (!account) {
    throw new Error(`Accounting Error: Missing required account role '${role}'. Please configure your Chart of Accounts. Source: ${sourceDocDescription}`)
  }
  return account
}

/**
 * Validates against closed periods.
 */
export function validatePeriod(date, settings) {
  if (!date) return
  const closedBefore = settings?.closedPeriodBefore
  if (closedBefore && date < closedBefore) {
    throw new Error(`Accounting Error: Cannot post transaction in a closed period (date ${date} is before ${closedBefore})`)
  }
}

import { collection, doc, serverTimestamp, query, where, getDocs } from 'firebase/firestore'
import { db } from './firebase.js'
import { COL } from './db.js'

export function prepareTransaction(transaction, batch) {
  validateTransaction(transaction)
  
  const ref = doc(collection(db, COL.accountingTransactions))
  batch.set(ref, {
    ...transaction,
    status: 'posted',
    createdAt: serverTimestamp()
  })
  return ref.id
}

export async function hasAccountingTransaction(sourceType, sourceId) {
  const q = query(
    collection(db, COL.accountingTransactions),
    where('sourceType', '==', sourceType),
    where('sourceId', '==', sourceId)
  )
  const snap = await getDocs(q)
  if (snap.empty) return false
  return snap.docs.some((entry) => {
    const status = entry.data().status
    return !status || status === 'posted'
  })
}
