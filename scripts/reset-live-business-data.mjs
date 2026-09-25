import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  writeBatch
} from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyCb1BmZI6H7rw4fPO72yNJBQHtsfpzwr8M',
  authDomain: 'iyora-eg.firebaseapp.com',
  projectId: 'iyora-eg',
  storageBucket: 'iyora-eg.firebasestorage.app',
  messagingSenderId: '1064818599797',
  appId: '1:1064818599797:web:90b4742b1a38763dcd953c'
}

const argv = process.argv.slice(2)
const getArg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const EMAIL = getArg('email') || process.env.IYORA_EMAIL || 'admin@iyora.app'
const PASSWORD = getArg('password') || process.env.IYORA_PASSWORD || 'admin123456'

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

const OPERATIONAL_COLLECTIONS = [
  'invoices',
  'purchaseInvoices',
  'purchaseReturns',
  'supplierCreditNotes',
  'vendorAdvances',
  'vendorPayments',
  'vendorAdvanceApplications',
  'accountingTransactions',
  'journalEntries',
  'clients',
  'employees',
  'employeeEntries',
  'employeeDeductions',
  'employeeAllowances',
  'attendance',
  'attendanceSettings',
  'payroll',
  'payrollRuns',
  'payrollItems',
  'vendors',
  'supplierPayables',
  'assets',
  'assetUsage',
  'jobCosts',
  'expenses',
  'quotations',
  'retainers',
  'campaigns',
  'maintenance',
  'counters'
]

async function deleteInBatches(querySnapshot) {
  let count = 0
  const docs = querySnapshot.docs
  while (docs.length > 0) {
    const batch = writeBatch(db)
    const chunk = docs.splice(0, 450)
    for (const d of chunk) {
      batch.delete(d.ref)
    }
    await batch.commit()
    count += chunk.length
  }
  return count
}

async function main() {
  console.log(`\n========================================`)
  console.log(`⚠️  بدء مسح وتصفير كافة البيانات التشغيلية والتجارية (iyora-eg)`)
  console.log(`========================================\n`)

  console.log(`🔐 تسجيل الدخول بحساب: ${EMAIL}...`)
  const cred = await signInWithEmailAndPassword(auth, EMAIL, PASSWORD)
  console.log(`✓ تم تسجيل الدخول بنجاح للمستخدم: ${cred.user.uid}`)

  const deletionSummary = {}

  // 1. Delete Subcollections
  console.log(`\n1️⃣ جاري فحص ومسح المجموعات الفرعية (Subcollections)...`)
  for (const subcol of ['payments', 'applications']) {
    try {
      const snap = await getDocs(collectionGroup(db, subcol))
      if (!snap.empty) {
        const deleted = await deleteInBatches(snap)
        deletionSummary[`subcollection: ${subcol}`] = deleted
        console.log(`  ✓ تم حذف ${deleted} مستند من ${subcol}`)
      } else {
        deletionSummary[`subcollection: ${subcol}`] = 0
      }
    } catch (e) {
      console.warn(`  ⚠️ تعذر فحص ${subcol}: ${e.message}`)
    }
  }

  // 2. Delete Operational Collections
  console.log(`\n2️⃣ جاري مسح المجموعات التشغيلية والمالية...`)
  for (const colName of OPERATIONAL_COLLECTIONS) {
    try {
      const snap = await getDocs(collection(db, colName))
      if (!snap.empty) {
        const deleted = await deleteInBatches(snap)
        deletionSummary[colName] = deleted
        console.log(`  ✓ تم حذف ${deleted} مستند من ${colName}`)
      } else {
        deletionSummary[colName] = 0
      }
    } catch (e) {
      console.error(`  ❌ خطأ أثناء مسح ${colName}:`, e.message)
    }
  }

  console.log(`\n========================================`)
  console.log(`✅ ملخص عملية التصفير والمسح:`)
  console.log(`========================================`)
  console.table(deletionSummary)

  console.log(`\n🔒 تم الحفاظ على:`)
  console.log(`  - حسابات المستخدمين (users)`)
  console.log(`  - شجرة الحسابات المحاسبية الكاملة (accounts)`)
  console.log(`  - طرق الدفع والبنوك والخزينة (paymentMethods)`)
  console.log(`  - إعدادات النظام والشركة (settings)`)
  console.log(`  - التصنيفات الثابتة وقوائم الخدمات (services, categories, specialties)`)

  console.log(`\n🎉 اكتمل التصفير بنجاح! الموقع الآن جاهز تماماً للبدء من جديد.`)
  process.exit(0)
}

main().catch((err) => {
  console.error('\n❌ خطأ غير متوقع أثناء المسح:', err)
  process.exit(1)
})
