import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { initializeApp } from 'firebase/app'
import {
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword
} from 'firebase/auth'
import {
  Timestamp,
  collection,
  doc,
  getFirestore,
  writeBatch
} from 'firebase/firestore'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const iyoraHelpConfig = {
  apiKey: 'AIzaSyDVQx2fSTQw8qDqJVQfrxJwcAjRhaDmuVw',
  authDomain: 'iyora-help.firebaseapp.com',
  projectId: 'iyora-help',
  storageBucket: 'iyora-help.firebasestorage.app',
  messagingSenderId: '377101352404',
  appId: '1:377101352404:web:13f48483d107fc12b26a41',
  measurementId: 'G-7N94M60RZM'
}

const app = initializeApp(iyoraHelpConfig, 'IYORA_HELP')
const auth = getAuth(app)
const db = getFirestore(app)

const backupDir = path.join(rootDir, 'backups', 'backup-2026-09-24T11-57-42-079Z')

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

const USERS_TO_SETUP = [
  {
    username: 'admin',
    email: 'admin@iyora.app',
    password: 'admin123456',
    name: 'كريم عبدالناصر',
    role: 'admin',
    active: true
  },
  {
    username: 'kareem',
    email: 'kareem@iyora.app',
    password: 'admin123456',
    name: 'kareem7',
    role: 'admin',
    active: true
  },
  {
    username: 'nabil_1235',
    email: 'nabil_1235@iyora.app',
    password: 'admin123456',
    name: 'mr.nabil',
    role: 'admin',
    active: true
  },
  {
    username: 'safaa_1233',
    email: 'safaa_1233@iyora.app',
    password: 'admin123456',
    name: 'Safaaa',
    role: 'viewer',
    active: true
  }
]

async function setupUsers() {
  console.log('\n👥 إعداد وتجهيز مستخدمي النظام في Firebase Auth...')
  const userMap = {}

  for (const u of USERS_TO_SETUP) {
    let uid = null
    try {
      const cred = await createUserWithEmailAndPassword(auth, u.email, u.password)
      uid = cred.user.uid
      console.log(`✅ تم إنشاء المستخدم: ${u.username} (${u.email}) [UID: ${uid}]`)
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        const cred = await signInWithEmailAndPassword(auth, u.email, u.password)
        uid = cred.user.uid
        console.log(`ℹ️ المستخدم موجود بالفعل، تم تسجيل الدخول: ${u.username} [UID: ${uid}]`)
      } else {
        console.error(`❌ خطأ أثناء إنشاء المستخدم ${u.username}:`, err.message)
      }
    }

    if (uid) {
      userMap[u.username] = uid
      // حفظ ملف المستخدم في كولكشن users
      const batch = writeBatch(db)
      const userRef = doc(db, 'users', uid)
      batch.set(userRef, {
        username: u.username,
        email: u.email,
        name: u.name,
        role: u.role,
        active: u.active,
        createdAt: new Date().toISOString()
      }, { merge: true })
      await batch.commit()
    }
  }

  return userMap
}

async function restoreCollection(colName, options = {}) {
  const filePath = path.join(backupDir, `${colName}.json`)
  if (!fs.existsSync(filePath)) {
    console.log(`⏭️ ملف ${colName}.json غير موجود، تخطي...`)
    return 0
  }

  const raw = fs.readFileSync(filePath, 'utf8')
  const docs = JSON.parse(raw)
  if (!Array.isArray(docs) || docs.length === 0) {
    console.log(`ℹ️ ${colName}: 0 مستند.`)
    return 0
  }

  console.log(`\n📥 جاري استعادة ${colName} (${docs.length} مستند)...`)

  let count = 0
  const BATCH_SIZE = 300

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE)
    const batch = writeBatch(db)

    for (const d of chunk) {
      const docId = d._id
      if (!docId) continue

      const cleanData = { ...d }
      delete cleanData._id
      const subPayments = cleanData._payments
      delete cleanData._payments

      const converted = convertTimestamps(cleanData)
      const docRef = doc(db, colName, docId)
      batch.set(docRef, converted)
      count++
    }

    await batch.commit()
    console.log(`   ✓ تم كتابة ${Math.min(i + BATCH_SIZE, docs.length)} / ${docs.length} مستند في ${colName}`)
  }

  // Restore subcollections if invoices
  if (colName === 'invoices') {
    console.log(`💳 جاري استعادة دفعات الفواتير (payments subcollection)...`)
    let paymentCount = 0
    let pBatch = writeBatch(db)
    let pBatchSize = 0

    for (const inv of docs) {
      if (inv._payments && Array.isArray(inv._payments) && inv._payments.length > 0) {
        for (const p of inv._payments) {
          const pId = p._id
          const pData = { ...p }
          delete pData._id
          const convertedP = convertTimestamps(pData)
          const pRef = doc(db, 'invoices', inv._id, 'payments', pId)
          pBatch.set(pRef, convertedP)
          pBatchSize++
          paymentCount++

          if (pBatchSize >= 300) {
            await pBatch.commit()
            pBatch = writeBatch(db)
            pBatchSize = 0
          }
        }
      }
    }

    if (pBatchSize > 0) {
      await pBatch.commit()
    }
    console.log(`   ✓ تم حفظ ${paymentCount} دفعة تحصيل في subcollections!`)
  }

  return count
}

async function main() {
  console.log('========================================')
  console.log('🚀 بدء ترحيل ورفع البيانات إلى iyora-help')
  console.log('========================================')

  // 1. Setup Auth and Users
  await setupUsers()

  // 2. Sign in as admin
  console.log('\n🔑 تسجيل الدخول بحساب المدير admin@iyora.app...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('🔓 تم تسجيل الدخول كمدير بنجاح!')

  // 3. Restore Collections in Logical Order
  const collections = [
    'settings',
    'counters',
    'assetCategories',
    'assetLocations',
    'services',
    'serviceCategories',
    'paymentMethods',
    'expenseCategories',
    'vendors',
    'vendorSpecialties',
    'vendorAdvances',
    'employeeTypes',
    'employees',
    'campaigns',
    'accounts',
    'clients',
    'jobCosts',
    'accountingTransactions',
    'journalEntries',
    'invoices'
  ]

  const summary = {}
  for (const col of collections) {
    const written = await restoreCollection(col)
    summary[col] = written
  }

  console.log('\n========================================')
  console.log('🎉 اكتملت عملية رفع البيانات إلى iyora-help بنجاح تام!')
  console.log('========================================')
  console.table(summary)
}

main().catch((err) => {
  console.error('\n❌ فشل الترحيل:', err)
  process.exit(1)
})
