import fs from 'fs'
import path from 'path'
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { collection, collectionGroup, getDocs, getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyCb1BmZI6H7rw4fPO72yNJBQHtsfpzwr8M',
  authDomain: 'iyora-eg.firebaseapp.com',
  projectId: 'iyora-eg',
  storageBucket: 'iyora-eg.firebasestorage.app',
  messagingSenderId: '1064818599797',
  appId: '1:1064818599797:web:90b4742b1a38763dcd953c'
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

async function auditAllOrphans() {
  console.log('🔐 تسجيل الدخول...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول.\n')

  console.log('📡 جاري جلب كافة السجلات من قاعدة البيانات للفحص الشامل...')

  // Fetch all existing master documents
  const [
    invSnap,
    paySnap,
    piSnap,
    prSnap,
    vaSnap,
    jcSnap,
    jeSnap,
    txSnap,
    clientSnap
  ] = await Promise.all([
    getDocs(collection(db, 'invoices')),
    getDocs(collectionGroup(db, 'payments')),
    getDocs(collection(db, 'purchaseInvoices')),
    getDocs(collection(db, 'purchaseReturns')),
    getDocs(collection(db, 'vendorAdvances')),
    getDocs(collection(db, 'jobCosts')),
    getDocs(collection(db, 'journalEntries')),
    getDocs(collection(db, 'accountingTransactions')),
    getDocs(collection(db, 'clients'))
  ])

  const existingInvoices = new Set(invSnap.docs.map(d => d.id))
  const existingPayments = new Set(paySnap.docs.map(d => d.id))
  const existingPurchaseInvoices = new Set(piSnap.docs.map(d => d.id))
  const existingPurchaseReturns = new Set(prSnap.docs.map(d => d.id))
  const existingVendorAdvances = new Set(vaSnap.docs.map(d => d.id))
  const existingJobCosts = new Set(jcSnap.docs.map(d => d.id))
  const existingVouchers = new Set(jeSnap.docs.map(d => d.id))
  const existingClients = new Set(clientSnap.docs.map(d => d.id))

  console.log(`- فواتير مبيعات: ${existingInvoices.size}`)
  console.log(`- دفعات فواتير: ${existingPayments.size}`)
  console.log(`- فواتير مشتريات: ${existingPurchaseInvoices.size}`)
  console.log(`- سندات قيد ويومية: ${existingVouchers.size}`)
  console.log(`- حركات محاسبية إجمالية: ${txSnap.size}\n`)

  const orphanedTransactions = []

  txSnap.docs.forEach(docSnap => {
    const tx = docSnap.data()
    const txId = docSnap.id
    const srcType = tx.sourceType
    const srcId = tx.sourceId

    let isOrphan = false
    let reason = ''

    if (srcType === 'invoice') {
      if (!existingInvoices.has(srcId)) {
        isOrphan = true
        reason = `فاتورة المبيعات (${srcId}) غير موجودة في جدول الفواتير (محذوفة).`
      }
    } else if (srcType === 'payment') {
      if (!existingPayments.has(srcId)) {
        isOrphan = true
        reason = `سند الدفع/القبض (${srcId}) غير موجود في أي فاتورة مبيعات (الفاتورة محذوفة).`
      }
    } else if (srcType === 'purchaseInvoice') {
      if (!existingPurchaseInvoices.has(srcId)) {
        isOrphan = true
        reason = `فاتورة المشتريات (${srcId}) غير موجودة (محذوفة).`
      }
    } else if (srcType === 'purchaseReturn') {
      if (!existingPurchaseReturns.has(srcId)) {
        isOrphan = true
        reason = `مردود المشتريات (${srcId}) غير موجود.`
      }
    } else if (srcType === 'vendorAdvance') {
      if (!existingVendorAdvances.has(srcId)) {
        isOrphan = true
        reason = `دفعة المورد المقدمة (${srcId}) غير موجودة.`
      }
    } else if (srcType === 'voucher') {
      if (!existingVouchers.has(srcId)) {
        isOrphan = true
        reason = `سند القيد (${srcId}) غير موجود في جدول القيود (محذوف).`
      }
    } else if (srcType === 'jobCost') {
      if (!existingJobCosts.has(srcId)) {
        isOrphan = true
        reason = `تكلفة المشروع (${srcId}) غير موجودة.`
      }
    }

    if (isOrphan) {
      orphanedTransactions.push({
        txId,
        date: tx.transactionDate || tx.date,
        sourceType: srcType,
        sourceId: srcId,
        amount: tx.totalDebit,
        lines: tx.lines,
        reason
      })
    }
  })

  console.log(`========================================`)
  console.log(`⚠️ عدد الحركات المحاسبية المقطوعة / بدون مستند أصل: ${orphanedTransactions.length}`)
  console.log(`========================================`)

  orphanedTransactions.forEach((o, i) => {
    console.log(`\n[${i + 1}] المعاملة ID: ${o.txId}`)
    console.log(`     التاريخ: ${o.date} | المبلغ: ${o.amount} ج.م | النوع: ${o.sourceType}`)
    console.log(`     السبب: ${o.reason}`)
    if (o.lines) {
      o.lines.forEach(l => {
        console.log(`       -> حساب: ${l.accountName || l.accountId} | مدين: ${l.debit || 0} | دائن: ${l.credit || 0}`)
      })
    }
  })
}

auditAllOrphans().catch(console.error)
