import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { collection, collectionGroup, deleteDoc, doc, getDocs, getFirestore, writeBatch } from 'firebase/firestore'

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

async function cleanOrphans() {
  console.log('========================================')
  console.log('🧹 تنظيف ومسح كافة الحركات المحاسبية المقطوعة/المعلقة')
  console.log('========================================\n')

  console.log('🔐 تسجيل الدخول بحساب المدير admin@iyora.app...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول بنجاح.\n')

  console.log('📡 جاري جلب السجلات المعتمدة للتحقق من الروابط...')
  const [
    invSnap,
    paySnap,
    piSnap,
    prSnap,
    vaSnap,
    jcSnap,
    jeSnap,
    txSnap
  ] = await Promise.all([
    getDocs(collection(db, 'invoices')),
    getDocs(collectionGroup(db, 'payments')),
    getDocs(collection(db, 'purchaseInvoices')),
    getDocs(collection(db, 'purchaseReturns')),
    getDocs(collection(db, 'vendorAdvances')),
    getDocs(collection(db, 'jobCosts')),
    getDocs(collection(db, 'journalEntries')),
    getDocs(collection(db, 'accountingTransactions'))
  ])

  const existingInvoices = new Set(invSnap.docs.map(d => d.id))
  const existingPayments = new Set(paySnap.docs.map(d => d.id))
  const existingPurchaseInvoices = new Set(piSnap.docs.map(d => d.id))
  const existingPurchaseReturns = new Set(prSnap.docs.map(d => d.id))
  const existingVendorAdvances = new Set(vaSnap.docs.map(d => d.id))
  const existingJobCosts = new Set(jcSnap.docs.map(d => d.id))
  const existingVouchers = new Set(jeSnap.docs.map(d => d.id))

  const toDelete = []

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
        reason = `فاتورة مبيعات محذوفة (${srcId})`
      }
    } else if (srcType === 'payment') {
      if (!existingPayments.has(srcId)) {
        isOrphan = true
        reason = `دفعة قبض غير مربوطة بفاتورة قائمة (${srcId})`
      }
    } else if (srcType === 'purchaseInvoice') {
      if (!existingPurchaseInvoices.has(srcId)) {
        isOrphan = true
        reason = `فاتورة مشتريات محذوفة (${srcId})`
      }
    } else if (srcType === 'purchaseReturn') {
      if (!existingPurchaseReturns.has(srcId)) {
        isOrphan = true
        reason = `مردود مشتريات محذوف (${srcId})`
      }
    } else if (srcType === 'vendorAdvance') {
      if (!existingVendorAdvances.has(srcId)) {
        isOrphan = true
        reason = `دفعة مورد مقدمة محذوفة (${srcId})`
      }
    } else if (srcType === 'voucher') {
      if (!existingVouchers.has(srcId)) {
        isOrphan = true
        reason = `سند قيد محذوف (${srcId})`
      }
    } else if (srcType === 'jobCost') {
      if (!existingJobCosts.has(srcId)) {
        isOrphan = true
        reason = `تكلفة مشروع محذوفة (${srcId})`
      }
    }

    if (isOrphan) {
      toDelete.push({
        id: txId,
        date: tx.transactionDate || tx.date,
        type: srcType,
        amount: tx.totalDebit,
        reason
      })
    }
  })

  console.log(`🔎 تم العثور على ${toDelete.length} حركة محاسبية معلقة/مقطوعة يجب حذفها:`)
  toDelete.forEach((item, idx) => {
    console.log(`  [${idx + 1}] ID: ${item.id} | التاريخ: ${item.date} | المبلغ: ${item.amount} ج.م | السبب: ${item.reason}`)
  })

  if (toDelete.length === 0) {
    console.log('\n✨ النظام نظيف تماماً بالفعل، لا توجد حركات معلقة!')
    return
  }

  console.log(`\n🗑️ جاري حذف الـ ${toDelete.length} حركة الآن...`)
  const batch = writeBatch(db)
  toDelete.forEach(item => {
    batch.delete(doc(db, 'accountingTransactions', item.id))
  })
  await batch.commit()

  console.log(`✅ تم حذف جميع الحركات المعلقة بنجاح!`)

  // Verification
  const remainingSnap = await getDocs(collection(db, 'accountingTransactions'))
  console.log(`\n📊 إجمالي الحركات المحاسبية المتبقية والمربوطة 100%: ${remainingSnap.size} حركة.`)
}

cleanOrphans().catch(console.error)
