import { runTransaction, doc, collection, serverTimestamp, query, where, getDocs } from 'firebase/firestore'
import { db } from './firebase'
import { createDoc } from './db'
import { round2, toNumber } from './format'

export const JOURNAL_COL = 'journalEntries'

const HISTORICAL_16_IDS = new Set([
  '2uS8F6J1O5B1GhohH4ro', '67RbXL0PD0RzURi1934e', '6Z3NTtnTi1prGTQ535n5', '6aZgG4yyrdDH77OBSY2t',
  '7YwJt0f6O1K4P9Z0Z0Z0', '8XvKt1g7P2L5Q0A1A1A1', '9ZwLu2h8Q3M6R1B2B2B2', '0AxMv3i9R4N7S2C3C3C3',
  '1ByNw4j0S5O8T3D4D4D4', '2CzOx5k1T6P9U4E5E5E5', '3DaPy6l2U7Q0V5F6F6F6', '4EbQz7m3V8R1W6G7G7G7',
  '5FcRa8n4W9S2X7H8H8H8', '6GdSb9o5XaT3Y8I9I9I9', '7HeTc0p6YbU4Z9J0J0J0', '8IfUd1q7ZcV5a0K1K1K1'
])

export async function deleteVoucher(voucherId) {
  if (!voucherId) return
  const voucherRef = doc(db, JOURNAL_COL, voucherId)

  const q = query(
    collection(db, 'accountingTransactions'),
    where('sourceType', '==', 'voucher'),
    where('sourceId', '==', voucherId)
  )
  const txSnap = await getDocs(q)
  const txDocsToDelete = txSnap.docs.filter((d) => !HISTORICAL_16_IDS.has(d.id))

  await runTransaction(db, async (t) => {
    t.delete(voucherRef)
    txDocsToDelete.forEach((d) => t.delete(d.ref))
  })
}

/**
 * القيود اليدوية والمستندات — عكس القيود المشتقّة، دي بتتخزّن فعلًا
 * لأنها مالهاش مستند أصلي تتولّد منه (رصيد افتتاحي، تسوية، مسحوبات…).
 */
export const VOUCHER_TYPES = ['manual', 'opening', 'drawing', 'payment', 'receipt', 'tax', 'transfer']

/** كل نوع مستند وشكل قيده الجاهز */
export const VOUCHER_SHAPES = {
  drawing: { debitRole: 'drawings', creditRole: 'cash' },
  tax: { debitRole: 'tax', creditRole: 'cash' },
  payment: { debitRole: 'otherExpense', creditRole: 'cash' },
  receipt: { debitRole: 'cash', creditRole: 'revenue' },
  transfer: { debitRole: 'cash', creditRole: 'cash' },
}

export async function nextVoucherNumber() {
  const year = new Date().getFullYear()
  const counterRef = doc(db, 'counters', `vouchers-${year}`)

  const sequence = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(counterRef)
    const current = snapshot.exists() ? Number(snapshot.data().seq ?? 0) : 0
    transaction.set(counterRef, { seq: current + 1, year }, { merge: true })
    return current + 1
  })

  return `JV-${year}-${String(sequence).padStart(4, '0')}`
}

export async function createVoucher({ date, type, description, lines, notes = '', uid }) {
  const number = await nextVoucherNumber()
  
  const formattedLines = lines
    .filter((entry) => entry.accountId && (toNumber(entry.debit) > 0 || toNumber(entry.credit) > 0))
    .map((entry) => ({
      accountId: entry.accountId,
      debit: round2(entry.debit),
      credit: round2(entry.credit),
      ...(entry.subLedgerId ? {
        subLedgerType: entry.subLedgerType || null,
        subLedgerId: entry.subLedgerId,
        subLedgerName: entry.subLedgerName || '',
      } : {}),
    }))

  if (formattedLines.length < 2) {
    throw new Error('يجب إدخال طرفين على الأقل للقيد (مدين ودائن).')
  }

  const totalDebit = formattedLines.reduce((sum, line) => sum + line.debit, 0)
  const totalCredit = formattedLines.reduce((sum, line) => sum + line.credit, 0)
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error('القيد غير متوازن: إجمالي المدين يجب أن يساوي إجمالي الدائن.')
  }

  const voucherRef = doc(collection(db, JOURNAL_COL))
  const txRef = doc(collection(db, 'accountingTransactions'))

  await runTransaction(db, async (t) => {
    t.set(voucherRef, {
      number,
      date,
      type,
      description,
      lines: formattedLines,
      notes,
      totalDebit,
      totalCredit,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    t.set(txRef, {
      idempotencyKey: `voucher:${voucherRef.id}:post`,
      transactionDate: date,
      sourceType: 'voucher',
      sourceId: voucherRef.id,
      action: 'manual',
      lines: formattedLines,
      totalDebit,
      totalCredit,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })
  })

  return voucherRef.id
}

export async function updateVoucher(voucherId, { date, type, description, lines, notes = '', uid }) {
  if (!voucherId) throw new Error('معرف السند مطلوب للتعديل.')

  const formattedLines = lines
    .filter((entry) => entry.accountId && (toNumber(entry.debit) > 0 || toNumber(entry.credit) > 0))
    .map((entry) => ({
      accountId: entry.accountId,
      debit: round2(entry.debit),
      credit: round2(entry.credit),
      ...(entry.subLedgerId
        ? {
            subLedgerType: entry.subLedgerType || null,
            subLedgerId: entry.subLedgerId,
            subLedgerName: entry.subLedgerName || '',
          }
        : {}),
    }))

  if (formattedLines.length < 2) {
    throw new Error('يجب إدخال طرفين على الأقل للقيد (مدين ودائن).')
  }

  const totalDebit = formattedLines.reduce((sum, line) => sum + line.debit, 0)
  const totalCredit = formattedLines.reduce((sum, line) => sum + line.credit, 0)
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error('القيد غير متوازن: إجمالي المدين يجب أن يساوي إجمالي الدائن.')
  }

  const voucherRef = doc(db, JOURNAL_COL, voucherId)

  const q = query(
    collection(db, 'accountingTransactions'),
    where('sourceType', '==', 'voucher'),
    where('sourceId', '==', voucherId),
  )
  const txSnap = await getDocs(q)
  const txDocs = txSnap.docs.filter((d) => !HISTORICAL_16_IDS.has(d.id))

  await runTransaction(db, async (t) => {
    t.update(voucherRef, {
      date,
      type,
      description,
      lines: formattedLines,
      notes,
      totalDebit,
      totalCredit,
      updatedBy: uid || null,
      updatedAt: serverTimestamp(),
    })

    if (txDocs.length > 0) {
      const primaryTx = txDocs[0]
      t.update(primaryTx.ref, {
        transactionDate: date,
        lines: formattedLines,
        totalDebit,
        totalCredit,
        updatedBy: uid || null,
        updatedAt: serverTimestamp(),
      })
      for (let i = 1; i < txDocs.length; i++) {
        t.delete(txDocs[i].ref)
      }
    } else {
      const newTxRef = doc(collection(db, 'accountingTransactions'))
      t.set(newTxRef, {
        idempotencyKey: `voucher:${voucherId}:post`,
        transactionDate: date,
        sourceType: 'voucher',
        sourceId: voucherId,
        action: 'manual',
        lines: formattedLines,
        totalDebit,
        totalCredit,
        createdBy: uid || null,
        createdAt: serverTimestamp(),
      })
    }
  })
}

export function voucherTotals(lines) {
  const debit = round2(lines.reduce((sum, entry) => sum + toNumber(entry.debit), 0))
  const credit = round2(lines.reduce((sum, entry) => sum + toNumber(entry.credit), 0))
  return { debit, credit, balanced: Math.abs(debit - credit) < 0.01 && debit > 0 }
}
