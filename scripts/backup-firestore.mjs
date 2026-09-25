/**
 * Backup Script for Firestore (iyora-eg)
 * Supports:
 *   1) Service Account JSON (serviceAccountKey.json in root or path passed via --key)
 *   2) Admin Email & Password (--email xxx --password yyy)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const getArg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const keyPath = getArg('key') || path.join(rootDir, 'serviceAccountKey.json')
const email = getArg('email') || process.env.IYORA_EMAIL
const password = getArg('password') || process.env.IYORA_PASSWORD

const KNOWN_COLLECTIONS = [
  'users',
  'clients',
  'invoices',
  'quotations',
  'campaigns',
  'retainers',
  'services',
  'serviceCategories',
  'activityTypes',
  'vendors',
  'vendorSpecialties',
  'supplierPayables',
  'vendorPayments',
  'vendorAdvances',
  'vendorAdvanceApplications',
  'purchaseInvoices',
  'purchaseReturns',
  'supplierCreditNotes',
  'employees',
  'employeeTypes',
  'departments',
  'positions',
  'employeeEntries',
  'employeeDeductions',
  'employeeAllowances',
  'payroll',
  'payrollRuns',
  'payrollItems',
  'attendance',
  'attendanceSettings',
  'salesPeriods',
  'paymentMethods',
  'jobCosts',
  'expenses',
  'expenseCategories',
  'assets',
  'assetCategories',
  'assetLocations',
  'assetUsage',
  'maintenance',
  'accounts',
  'accountingTransactions',
  'journalEntries',
  'counters',
  'settings'
]

async function runBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(rootDir, 'backups', `backup-${timestamp}`)
  fs.mkdirSync(backupDir, { recursive: true })

  console.log(`\n========================================`)
  console.log(`🚀 بدء سحب النسخة الاحتياطية من Firestore (iyora-eg)`)
  console.log(`📁 مجلد الحفظ: ${backupDir}`)
  console.log(`========================================\n`)

  let db = null

  // 1. Check if Service Account JSON exists
  if (fs.existsSync(keyPath)) {
    console.log(`🔑 تم العثور على مفتاح الخدمة (Service Account): ${keyPath}`)
    const { initializeApp, cert, getApps } = await import('firebase-admin/app')
    const { getFirestore } = await import('firebase-admin/firestore')
    
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'))
    if (!getApps().length) {
      initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || 'iyora-eg'
      })
    }
    const adminDb = getFirestore()

    // Query collections via Admin SDK
    console.log(`📡 جاري الاتصال عبر Admin SDK...`)
    
    // Discover all root collections dynamically
    let collectionsToPull = KNOWN_COLLECTIONS
    try {
      const remoteCols = await adminDb.listCollections()
      const remoteColIds = remoteCols.map(c => c.id)
      collectionsToPull = Array.from(new Set([...KNOWN_COLLECTIONS, ...remoteColIds]))
      console.log(`📋 تم اكتشاف ${remoteColIds.length} كولكشن في قاعدة البيانات: [${remoteColIds.join(', ')}]`)
    } catch (e) {
      console.log(`⚠️ تعذر جلب قائمة الكولكشنز ديناميكياً، سيتم استخدام القائمة المعيارية (${e.message})`)
    }

    const summary = {}

    for (const colName of collectionsToPull) {
      try {
        const snap = await adminDb.collection(colName).get()
        if (snap.empty) {
          continue
        }
        console.log(`📥 كولكشن "${colName}": جاري حفظ ${snap.size} مستند...`)
        const docs = []
        snap.forEach(doc => {
          docs.push({
            _id: doc.id,
            ...doc.data()
          })
        })
        fs.writeFileSync(
          path.join(backupDir, `${colName}.json`),
          JSON.stringify(docs, null, 2),
          'utf8'
        )
        summary[colName] = snap.size
      } catch (err) {
        console.error(`❌ خطأ أثناء سحب ${colName}:`, err.message)
      }
    }

    fs.writeFileSync(
      path.join(backupDir, `_summary.json`),
      JSON.stringify({ timestamp, mode: 'service-account', summary }, null, 2),
      'utf8'
    )

    console.log(`\n✅ اكتملت النسخة الاحتياطية بنجاح!`)
    console.table(summary)
    return
  }

  // 2. Fallback to Client SDK with email/password
  if (email && password) {
    console.log(`👤 جاري تسجيل الدخول بالحساب: ${email}`)
    const { initializeApp } = await import('firebase/app')
    const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth')
    const { getFirestore, collection, getDocs } = await import('firebase/firestore')

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
    await signInWithEmailAndPassword(auth, email, password)
    console.log(`🔓 تم تسجيل الدخول بنجاح!`)

    const clientDb = getFirestore(app)
    const summary = {}

    for (const colName of KNOWN_COLLECTIONS) {
      try {
        const snap = await getDocs(collection(clientDb, colName))
        if (snap.empty) {
          continue
        }
        console.log(`📥 كولكشن "${colName}": جاري حفظ ${snap.size} مستند...`)
        const docs = []
        for (const d of snap.docs) {
          const docData = {
            _id: d.id,
            ...d.data()
          }

          // Check subcollections for invoices
          if (colName === 'invoices') {
            try {
              const paySnap = await getDocs(collection(clientDb, 'invoices', d.id, 'payments'))
              if (!paySnap.empty) {
                docData._payments = paySnap.docs.map(p => ({ _id: p.id, ...p.data() }))
              }
            } catch (e) {
              // ignore
            }
          }

          // Check subcollections for vendorAdvances
          if (colName === 'vendorAdvances') {
            try {
              const appSnap = await getDocs(collection(clientDb, 'vendorAdvances', d.id, 'applications'))
              if (!appSnap.empty) {
                docData._applications = appSnap.docs.map(a => ({ _id: a.id, ...a.data() }))
              }
            } catch (e) {
              // ignore
            }
          }

          docs.push(docData)
        }

        fs.writeFileSync(
          path.join(backupDir, `${colName}.json`),
          JSON.stringify(docs, null, 2),
          'utf8'
        )
        summary[colName] = snap.size
      } catch (err) {
        console.error(`⚠️ تعذر سحب ${colName}:`, err.message)
      }
    }

    fs.writeFileSync(
      path.join(backupDir, `_summary.json`),
      JSON.stringify({ timestamp, mode: 'auth-user', email, summary }, null, 2),
      'utf8'
    )

    console.log(`\n✅ اكتملت النسخة الاحتياطية بنجاح!`)
    console.table(summary)
    return
  }

  console.error(`\n❌ لم يتم العثور على وسيلة مصادقة!`)
  console.log(`يرجى إما:`)
  console.log(`1) وضع ملف serviceAccountKey.json في المجلد الرئيسي ${rootDir}`)
  console.log(`2) أو تشغيل السكربت مع الإيميل والباسورد:`)
  console.log(`   node scripts/backup-firestore.mjs --email your-email@domain.com --password your-pass\n`)
}

runBackup().catch(err => {
  console.error('Fatal backup error:', err)
  process.exit(1)
})
