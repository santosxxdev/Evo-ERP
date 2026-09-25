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
} from 'firebase/firestore'
import { db } from './firebase'

function roundMoney(amount) {
  return Math.round((Number(amount || 0) + Number.EPSILON) * 100) / 100
}

async function resolveAccountByRole(role) {
  const q = query(collection(db, 'accounts'), where('role', '==', role), limit(10))
  const snap = await getDocs(q)
  if (snap.empty) throw new Error(`الحساب المخصص لـ '${role}' غير موجود في شجرة الحسابات.`)
  const activeDoc = snap.docs.find(
    (d) => !d.data().archived && d.data().active !== false && !d.data().isGroup,
  )
  if (!activeDoc) throw new Error(`حساب '${role}' معطل أو مؤرشف أو حساب رئيسي.`)
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
    throw new Error('طريقة التحويل غير مرتبطة بحساب فرعي صالح.')
  }
  return treasuryAccount
}

/** 1. فاتورة مشتريات */
export async function createPurchaseInvoiceClientSide({ payload, uid }) {
  const { vendorId, number, date, targetAccountId, subtotal, taxAmount, total, notes, payment, linkedPayableId } = payload
  const finalSubtotal = roundMoney(subtotal)
  const finalTax = roundMoney(taxAmount)
  const finalTotal = roundMoney(total)

  const vendorPayableAcct = await resolveAccountByRole('vendorPayable')
  
  let targetAccount = null
  if (targetAccountId) {
    const tDoc = await getDoc(doc(db, 'accounts', targetAccountId))
    if (tDoc.exists() && !tDoc.data().archived && !tDoc.data().isGroup) {
      targetAccount = { id: tDoc.id, ...tDoc.data() }
    }
  }
  if (!targetAccount) targetAccount = await resolveAccountByRole('costOther')

  let taxAcct = null
  if (finalTax > 0) taxAcct = await resolveAccountByRole('taxReceivable')

  let treasuryAccount = null
  const paymentAmount = payment ? roundMoney(payment.amount) : 0
  if (payment && paymentAmount > 0) {
    treasuryAccount = await resolvePaymentMethodAccount(payment.methodId)
  }

  let createdId = null
  await runTransaction(db, async (t) => {
    let linkedSpData = null
    let spRef = null
    if (linkedPayableId) {
      spRef = doc(db, 'supplierPayables', linkedPayableId)
      const spDoc = await t.get(spRef)
      if (!spDoc.exists()) throw new Error('مستند المستحقات المراد تسويته غير موجود.')
      linkedSpData = spDoc.data()
      if (linkedSpData.status === 'cancelled') throw new Error('لا يمكن تسوية مستحقات ملغاة.')
      if (linkedSpData.status === 'reconciled') throw new Error('هذه المستحقات مسواة بالفعل مع فاتورة شراء أخرى.')
      if (linkedSpData.status === 'paid') throw new Error('لا يمكن تسوية مستحقات تم سدادها بالكامل.')
      if (linkedSpData.supplierId && linkedSpData.supplierId !== vendorId) {
        throw new Error('المستحقات المحددة لا تخص هذا المورد.')
      }
    }

    const piRef = doc(collection(db, 'purchaseInvoices'))
    createdId = piRef.id

    const lines = [
      { accountId: targetAccount.id, debit: finalSubtotal, credit: 0 },
      {
        accountId: vendorPayableAcct.id,
        debit: 0,
        credit: finalTotal,
        subLedgerType: 'vendor',
        subLedgerId: vendorId,
        subLedgerName: payload.vendorName || '',
      },
    ]
    if (finalTax > 0 && taxAcct) {
      lines.push({ accountId: taxAcct.id, debit: finalTax, credit: 0 })
    }

    const txRef = doc(collection(db, 'accountingTransactions'))
    t.set(txRef, {
      idempotencyKey: `purchaseInvoice:${piRef.id}:create`,
      transactionDate: date,
      sourceType: 'purchaseInvoice',
      sourceId: piRef.id,
      action: 'create',
      lines,
      totalDebit: finalTotal,
      totalCredit: finalTotal,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    if (linkedSpData && spRef) {
      const approvedCost = roundMoney(linkedSpData.approvedCost)
      const costAccountId = linkedSpData.costAccountId || targetAccount.id
      const reconTxRef = doc(collection(db, 'accountingTransactions'))
      t.set(reconTxRef, {
        idempotencyKey: `purchaseInvoice:${piRef.id}:reconcile:${linkedPayableId}`,
        transactionDate: date,
        sourceType: 'purchaseInvoice',
        sourceId: piRef.id,
        action: 'reconcile_payable',
        lines: [
          {
            accountId: vendorPayableAcct.id,
            debit: approvedCost,
            credit: 0,
            subLedgerType: 'vendor',
            subLedgerId: vendorId,
            subLedgerName: linkedSpData.supplierName || '',
          },
          { accountId: costAccountId, debit: 0, credit: approvedCost },
        ],
        totalDebit: approvedCost,
        totalCredit: approvedCost,
        createdBy: uid || null,
        createdAt: serverTimestamp(),
      })

      t.update(spRef, {
        status: 'reconciled',
        reconciledWithInvoiceId: piRef.id,
        reconciledAt: serverTimestamp(),
        reconciliationTransactionId: reconTxRef.id,
      })

      if (linkedSpData.invoiceId && linkedSpData.itemId) {
        const invRef = doc(db, 'invoices', linkedSpData.invoiceId)
        const invDoc = await t.get(invRef)
        if (invDoc.exists()) {
          const items = invDoc.data().items || []
          const updatedItems = items.map((item) => {
            if (item.id === linkedSpData.itemId || item.payableId === linkedPayableId) {
              return {
                ...item,
                costStatus: 'reconciled',
                purchaseInvoiceId: piRef.id,
              }
            }
            return item
          })
          t.update(invRef, { items: updatedItems })
        }
      }
    }

    let initialPaidAmount = linkedSpData ? roundMoney(linkedSpData.paidAmount || 0) : 0
    if (payment && paymentAmount > 0 && treasuryAccount) {
      initialPaidAmount = roundMoney(initialPaidAmount + paymentAmount)
      const vpRef = doc(collection(db, 'vendorPayments'))
      t.set(vpRef, {
        vendorId,
        purchaseInvoiceId: piRef.id,
        amount: paymentAmount,
        date: payment.date || date,
        methodId: payment.methodId,
        methodName: payment.methodName || '',
        notes: payment.notes || '',
        createdBy: uid || null,
        createdAt: serverTimestamp(),
      })

      const payTxRef = doc(collection(db, 'accountingTransactions'))
      t.set(payTxRef, {
        idempotencyKey: `vendorPayment:${vpRef.id}:post`,
        transactionDate: payment.date || date,
        sourceType: 'vendorPayment',
        sourceId: vpRef.id,
        action: 'payment',
        lines: [
          {
            accountId: vendorPayableAcct.id,
            debit: paymentAmount,
            credit: 0,
            subLedgerType: 'vendor',
            subLedgerId: vendorId,
          },
          { accountId: treasuryAccount.id, debit: 0, credit: paymentAmount },
        ],
        totalDebit: paymentAmount,
        totalCredit: paymentAmount,
        createdBy: uid || null,
        createdAt: serverTimestamp(),
      })
    }

    t.set(piRef, {
      vendorId,
      number,
      date,
      targetAccountId: targetAccount.id,
      subtotal: finalSubtotal,
      taxAmount: finalTax,
      total: finalTotal,
      paidAmount: initialPaidAmount,
      linkedPayableId: linkedPayableId || null,
      notes: notes || '',
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })
  })

  return { success: true, purchaseInvoiceId: createdId }
}

/** 2. سداد للمورد */
export async function createVendorPaymentClientSide({ payload, uid }) {
  const { vendorId, purchaseInvoiceId, amount, date, methodId, notes } = payload
  const paymentAmount = roundMoney(amount)
  if (paymentAmount <= 0) throw new Error('مبلغ السداد يجب أن يكون أكبر من صفر.')

  const vendorPayableAcct = await resolveAccountByRole('vendorPayable')
  const treasuryAccount = await resolvePaymentMethodAccount(methodId)

  let createdId = null
  await runTransaction(db, async (t) => {
    const vpRef = doc(collection(db, 'vendorPayments'))
    createdId = vpRef.id

    t.set(vpRef, {
      vendorId,
      purchaseInvoiceId: purchaseInvoiceId || null,
      amount: paymentAmount,
      date,
      methodId,
      notes: notes || '',
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    const txRef = doc(collection(db, 'accountingTransactions'))
    t.set(txRef, {
      idempotencyKey: `vendorPayment:${vpRef.id}:post`,
      transactionDate: date,
      sourceType: 'vendorPayment',
      sourceId: vpRef.id,
      action: 'payment',
      lines: [
        {
          accountId: vendorPayableAcct.id,
          debit: paymentAmount,
          credit: 0,
          subLedgerType: 'vendor',
          subLedgerId: vendorId,
        },
        { accountId: treasuryAccount.id, debit: 0, credit: paymentAmount },
      ],
      totalDebit: paymentAmount,
      totalCredit: paymentAmount,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    if (purchaseInvoiceId) {
      const piRef = doc(db, 'purchaseInvoices', purchaseInvoiceId)
      const piDoc = await t.get(piRef)
      if (piDoc.exists()) {
        const curPaid = roundMoney(piDoc.data().paidAmount || 0)
        t.update(piRef, { paidAmount: roundMoney(curPaid + paymentAmount) })
      }
    }
  })

  return { success: true, vendorPaymentId: createdId }
}

/** 3. دفعة مقدمة للمورد */
export async function createVendorAdvanceClientSide({ payload, uid }) {
  const { vendorId, amount, date, methodId, notes } = payload
  const advAmount = roundMoney(amount)
  if (advAmount <= 0) throw new Error('مبلغ الدفعة المقدمة يجب أن يكون أكبر من صفر.')

  const vendorAdvanceAcct = await resolveAccountByRole('vendorAdvance')
  const treasuryAccount = await resolvePaymentMethodAccount(methodId)

  let createdId = null
  await runTransaction(db, async (t) => {
    const vaRef = doc(collection(db, 'vendorAdvances'))
    createdId = vaRef.id

    t.set(vaRef, {
      vendorId,
      amount: advAmount,
      unappliedAmount: advAmount,
      date,
      methodId,
      notes: notes || '',
      status: 'active',
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    const txRef = doc(collection(db, 'accountingTransactions'))
    t.set(txRef, {
      idempotencyKey: `vendorAdvance:${vaRef.id}:create`,
      transactionDate: date,
      sourceType: 'vendorAdvance',
      sourceId: vaRef.id,
      action: 'advance',
      lines: [
        {
          accountId: vendorAdvanceAcct.id,
          debit: advAmount,
          credit: 0,
          subLedgerType: 'vendor',
          subLedgerId: vendorId,
        },
        { accountId: treasuryAccount.id, debit: 0, credit: advAmount },
      ],
      totalDebit: advAmount,
      totalCredit: advAmount,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })
  })

  return { success: true, vendorAdvanceId: createdId }
}

/** 4. مردودات مشتريات */
export async function createPurchaseReturnClientSide({ payload, uid }) {
  const { vendorId, purchaseInvoiceId, number, date, subtotal, taxAmount, total, notes } = payload
  const finalSubtotal = roundMoney(subtotal)
  const finalTax = roundMoney(taxAmount)
  const finalTotal = roundMoney(total)

  const vendorPayableAcct = await resolveAccountByRole('vendorPayable')
  const targetAccount = await resolveAccountByRole('costOther')

  let createdId = null
  await runTransaction(db, async (t) => {
    const prRef = doc(collection(db, 'purchaseReturns'))
    createdId = prRef.id

    const lines = [
      {
        accountId: vendorPayableAcct.id,
        debit: finalTotal,
        credit: 0,
        subLedgerType: 'vendor',
        subLedgerId: vendorId,
      },
      { accountId: targetAccount.id, debit: 0, credit: finalSubtotal },
    ]

    const txRef = doc(collection(db, 'accountingTransactions'))
    t.set(txRef, {
      idempotencyKey: `purchaseReturn:${prRef.id}:create`,
      transactionDate: date,
      sourceType: 'purchaseReturn',
      sourceId: prRef.id,
      action: 'return',
      lines,
      totalDebit: finalTotal,
      totalCredit: finalTotal,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    t.set(prRef, {
      vendorId,
      purchaseInvoiceId: purchaseInvoiceId || null,
      number,
      date,
      subtotal: finalSubtotal,
      taxAmount: finalTax,
      total: finalTotal,
      notes: notes || '',
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })
  })

  return { success: true, purchaseReturnId: createdId }
}

/** 5. إلغاء فاتورة مشتريات */
export async function cancelPurchaseInvoiceClientSide({ purchaseInvoiceId, uid }) {
  await runTransaction(db, async (t) => {
    const piRef = doc(db, 'purchaseInvoices', purchaseInvoiceId)
    const piDoc = await t.get(piRef)
    if (!piDoc.exists()) throw new Error('فاتورة الشراء غير موجودة.')
    if (piDoc.data().cancelled) throw new Error('الفاتورة ملغاة بالفعل.')

    t.update(piRef, {
      cancelled: true,
      cancelledAt: serverTimestamp(),
      cancelledBy: uid || null,
    })
  })
  return { success: true }
}

/** 6. إشعار دائن للمورد (Supplier Credit Note) */
export async function createSupplierCreditNoteClientSide({ payload, uid }) {
  return createPurchaseReturnClientSide({
    payload: {
      ...payload,
      number: `CN-${Date.now().toString().slice(-6)}`,
    },
    uid,
  })
}

/** 7. تسوية دفعة مقدمة مع فاتورة مشتريات */
export async function applyVendorAdvanceClientSide({ payload, uid }) {
  const { advanceId, purchaseInvoiceId, amount, applyDate } = payload
  const applyAmount = roundMoney(amount)
  if (applyAmount <= 0) throw new Error('مبلغ التسوية يجب أن يكون أكبر من صفر.')

  const vendorPayableAcct = await resolveAccountByRole('vendorPayable')
  const vendorAdvanceAcct = await resolveAccountByRole('vendorAdvance')

  await runTransaction(db, async (t) => {
    const advRef = doc(db, 'vendorAdvances', advanceId)
    const advDoc = await t.get(advRef)
    if (!advDoc.exists()) throw new Error('الدفعة المقدمة غير موجودة.')
    const advData = advDoc.data()
    const curUnapplied = roundMoney(advData.unappliedAmount || 0)
    if (applyAmount > curUnapplied + 0.01) {
      throw new Error(`مبلغ التسوية (${applyAmount}) يتجاوز المتبقي من الدفعة المقدمة (${curUnapplied}).`)
    }

    const piRef = doc(db, 'purchaseInvoices', purchaseInvoiceId)
    const piDoc = await t.get(piRef)
    if (!piDoc.exists()) throw new Error('فاتورة الشراء غير موجودة.')

    const applyRef = doc(collection(db, 'vendorAdvanceApplications'))
    t.set(applyRef, {
      advanceId,
      purchaseInvoiceId,
      amount: applyAmount,
      date: applyDate || new Date().toISOString().split('T')[0],
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    const txRef = doc(collection(db, 'accountingTransactions'))
    t.set(txRef, {
      idempotencyKey: `vendorAdvanceApp:${applyRef.id}:apply`,
      transactionDate: applyDate || new Date().toISOString().split('T')[0],
      sourceType: 'vendorAdvanceApp',
      sourceId: applyRef.id,
      action: 'apply',
      lines: [
        {
          accountId: vendorPayableAcct.id,
          debit: applyAmount,
          credit: 0,
          subLedgerType: 'vendor',
          subLedgerId: advData.vendorId,
        },
        {
          accountId: vendorAdvanceAcct.id,
          debit: 0,
          credit: applyAmount,
          subLedgerType: 'vendor',
          subLedgerId: advData.vendorId,
        },
      ],
      totalDebit: applyAmount,
      totalCredit: applyAmount,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    const newUnapplied = roundMoney(curUnapplied - applyAmount)
    t.update(advRef, {
      unappliedAmount: newUnapplied,
      status: newUnapplied <= 0 ? 'applied' : 'active',
    })

    const curPaid = roundMoney(piDoc.data().paidAmount || 0)
    t.update(piRef, {
      paidAmount: roundMoney(curPaid + applyAmount),
    })
  })

  return { success: true }
}

/** 8. إعتماد تكلفة مورد على بند فاتورة (Approve Invoice Item Supplier Cost) */
export async function approveSupplierCostClientSide({ payload, uid }) {
  const {
    invoiceId,
    itemId,
    supplierId,
    supplierName,
    expectedCost = 0,
    approvedCost,
    costAccountId,
    approvedDate,
    notes,
  } = payload

  const approvedAmount = roundMoney(approvedCost)
  if (approvedAmount <= 0) throw new Error('المبلغ المعتمد للتكلفة يجب أن يكون أكبر من صفر.')
  if (!supplierId) throw new Error('يرجى اختيار المورد / الفريلانسر المستحق.')
  if (!invoiceId || !itemId) throw new Error('بيانات الفاتورة والبند غير مكتملة.')

  const vendorPayableAcct = await resolveAccountByRole('vendorPayable')

  let costAccount = null
  if (costAccountId) {
    const cDoc = await getDoc(doc(db, 'accounts', costAccountId))
    if (cDoc.exists() && !cDoc.data().archived && !cDoc.data().isGroup) {
      costAccount = { id: cDoc.id, ...cDoc.data() }
    }
  }
  if (!costAccount) costAccount = await resolveAccountByRole('costOther')

  const payableId = `sp-${invoiceId}-${itemId}`
  const approveIdempotencyKey = `invoice_item_cost:${invoiceId}:${itemId}:approve:v1`

  let createdTxId = null

  await runTransaction(db, async (t) => {
    // 1. فحص وجود القيد بمانع التكرار الجذري
    const existingTxQuery = query(
      collection(db, 'accountingTransactions'),
      where('idempotencyKey', '==', approveIdempotencyKey),
      limit(1)
    )
    const existingTxSnap = await getDocs(existingTxQuery)
    if (!existingTxSnap.empty) {
      createdTxId = existingTxSnap.docs[0].id
      return
    }

    // 2. فحص المستند في supplierPayables
    const spRef = doc(db, 'supplierPayables', payableId)
    const spDoc = await t.get(spRef)
    if (spDoc.exists() && spDoc.data().status !== 'draft' && spDoc.data().status !== 'cancelled') {
      createdTxId = spDoc.data().accountingTransactionId
      return
    }

    // 3. إنشاء قيد استحقاق المورد في اليومية
    const txRef = doc(collection(db, 'accountingTransactions'))
    createdTxId = txRef.id

    const dateStr = approvedDate || new Date().toISOString().split('T')[0]

    t.set(txRef, {
      idempotencyKey: approveIdempotencyKey,
      transactionDate: dateStr,
      sourceType: 'invoice_item_cost',
      sourceId: `${invoiceId}:${itemId}`,
      action: 'approve_cost',
      lines: [
        { accountId: costAccount.id, debit: approvedAmount, credit: 0 },
        {
          accountId: vendorPayableAcct.id,
          debit: 0,
          credit: approvedAmount,
          subLedgerType: 'vendor',
          subLedgerId: supplierId,
          subLedgerName: supplierName || '',
        },
      ],
      totalDebit: approvedAmount,
      totalCredit: approvedAmount,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    // 4. حفظ المستند في supplierPayables (المصدر الحقيقي لمديونية المورد)
    t.set(spRef, {
      invoiceId,
      itemId,
      supplierId,
      supplierName: supplierName || '',
      expectedCost: roundMoney(expectedCost),
      approvedCost: approvedAmount,
      costAccountId: costAccount.id,
      status: 'approved',
      paidAmount: 0,
      accountingTransactionId: txRef.id,
      reversalTransactionId: null,
      adjustmentHistory: [],
      notes: notes || '',
      createdAt: serverTimestamp(),
      approvedAt: dateStr,
      approvedBy: uid || null,
      sourceType: 'invoice_item_cost',
      sourceId: `${invoiceId}:${itemId}`,
      idempotencyKey: approveIdempotencyKey,
    })

    // 5. تحديث لقطة ملخص البند على الفاتورة (invoices)
    const invRef = doc(db, 'invoices', invoiceId)
    const invDoc = await t.get(invRef)
    if (invDoc.exists()) {
      const items = invDoc.data().items || []
      const updatedItems = items.map((item) => {
        if (item.id === itemId || (!item.id && item.name === payload.name)) {
          return {
            ...item,
            id: item.id || itemId,
            supplierId,
            supplierName: supplierName || item.supplierName || '',
            expectedCost: roundMoney(expectedCost || item.expectedCost || 0),
            approvedCost: approvedAmount,
            costStatus: 'approved',
            costAccountId: costAccount.id,
            payableId,
            payableTransactionId: txRef.id,
          }
        }
        return item
      })
      t.update(invRef, { items: updatedItems })
    }
  })

  return { success: true, payableId, transactionId: createdTxId }
}

/** 9. تعديل تكلفة معتمدة لمورد (Adjust Approved Cost) */
export async function adjustSupplierCostClientSide({ payload, uid }) {
  const { invoiceId, itemId, newApprovedCost, date, notes } = payload
  const newAmount = roundMoney(newApprovedCost)
  if (newAmount <= 0) throw new Error('المبلغ المعدل يجب أن يكون أكبر من صفر.')

  const payableId = `sp-${invoiceId}-${itemId}`
  const vendorPayableAcct = await resolveAccountByRole('vendorPayable')

  await runTransaction(db, async (t) => {
    const spRef = doc(db, 'supplierPayables', payableId)
    const spDoc = await t.get(spRef)
    if (!spDoc.exists()) throw new Error('مستند مستحقات المورد غير موجود.')
    const spData = spDoc.data()

    if (spData.status === 'cancelled') throw new Error('لا يمكن تعديل تكلفة ملغاة.')

    const oldAmount = roundMoney(spData.approvedCost)
    const delta = roundMoney(newAmount - oldAmount)
    if (Math.abs(delta) < 0.01) return

    const adjustmentId = `adj-${Date.now()}`
    const idempotencyKey = `invoice_item_cost:${invoiceId}:${itemId}:adjust:${adjustmentId}`

    const costAccountId = spData.costAccountId
    const supplierId = spData.supplierId
    const supplierName = spData.supplierName

    const txRef = doc(collection(db, 'accountingTransactions'))
    const dateStr = date || new Date().toISOString().split('T')[0]

    const absDelta = Math.abs(delta)
    const lines = delta > 0
      ? [
          { accountId: costAccountId, debit: absDelta, credit: 0 },
          { accountId: vendorPayableAcct.id, debit: 0, credit: absDelta, subLedgerType: 'vendor', subLedgerId: supplierId, subLedgerName: supplierName },
        ]
      : [
          { accountId: vendorPayableAcct.id, debit: absDelta, credit: 0, subLedgerType: 'vendor', subLedgerId: supplierId, subLedgerName: supplierName },
          { accountId: costAccountId, debit: 0, credit: absDelta },
        ]

    t.set(txRef, {
      idempotencyKey,
      transactionDate: dateStr,
      sourceType: 'invoice_item_cost',
      sourceId: `${invoiceId}:${itemId}`,
      action: 'adjust_cost',
      lines,
      totalDebit: absDelta,
      totalCredit: absDelta,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    const history = spData.adjustmentHistory || []
    history.push({
      adjustmentId,
      previousAmount: oldAmount,
      newAmount,
      delta,
      transactionId: txRef.id,
      adjustedAt: dateStr,
      adjustedBy: uid || null,
    })

    t.update(spRef, {
      approvedCost: newAmount,
      adjustmentHistory: history,
    })

    const invRef = doc(db, 'invoices', invoiceId)
    const invDoc = await t.get(invRef)
    if (invDoc.exists()) {
      const items = invDoc.data().items || []
      const updatedItems = items.map((item) => {
        if (item.id === itemId || item.payableId === payableId) {
          return {
            ...item,
            approvedCost: newAmount,
          }
        }
        return item
      })
      t.update(invRef, { items: updatedItems })
    }
  })

  return { success: true }
}

/** 10. إلغاء/عكس تكلفة مورد معتمدة (Reverse Approved Cost) */
export async function reverseSupplierCostClientSide({ payload, uid }) {
  const { invoiceId, itemId, reason, date } = payload
  const payableId = `sp-${invoiceId}-${itemId}`
  const vendorPayableAcct = await resolveAccountByRole('vendorPayable')

  await runTransaction(db, async (t) => {
    const spRef = doc(db, 'supplierPayables', payableId)
    const spDoc = await t.get(spRef)
    if (!spDoc.exists()) throw new Error('مستند مستحقات المورد غير موجود.')
    const spData = spDoc.data()

    if (spData.status === 'cancelled') throw new Error('التكلفة ملغاة بالفعل.')
    if (roundMoney(spData.paidAmount) > 0) {
      throw new Error('لا يمكن إلغاء تكلفة مورد تم سداد جزء منها، يرجى عكس السداد أولاً.')
    }

    const reversalId = `rev-${Date.now()}`
    const idempotencyKey = `invoice_item_cost:${invoiceId}:${itemId}:reverse:${reversalId}`
    const amount = roundMoney(spData.approvedCost)

    const revTxRef = doc(collection(db, 'accountingTransactions'))
    const dateStr = date || new Date().toISOString().split('T')[0]

    t.set(revTxRef, {
      idempotencyKey,
      transactionDate: dateStr,
      sourceType: 'invoice_item_cost',
      sourceId: `${invoiceId}:${itemId}`,
      action: 'reverse_cost',
      lines: [
        { accountId: vendorPayableAcct.id, debit: amount, credit: 0, subLedgerType: 'vendor', subLedgerId: spData.supplierId, subLedgerName: spData.supplierName },
        { accountId: spData.costAccountId, debit: 0, credit: amount },
      ],
      totalDebit: amount,
      totalCredit: amount,
      createdBy: uid || null,
      createdAt: serverTimestamp(),
    })

    t.update(spRef, {
      status: 'cancelled',
      reversalTransactionId: revTxRef.id,
      cancelledAt: dateStr,
      cancelledBy: uid || null,
      cancelReason: reason || '',
    })

    const invRef = doc(db, 'invoices', invoiceId)
    const invDoc = await t.get(invRef)
    if (invDoc.exists()) {
      const items = invDoc.data().items || []
      const updatedItems = items.map((item) => {
        if (item.id === itemId || item.payableId === payableId) {
          return {
            ...item,
            costStatus: 'cancelled',
          }
        }
        return item
      })
      t.update(invRef, { items: updatedItems })
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

/** 11. حذف فاتورة مشتريات نهائياً مع تصفية القيود المرتبطة والحفاظ على السجلات التاريخية */
export async function deletePurchaseInvoiceClientSide({ purchaseInvoiceId, uid }) {
  if (!purchaseInvoiceId) throw new Error('رقم فاتورة الشراء مطلوب.')

  const piRef = doc(db, 'purchaseInvoices', purchaseInvoiceId)
  const piDoc = await getDoc(piRef)

  // 1. Fetch accounting transactions for purchase invoice
  const piTxSnap = await getDocs(
    query(
      collection(db, 'accountingTransactions'),
      where('sourceType', '==', 'purchaseInvoice'),
      where('sourceId', '==', purchaseInvoiceId)
    )
  )

  // 2. Fetch vendor payments linked to purchase invoice
  const vpSnap = await getDocs(
    query(
      collection(db, 'vendorPayments'),
      where('purchaseInvoiceId', '==', purchaseInvoiceId)
    )
  )
  const vpIds = vpSnap.docs.map((d) => d.id)

  // 3. Fetch accounting transactions for vendor payments
  let vpTxDocs = []
  for (const vpId of vpIds) {
    const vptxSnap = await getDocs(
      query(
        collection(db, 'accountingTransactions'),
        where('sourceType', '==', 'vendorPayment'),
        where('sourceId', '==', vpId)
      )
    )
    vpTxDocs.push(...vptxSnap.docs)
  }

  // 4. Verify protection for historical 16 IDs
  const allTxDocs = [...piTxSnap.docs, ...vpTxDocs]
  const protectedTx = allTxDocs.find((d) => HISTORICAL_16_IDS.has(d.id))
  if (protectedTx) {
    throw new Error('لا يمكن حذف فاتورة الشراء لأن القيد المحاسبي المرتبط بها جزء من السجلات التاريخية المجمّدة.')
  }

  // Idempotent execution
  await runTransaction(db, async (t) => {
    for (const vpDoc of vpSnap.docs) {
      t.delete(vpDoc.ref)
    }
    for (const txDoc of piTxSnap.docs) {
      if (!HISTORICAL_16_IDS.has(txDoc.id)) {
        t.delete(txDoc.ref)
      }
    }
    for (const vptxDoc of vpTxDocs) {
      if (!HISTORICAL_16_IDS.has(vptxDoc.id)) {
        t.delete(vptxDoc.ref)
      }
    }
    if (piDoc.exists()) {
      t.delete(piRef)
    }
  })

  return { success: true }
}


