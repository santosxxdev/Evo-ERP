import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  Timestamp,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  setDoc,
  writeBatch
} from 'firebase/firestore'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

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

// Use the latest complete backup directory
const backupDir = path.join(rootDir, 'backups', 'backup-2026-09-23T07-38-25-145Z')

function convertTimestamps(val) {
  if (val === null || val === undefined) return val
  if (
    typeof val === 'object' &&
    val.type === 'firestore/timestamp/1.0' &&
    typeof val.seconds === 'number'
  ) {
    return new Timestamp(val.seconds, val.nanoseconds || 0)
  }
  if (Array.isArray(val)) {
    return val.map(convertTimestamps)
  }
  if (typeof val === 'object' && !(val instanceof Timestamp)) {
    const res = {}
    for (const [k, v] of Object.entries(val)) {
      res[k] = convertTimestamps(v)
    }
    return res
  }
  return val
}

async function runRestore() {
  console.log('==================================================')
  console.log('🚀 بدء استعادة النسخة الاحتياطية الكاملة إلى iyora-eg')
  console.log(`📁 مسار النسخة: ${backupDir}`)
  console.log('==================================================\n')

  console.log('🔐 تسجيل الدخول بحساب المدير admin@iyora.app...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول بنجاح.\n')

  const restoreFiles = [
    { file: 'accounts.json', col: 'accounts' },
    { file: 'clients.json', col: 'clients' },
    { file: 'employees.json', col: 'employees' },
    { file: 'employeeTypes.json', col: 'employeeTypes' },
    { file: 'vendors.json', col: 'vendors', unarchive: true },
    { file: 'vendorSpecialties.json', col: 'vendorSpecialties' },
    { file: 'services.json', col: 'services' },
    { file: 'serviceCategories.json', col: 'serviceCategories' },
    { file: 'jobCosts.json', col: 'jobCosts' },
    { file: 'expenseCategories.json', col: 'expenseCategories' },
    { file: 'assetCategories.json', col: 'assetCategories' },
    { file: 'assetLocations.json', col: 'assetLocations' },
    { file: 'campaigns.json', col: 'campaigns' },
    { file: 'paymentMethods.json', col: 'paymentMethods' },
    { file: 'purchaseInvoices.json', col: 'purchaseInvoices' },
    { file: 'purchaseReturns.json', col: 'purchaseReturns' },
    { file: 'vendorAdvances.json', col: 'vendorAdvances' },
    { file: 'journalEntries.json', col: 'journalEntries' },
    { file: 'accountingTransactions.json', col: 'accountingTransactions' },
    { file: 'counters.json', col: 'counters' },
    { file: 'settings.json', col: 'settings' }
  ]

  const summary = {}

  for (const item of restoreFiles) {
    const filePath = path.join(backupDir, item.file)
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠️ تخطي ${item.file} (غير موجود)`)
      continue
    }

    const records = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    console.log(`📥 جاري استعادة "${item.col}" (${records.length} مستند)...`)

    // Write in batches of 350
    const chunks = []
    let current = []
    for (const r of records) {
      current.push(r)
      if (current.length >= 350) {
        chunks.push(current)
        current = []
      }
    }
    if (current.length > 0) chunks.push(current)

    for (const chunk of chunks) {
      const batch = writeBatch(db)
      for (const rec of chunk) {
        const { _id, _applications, ...data } = rec

        // If unarchive option is enabled (e.g. for vendors so they are active)
        if (item.unarchive && data.archived === true) {
          data.archived = false
        }

        const cleanData = convertTimestamps(data)
        const ref = doc(db, item.col, _id)
        batch.set(ref, cleanData, { merge: true })

        // Check for subcollections in vendorAdvances
        if (item.col === 'vendorAdvances' && _applications && Array.isArray(_applications)) {
          for (const appDoc of _applications) {
            const { _id: appId, ...appData } = appDoc
            batch.set(doc(db, 'vendorAdvances', _id, 'applications', appId), convertTimestamps(appData), { merge: true })
          }
        }
      }
      await batch.commit()
    }
    summary[item.col] = records.length
  }

  // Restore Invoices with Payments Subcollection
  const invPath = path.join(backupDir, 'invoices.json')
  if (fs.existsSync(invPath)) {
    const invoices = JSON.parse(fs.readFileSync(invPath, 'utf8'))
    console.log(`🧾 جاري استعادة "invoices" (${invoices.length} فاتورة مع مدفوعاتها)...`)

    let totalPaymentsRestored = 0
    for (const inv of invoices) {
      const { _id, _payments, ...invData } = inv
      const cleanData = convertTimestamps(invData)
      await setDoc(doc(db, 'invoices', _id), cleanData, { merge: true })

      if (_payments && Array.isArray(_payments) && _payments.length > 0) {
        for (const p of _payments) {
          const { _id: payId, ...payData } = p
          const cleanPay = convertTimestamps(payData)
          await setDoc(doc(db, 'invoices', _id, 'payments', payId), cleanPay, { merge: true })
          totalPaymentsRestored++
        }
      }
    }
    summary['invoices'] = invoices.length
    summary['payments (subcollection)'] = totalPaymentsRestored
  }

  console.log('\n==================================================')
  console.log('🎉 اكتملت الاستعادة بنجاح! ملخص المستندات المستعادة:')
  console.log('==================================================')
  console.table(summary)

  console.log('\n🔍 التحقق النهائي من قاعدة البيانات المباشرة:')
  const verifyCols = [
    'invoices',
    'clients',
    'employees',
    'vendors',
    'jobCosts',
    'accountingTransactions',
    'journalEntries',
    'accounts'
  ]
  for (const c of verifyCols) {
    const snap = await getDocs(collection(db, c))
    console.log(`  ✓ ${c}: ${snap.size} مستند`)
  }
}

runRestore().catch(err => {
  console.error('\n❌ خطأ أثناء الاستعادة:', err)
  process.exit(1)
})
