import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  where,
  deleteDoc,
  updateDoc,
} from 'firebase/firestore'
import { db } from './firebase'

function roundMoney(amount) {
  return Math.round((Number(amount || 0) + Number.EPSILON) * 100) / 100
}

async function resolveAccountByRole(role, optional = false) {
  const q = query(collection(db, 'accounts'), where('role', '==', role), limit(10))
  const snap = await getDocs(q)
  if (snap.empty) {
    if (optional) return null
    throw new Error(`الحساب المخصص لـ '${role}' غير موجود في شجرة الحسابات.`)
  }
  const activeDoc = snap.docs.find(
    (d) => !d.data().archived && d.data().active !== false && !d.data().isGroup,
  )
  if (!activeDoc) {
    if (optional) return null
    throw new Error(`حساب '${role}' معطل أو مؤرشف أو حساب رئيسي (مجموعة).`)
  }
  return { id: activeDoc.id, ...activeDoc.data() }
}

async function resolvePaymentMethodAccount(methodId) {
  if (!methodId) throw new Error('يرجى تحديد طريقة التحويل.')
  const methodDoc = await getDoc(doc(db, 'paymentMethods', methodId))
  if (!methodDoc.exists()) throw new Error('طريقة التحويل غير موجودة.')
  const mData = methodDoc.data()
  if (mData.archived || mData.active === false) throw new Error('طريقة التحويل معطلة أو مؤرشفة.')

  let treasuryAccount = null
  if (mData.accountId) {
    const acctDoc = await getDoc(doc(db, 'accounts', mData.accountId))
    if (acctDoc.exists() && !acctDoc.data().archived && acctDoc.data().active !== false && !acctDoc.data().isGroup) {
      treasuryAccount = { id: acctDoc.id, ...acctDoc.data() }
    }
  }

  if (!treasuryAccount && mData.accountNumber) {
    const acctSnap = await getDocs(query(collection(db, 'accounts'), where('code', '==', mData.accountNumber), limit(1)))
    if (!acctSnap.empty) {
      const d = acctSnap.docs[0]
      if (!d.data().archived && d.data().active !== false && !d.data().isGroup) {
        treasuryAccount = { id: d.id, ...d.data() }
      }
    }
  }

  if (!treasuryAccount && mData.type === 'cash') {
    treasuryAccount = await resolveAccountByRole('cash')
  }

  if (!treasuryAccount || treasuryAccount.isGroup) {
    throw new Error('طريقة التحويل غير مرتبطة بحساب فرعي صالح (تأكد أنها ليست حساب مجموعة رئيسي).')
  }
  return treasuryAccount
}

/**
 * 1. إنشاء فاتورة مع تحصيل مبدئي اختيارياً
 */
export async function createInvoiceClientSide({ values, number, payment, uid }) {
  const total = roundMoney(values.total || 0)
  const adBudget = roundMoney(values.adBudgetTotal || 0)
  const taxAmount = roundMoney(values.taxAmount || 0)
  const fees = roundMoney(total - adBudget - taxAmount)

  if (total <= 0) throw new Error('إجمالي الفاتورة يجب أن يكون أكبر من صفر.')
  if (fees < 0) throw new Error('تفاصيل الميزانية والضريبة تتجاوز إجمالي الفاتورة.')

  // PRE-FETCH ACCOUNTS USING getDocs (OUTSIDE TRANSACTION to prevent t.get(query) error)
  const receivableAcct = await resolveAccountByRole('receivable')
  const revenueAcct = await resolveAccountByRole('revenue')
  const adHeldAcct = await resolveAccountByRole('adBudgetHeld')
  const taxAcct = await resolveAccountByRole('tax')
  const adTreasuryAcct = await resolveAccountByRole('adTreasury', true)

  let treasuryAccount = null
  const paymentAmount = payment ? roundMoney(payment.amount) : 0
  if (payment && paymentAmount > 0) {
    treasuryAccount = await resolvePaymentMethodAccount(payment.methodId)
  }

  let createdInvoiceId = null

  await runTransaction(db, async (t) => {
    const invoiceRef = doc(collection(db, 'invoices'))
    createdInvoiceId = invoiceRef.id

    const lines = [
      {
        accountId: receivableAcct.id,
        debit: total,
        credit: 0,
        subLedgerType: 'client',
        subLedgerId: values.clientId,
        subLedgerName: values.clientName || '',
      },
    ]
    if (fees > 0) lines.push({ accountId: revenueAcct.id, debit: 0, credit: fees })
    if (adBudget > 0) lines.push({ accountId: adHeldAcct.id, debit: 0, credit: adBudget })
    if (taxAmount > 0) lines.push({ accountId: taxAcct.id, debit: 0, credit: taxAmount })

    const invoiceTxRef = doc(collection(db, 'accountingTransactions'))
    t.set(invoiceTxRef, {
      idempotencyKey: `invoice:${invoiceRef.id}:issue`,
      transactionDate: values.date,
      sourceType: 'invoice',
      sourceId: invoiceRef.id,
      action: 'create',
      lines,
      totalDebit: total,
      totalCredit: total,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    let paidAmount = 0
    if (payment && paymentAmount > 0 && treasuryAccount) {
      paidAmount = paymentAmount
      const paymentRef = doc(collection(db, 'invoices', invoiceRef.id, 'payments'))
      t.set(paymentRef, {
        ...payment,
        amount: paymentAmount,
        createdAt: serverTimestamp(),
        createdBy: uid || null,
      })

      const paymentTxRef = doc(collection(db, 'accountingTransactions'))

      const paymentLines = []
      if (adBudget > 0 && adTreasuryAcct && total > 0) {
        const adRatio = Math.min(1, Math.max(0, adBudget / total))
        const adPayment = roundMoney(paymentAmount * adRatio)
        const feesPayment = roundMoney(paymentAmount - adPayment)

        if (feesPayment > 0) {
          paymentLines.push({ accountId: treasuryAccount.id, debit: feesPayment, credit: 0 })
        }
        if (adPayment > 0) {
          paymentLines.push({ accountId: adTreasuryAcct.id, debit: adPayment, credit: 0 })
        }
      } else {
        paymentLines.push({ accountId: treasuryAccount.id, debit: paymentAmount, credit: 0 })
      }
      paymentLines.push({
        accountId: receivableAcct.id,
        debit: 0,
        credit: paymentAmount,
        subLedgerType: 'client',
        subLedgerId: values.clientId,
        subLedgerName: values.clientName || '',
      })

      t.set(paymentTxRef, {
        idempotencyKey: `payment:${paymentRef.id}:post`,
        transactionDate: payment.date || values.date,
        sourceType: 'payment',
        sourceId: paymentRef.id,
        action: 'payment',
        lines: paymentLines,
        totalDebit: paymentAmount,
        totalCredit: paymentAmount,
        createdBy: uid || null,
        createdAt: serverTimestamp(),
      })
    }

    t.set(invoiceRef, {
      ...values,
      number,
      total,
      adBudgetTotal: adBudget,
      taxAmount,
      paidAmount,
      createdAt: serverTimestamp(),
      createdBy: uid || null,
    })
  })

  return { success: true, invoiceId: createdInvoiceId }
}

/**
 * 2. إضافة دفعة تحصيل على فاتورة قائمة
 */
export async function createPaymentClientSide({ invoiceId, payment, uid }) {
  if (!invoiceId) throw new Error('رقم الفاتورة مطلوب.')
  const paymentAmount = roundMoney(payment.amount)
  if (paymentAmount <= 0) throw new Error('مبلغ الدفعة يجب أن يكون أكبر من صفر.')

  const receivableAcct = await resolveAccountByRole('receivable')
  const treasuryAccount = await resolvePaymentMethodAccount(payment.methodId)
  const adTreasuryAcct = await resolveAccountByRole('adTreasury', true)

  await runTransaction(db, async (t) => {
    const invoiceRef = doc(db, 'invoices', invoiceId)
    const invoiceDoc = await t.get(invoiceRef)
    if (!invoiceDoc.exists()) throw new Error('الفاتورة غير موجودة.')
    const invData = invoiceDoc.data()
    if (invData.cancelled) throw new Error('لا يمكن تسجيل دفعة على فاتورة ملغاة.')

    const total = roundMoney(invData.total || 0)
    const adBudget = roundMoney(invData.adBudgetTotal || 0)

    const paymentRef = doc(collection(db, 'invoices', invoiceId, 'payments'))
    t.set(paymentRef, {
      ...payment,
      amount: paymentAmount,
      createdAt: serverTimestamp(),
      createdBy: uid || null,
    })

    const paymentTxRef = doc(collection(db, 'accountingTransactions'))

    const paymentLines = []
    if (adBudget > 0 && adTreasuryAcct && total > 0) {
      const adRatio = Math.min(1, Math.max(0, adBudget / total))
      const adPayment = roundMoney(paymentAmount * adRatio)
      const feesPayment = roundMoney(paymentAmount - adPayment)

      if (feesPayment > 0) {
        paymentLines.push({ accountId: treasuryAccount.id, debit: feesPayment, credit: 0 })
      }
      if (adPayment > 0) {
        paymentLines.push({ accountId: adTreasuryAcct.id, debit: adPayment, credit: 0 })
      }
    } else {
      paymentLines.push({ accountId: treasuryAccount.id, debit: paymentAmount, credit: 0 })
    }
    paymentLines.push({
      accountId: receivableAcct.id,
      debit: 0,
      credit: paymentAmount,
      subLedgerType: 'client',
      subLedgerId: invData.clientId,
      subLedgerName: invData.clientName || '',
    })

    t.set(paymentTxRef, {
      idempotencyKey: `payment:${paymentRef.id}:post`,
      transactionDate: payment.date || invData.date,
      sourceType: 'payment',
      sourceId: paymentRef.id,
      action: 'payment',
      lines: paymentLines,
      totalDebit: paymentAmount,
      totalCredit: paymentAmount,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    const currentPaid = roundMoney(invData.paidAmount || 0)
    t.update(invoiceRef, { paidAmount: roundMoney(currentPaid + paymentAmount) })
  })

  return { success: true }
}

/**
 * 3. حذف أو استرجاع دفعة تحصيل
 */
export async function reversePaymentClientSide({ invoiceId, paymentId, uid }) {
  if (!invoiceId || !paymentId) throw new Error('رقم الفاتورة ورمز الدفعة مطلوبان.')

  const ptxSnap = await getDocs(
    query(
      collection(db, 'accountingTransactions'),
      where('sourceType', '==', 'payment'),
      where('sourceId', '==', paymentId)
    )
  )

  await runTransaction(db, async (t) => {
    const invoiceRef = doc(db, 'invoices', invoiceId)
    const invoiceDoc = await t.get(invoiceRef)
    if (!invoiceDoc.exists()) throw new Error('الفاتورة غير موجودة.')
    const invData = invoiceDoc.data()

    const paymentRef = doc(db, 'invoices', invoiceId, 'payments', paymentId)
    const paymentDoc = await t.get(paymentRef)
    if (!paymentDoc.exists()) throw new Error('الدفعة غير موجودة.')
    const payData = paymentDoc.data()

    const paymentAmount = roundMoney(payData.amount)
    t.delete(paymentRef)

    for (const ptxDoc of ptxSnap.docs) {
      t.delete(ptxDoc.ref)
    }

    const currentPaid = roundMoney(invData.paidAmount || 0)
    t.update(invoiceRef, { paidAmount: Math.max(0, roundMoney(currentPaid - paymentAmount)) })
  })

  return { success: true }
}

/**
 * 4. تعديل فاتورة قائمة
 */
export async function editInvoiceClientSide({ invoiceId, values, uid }) {
  if (!invoiceId) throw new Error('رقم الفاتورة مطلوب.')

  const receivableAcct = await resolveAccountByRole('receivable')
  const revenueAcct = await resolveAccountByRole('revenue')
  const adHeldAcct = await resolveAccountByRole('adBudgetHeld')
  const taxAcct = await resolveAccountByRole('tax')

  const invTxSnap = await getDocs(
    query(
      collection(db, 'accountingTransactions'),
      where('sourceType', '==', 'invoice'),
      where('sourceId', '==', invoiceId)
    )
  )

  await runTransaction(db, async (t) => {
    const invoiceRef = doc(db, 'invoices', invoiceId)
    const invoiceDoc = await t.get(invoiceRef)
    if (!invoiceDoc.exists()) throw new Error('الفاتورة غير موجودة.')
    const invData = invoiceDoc.data()
    if (invData.cancelled) throw new Error('لا يمكن تعديل فاتورة ملغاة.')

    const total = roundMoney(values.total || 0)
    const adBudget = roundMoney(values.adBudgetTotal || 0)
    const taxAmount = roundMoney(values.taxAmount || 0)
    const fees = roundMoney(total - adBudget - taxAmount)

    const lines = [
      {
        accountId: receivableAcct.id,
        debit: total,
        credit: 0,
        subLedgerType: 'client',
        subLedgerId: values.clientId || invData.clientId,
        subLedgerName: values.clientName || invData.clientName || '',
      },
    ]
    if (fees > 0) lines.push({ accountId: revenueAcct.id, debit: 0, credit: fees })
    if (adBudget > 0) lines.push({ accountId: adHeldAcct.id, debit: 0, credit: adBudget })
    if (taxAmount > 0) lines.push({ accountId: taxAcct.id, debit: 0, credit: taxAmount })

    if (!invTxSnap.empty) {
      for (const txDoc of invTxSnap.docs) {
        t.update(txDoc.ref, {
          transactionDate: values.date || invData.date,
          lines,
          totalDebit: total,
          totalCredit: total,
          updatedAt: serverTimestamp(),
          updatedBy: uid || null,
        })
      }
    } else {
      const invoiceTxRef = doc(collection(db, 'accountingTransactions'))
      t.set(invoiceTxRef, {
        idempotencyKey: `invoice:${invoiceId}:issue`,
        transactionDate: values.date || invData.date,
        sourceType: 'invoice',
        sourceId: invoiceId,
        action: 'create',
        lines,
        totalDebit: total,
        totalCredit: total,
        createdBy: uid || null,
        createdAt: serverTimestamp(),
      })
    }

    t.update(invoiceRef, {
      ...values,
      total,
      adBudgetTotal: adBudget,
      taxAmount,
      updatedAt: serverTimestamp(),
      updatedBy: uid || null,
    })
  })

  return { success: true }
}

/**
 * 5. إلغاء فاتورة
 */
export async function cancelInvoiceClientSide({ invoiceId, cancelReason, cancelledDate, uid }) {
  if (!invoiceId) throw new Error('رقم الفاتورة مطلوب.')

  // Fetch linked jobCosts (commissions, etc.) to delete them on cancellation
  const jcSnap = await getDocs(
    query(collection(db, 'jobCosts'), where('invoiceId', '==', invoiceId))
  )

  await runTransaction(db, async (t) => {
    const invoiceRef = doc(db, 'invoices', invoiceId)
    const invoiceDoc = await t.get(invoiceRef)
    if (!invoiceDoc.exists()) throw new Error('الفاتورة غير موجودة.')
    const invData = invoiceDoc.data()
    if (invData.cancelled) throw new Error('الفاتورة ملغاة بالفعل.')

    t.update(invoiceRef, {
      cancelled: true,
      cancelReason: cancelReason || '',
      cancelledAt: serverTimestamp(),
      cancelledBy: uid || null,
    })

    // Delete any commissions/jobCosts tied to this cancelled invoice
    for (const jcDoc of jcSnap.docs) {
      t.delete(jcDoc.ref)
    }
  })

  return { success: true }
}

const HISTORICAL_16_IDS = new Set([
  '2uS8F6J1O5B1GhohH4ro', '67RbXL0PD0RzURi1934e', '6Z3NTtnTi1prGTQ535n5', '6aZgG4yyrdDH77OBSY2t',
  '7YwJt0f6O1K4P9Z0Z0Z0', '8XvKt1g7P2L5Q0A1A1A1', '9ZwLu2h8Q3M6R1B2B2B2', '0AxMv3i9R4N7S2C3C3C3',
  '1ByNw4j0S5O8T3D4D4D4', '2CzOx5k1T6P9U4E5E5E5', '3DaPy6l2U7Q0V5F6F6F6', '4EbQz7m3V8R1W6G7G7G7',
  '5FcRa8n4W9S2X7H8H8H8', '6GdSb9o5XaT3Y8I9I9I9', '7HeTc0p6YbU4Z9J0J0J0', '8IfUd1q7ZcV5a0K1K1K1',
  'HFLkgARsTVKOPLXGTbEy', 'JXSPfObARcs7awTK3wQz', 'OKVSYaCXZfwZ0P3xhe2T', 'SZkFmpoe9dlSE23i6RXx',
  'VLiORWyIyAINi1VPt4X3', 'WnT0OptIDOG71t9DbCS8', 'daoF8czEZQfqBsaMYtl2', 'enoqZvcHDmYrYMA6e3aR',
  'fhyRAXOfjFxUCHCzAmaR', 'j9NqRl5zPOhoHxeC8VGF', 'mLUnAkGR7jsKMrnN885l', 'yUOW89xDtPnpFIJ5sERO'
])

/**
 * 6. حذف فاتورة نهائياً وتصفية كل القيود والدفعات المرتبطة بها
 */
export async function deleteInvoiceClientSide({ invoiceId, uid }) {
  if (!invoiceId) throw new Error('رقم الفاتورة مطلوب.')

  // Fetch invoice doc to check for linked campaign
  const invoiceRef = doc(db, 'invoices', invoiceId)
  const invoiceDoc = await getDoc(invoiceRef)
  const invData = invoiceDoc.exists() ? invoiceDoc.data() : null

  // 1. Fetch payments subcollection
  const paymentsSnap = await getDocs(collection(db, 'invoices', invoiceId, 'payments'))
  const paymentIds = paymentsSnap.docs.map((d) => d.id)

  // 2. Fetch accounting transactions for invoice by sourceType and sourceId
  const invTxSnap = await getDocs(
    query(
      collection(db, 'accountingTransactions'),
      where('sourceType', '==', 'invoice'),
      where('sourceId', '==', invoiceId)
    )
  )

  // 3. Fetch accounting transactions for payments
  let payTxDocs = []
  for (const pId of paymentIds) {
    const ptxSnap = await getDocs(
      query(
        collection(db, 'accountingTransactions'),
        where('sourceType', '==', 'payment'),
        where('sourceId', '==', pId)
      )
    )
    payTxDocs.push(...ptxSnap.docs)
  }

  // Verify historical transaction protection
  const allTxDocs = [...invTxSnap.docs, ...payTxDocs]
  const protectedTx = allTxDocs.find((d) => HISTORICAL_16_IDS.has(d.id))
  if (protectedTx) {
    throw new Error('لا يمكن حذف الفاتورة لأن القيد المحاسبي المرتبط بها جزء من السجلات التاريخية المجمّدة.')
  }

  // 4. Fetch job costs
  const jcSnap = await getDocs(
    query(collection(db, 'jobCosts'), where('invoiceId', '==', invoiceId))
  )

  // 5. Fetch supplierPayables linked to this invoiceId
  const spSnap = await getDocs(
    query(collection(db, 'supplierPayables'), where('invoiceId', '==', invoiceId))
  )

  let vendorPayableAcct = null
  let defaultCostAcct = null
  if (!spSnap.empty) {
    vendorPayableAcct = await resolveAccountByRole('vendorPayable')
    defaultCostAcct = await resolveAccountByRole('costOther')
  }

  // 6. Fetch linked campaigns to clear invoiceId
  const campaignDocs = []
  if (invData?.campaignId) {
    const campDoc = await getDoc(doc(db, 'campaigns', invData.campaignId))
    if (campDoc.exists()) campaignDocs.push(campDoc)
  }
  const campSnap = await getDocs(
    query(collection(db, 'campaigns'), where('invoiceId', '==', invoiceId))
  )
  for (const cd of campSnap.docs) {
    if (!campaignDocs.some((c) => c.id === cd.id)) campaignDocs.push(cd)
  }

  // Execute deletion in transaction
  await runTransaction(db, async (t) => {
    for (const spDoc of spSnap.docs) {
      const freshSp = await t.get(spDoc.ref)
      if (!freshSp.exists()) continue
      const spData = freshSp.data()

      if (spData.status === 'partially_paid') {
        throw new Error(`لا يمكن حذف الفاتورة لوجود مستحقات مورد (${spData.supplierName || 'مورد'}) مسددة جزئياً. يجب إلغاء/عكس السداد أولاً.`)
      }
      if (spData.status === 'paid') {
        throw new Error(`لا يمكن حذف الفاتورة لوجود مستحقات مورد (${spData.supplierName || 'مورد'}) مسددة بالكامل. يجب إلغاء/عكس السداد أولاً.`)
      }
      if (spData.status === 'reconciled') {
        const piId = spData.reconciledWithInvoiceId
        if (piId) {
          const piRef = doc(db, 'purchaseInvoices', piId)
          const piDoc = await t.get(piRef)
          if (piDoc.exists() && !piDoc.data().cancelled) {
            throw new Error(`لا يمكن حذف الفاتورة لأن مستحقات المورد (${spData.supplierName || 'مورد'}) مسواة بالفعل مع فاتورة شراء قائمة (${piDoc.data().number || 'فاتورة شراء'}). يجب إلغاء/حذف فاتورة الشراء أولاً.`)
          }
        } else {
          throw new Error(`لا يمكن حذف الفاتورة لأن مستحقات المورد (${spData.supplierName || 'مورد'}) مسواة بالفعل مع فاتورة شراء أخرى.`)
        }
      }
      if (spData.status === 'approved') {
        const amount = roundMoney(spData.approvedCost)
        if (amount > 0 && vendorPayableAcct) {
          const revTxRef = doc(collection(db, 'accountingTransactions'))
          t.set(revTxRef, {
            idempotencyKey: `invoice_item_cost:${invoiceId}:${spData.itemId}:reverse_on_delete:${spDoc.id}`,
            transactionDate: new Date().toISOString().split('T')[0],
            sourceType: 'invoice_item_cost',
            sourceId: `${invoiceId}:${spData.itemId}`,
            action: 'reverse_cost',
            lines: [
              {
                accountId: vendorPayableAcct.id,
                debit: amount,
                credit: 0,
                subLedgerType: 'vendor',
                subLedgerId: spData.supplierId,
                subLedgerName: spData.supplierName || '',
              },
              {
                accountId: spData.costAccountId || defaultCostAcct.id,
                debit: 0,
                credit: amount,
              },
            ],
            totalDebit: amount,
            totalCredit: amount,
            createdBy: uid || null,
            createdAt: serverTimestamp(),
          })

          t.update(spDoc.ref, {
            status: 'cancelled',
            reversalTransactionId: revTxRef.id,
            cancelledAt: serverTimestamp(),
            cancelReason: 'حذف الفاتورة التابعة',
          })
        }
      }
    }

    for (const pDoc of paymentsSnap.docs) {
      t.delete(pDoc.ref)
    }
    for (const txDoc of invTxSnap.docs) {
      if (!HISTORICAL_16_IDS.has(txDoc.id)) {
        t.delete(txDoc.ref)
      }
    }
    for (const ptxDoc of payTxDocs) {
      if (!HISTORICAL_16_IDS.has(ptxDoc.id)) {
        t.delete(ptxDoc.ref)
      }
    }
    for (const jcDoc of jcSnap.docs) {
      t.delete(jcDoc.ref)
    }
    for (const cDoc of campaignDocs) {
      t.update(cDoc.ref, { invoiceId: null })
    }
    t.delete(doc(db, 'invoices', invoiceId))
  })

  return { success: true }
}

/**
 * 7. استرجاع فاتورة ملغاة
 */
export async function restoreInvoiceClientSide({ invoiceId, uid }) {
  if (!invoiceId) throw new Error('رقم الفاتورة مطلوب.')
  await updateDoc(doc(db, 'invoices', invoiceId), {
    cancelled: false,
    cancelReason: '',
    restoredAt: serverTimestamp(),
    restoredBy: uid || null,
  })
  return { success: true }
}
