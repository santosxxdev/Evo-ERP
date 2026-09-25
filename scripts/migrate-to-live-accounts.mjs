import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  serverTimestamp,
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

const stdAccounts = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'src/lib/standardChartOfAccounts.json'), 'utf8')
)

// Mapping of the 26 accounts that have transactions in accountingTransactions
// We preserve their exact Firestore _id so existing transaction lines stay 100% valid!
const PRESERVED_ACCOUNTS_MAP = {
  // Cash & Banks
  '1SbzikQIrwhRNebLQItx': { code: '1-01-01-01-01-001', name: 'الخزينة الرئيسية', role: 'cash', parentCode: '1-01-01-01-01', type: 'asset' },
  'uhLaFvWPnMtKiIHZPr9Z': { code: '1-01-01-01-01-002', name: 'الصندوق الفرعي', role: 'cash', parentCode: '1-01-01-01-01', type: 'asset' },
  '15YpOwzXFUOFLlfchBcG': { code: '1-01-01-01-01-003', name: 'خزينة تحصيلات سابقة', role: 'cash', parentCode: '1-01-01-01-01', type: 'asset' },
  'ks2M5KHOcmJYoJppDCmN': { code: '1-01-02-01-01-001', name: 'فودافون كاش (UGC)', role: 'bank', parentCode: '1-01-02-01-01', type: 'asset' },
  'wsir9PI2N0DQwwZ2f2d3': { code: '1-01-02-01-01-002', name: 'فودافون كاش (الباقات)', role: 'bank', parentCode: '1-01-02-01-01', type: 'asset' },

  // Receivables & Advances
  '1xLltnB865MB9ThmzFUL': { code: '1-01-03-01-01-001', name: 'العملاء (مدينون)', role: 'receivable', parentCode: '1-01-03-01-01', type: 'asset' },
  'B6Zob0FVHvdmOSgCfXPC': { code: '1-01-05-01-01-001', name: 'المخزون', role: 'inventory', parentCode: '1-01-05-01-01', type: 'asset' },
  'QNpHSZmw0CqDMrPI7jr4': { code: '1-01-06-01-01-002', name: 'دفعة مقدمة للموردين', role: 'vendorAdvance', parentCode: '1-01-06-01-01', type: 'asset' },

  // Liabilities
  '9xViGIXBokS44AC2iioM': { code: '2-01-01-01-01-001', name: 'الموردون', role: 'vendorPayable', parentCode: '2-01-01-01-01', type: 'liability' },
  '5Z16G1W6wqwE8A32lL9Z': { code: '2-01-03-01-01-001', name: 'مستحقات الموظفين', role: 'employeePayable', parentCode: '2-01-03-01-01', type: 'liability' },
  '6KsgoCsNpahotCVZMAtb': { code: '2-01-04-01-01-001', name: 'ضرائب مستحقة', role: 'tax', parentCode: '2-01-04-01-01', type: 'liability' },
  'ev58n5vFzXYA02J6qxc1': { code: '2-01-06-01-01-002', name: 'أمانات ميزانيات إعلانات العملاء', role: 'adBudgetHeld', parentCode: '2-01-06-01-01', type: 'liability' },

  // Equity
  'GdJj2MAvkQy6bLCph0KX': { code: '3-01-01-01-01-001', name: 'رأس المال', role: 'capital', parentCode: '3-01-01-01-01', type: 'equity' },
  '7ZTCfM1B8K8ZUxqtI6RO': { code: '3-01-03-01-01-001', name: 'المسحوبات الشخصية', role: 'drawings', parentCode: '3-01-03-01-01', type: 'equity' },
  'HMrzYxPrh4QYxXwOgRqk': { code: '3-02-01-01-01-001', name: 'أرصدة افتتاحية وأرباح سابقة', role: 'retained', parentCode: '3-02-01-01-01', type: 'equity' },

  // Revenue
  'BXTrvOjzaQXnTtM7BWo0': { code: '4-02-01-01-01-001', name: 'إيرادات المبيعات والخدمات', role: 'revenue', parentCode: '4-02-01-01-01', type: 'revenue' },

  // Costs (Level 5)
  'fWKFht90NZ7lc8ey3XNW': { code: '5-01-01-01-01-001', name: 'تكاليف إنتاج ومشتريات أخرى', role: 'costOther', parentCode: '5-01-01-01-01', type: 'expense' },
  '7spV1vAlNNOaNr7PB9HY': { code: '5-01-01-01-01-002', name: 'أجور موديلز ومؤديين', role: 'costModel', parentCode: '5-01-01-01-01', type: 'expense' },

  // Operational Expenses (Level 6)
  'KyoNGbedodBi52gbZPUd': { code: '6-02-01-01-01-001', name: 'إيجار مكاتب وفروع', role: 'rentExpense', parentCode: '6-02-01-01-01', type: 'expense' },
  'GTYUpkqX3E0jvdhOA5rh': { code: '6-02-03-01-01-001', name: 'هاتف وإنترنت', role: 'telecomExpense', parentCode: '6-02-03-01-01', type: 'expense' },
  'VcFDwzWWtUnxodtLNLIF': { code: '6-08-01-01-01-001', name: 'مصروفات أخرى ونثريات', role: 'otherExpense', parentCode: '6-08-01-01-01', type: 'expense' },
  'htOFYNpyoLOVaqcTocV2': { code: '6-08-01-01-01-002', name: 'مصاريف انتقال ومواصلات', parentCode: '6-08-01-01-01', type: 'expense' },
  '6rjP1fjA2yHaXq0sDFgb': { code: '6-08-01-01-01-003', name: 'مصاريف طعام وضيافة', parentCode: '6-08-01-01-01', type: 'expense' },
  'nH5KHgEYMJio5l8vIjkA': { code: '6-08-01-01-01-004', name: 'مصاريف محاسب قانوني ومراجعة', parentCode: '6-08-01-01-01', type: 'expense' },
  '0DIv6gLaxrTwSU4UHhZ9': { code: '6-08-01-01-01-005', name: 'اشتراكات برامج وتطبيقات', parentCode: '6-08-01-01-01', type: 'expense' },
  'pFoHqCizHe7ABc1fYJR5': { code: '6-08-01-01-01-006', name: 'مصاريف نظافة وأدوات مكتبية', parentCode: '6-08-01-01-01', type: 'expense' }
}

async function runMigration() {
  console.log('🔐 تسجيل الدخول بحساب المدير admin@iyora.app...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول بنجاح.')

  console.log('\n📡 جلب الحسابات الحالية من قاعدة البيانات (iyora-eg)...')
  const accountsSnap = await getDocs(collection(db, 'accounts'))
  console.log(`وجدنا ${accountsSnap.size} حساب حالي.`)

  const preservedIds = new Set(Object.keys(PRESERVED_ACCOUNTS_MAP))
  const preservedCodes = new Set(Object.values(PRESERVED_ACCOUNTS_MAP).map(v => v.code))

  // 1. Delete old accounts that have no transactions and are not in preserved list
  console.log('\n🧹 تنظيف الحسابات القديمة غير المستخدمة...')
  let deletedCount = 0
  for (const accountDoc of accountsSnap.docs) {
    if (!preservedIds.has(accountDoc.id)) {
      await deleteDoc(doc(db, 'accounts', accountDoc.id))
      deletedCount++
    }
  }
  console.log(`تم حذف ${deletedCount} حساب قديم غير مستخدم.`)

  // 2. Update the 26 preserved accounts with standard codes and hierarchy
  console.log('\n🔄 تحديث الحسابات الـ 26 التاريخية بالأكواد القياسية الجديدة...')
  for (const [id, meta] of Object.entries(PRESERVED_ACCOUNTS_MAP)) {
    const payload = {
      code: meta.code,
      name: meta.name,
      nameEn: '',
      level: meta.code.split('-').length,
      type: meta.type,
      categoryName: meta.name,
      isGroup: false,
      isPosting: true,
      role: meta.role || null,
      parentCode: meta.parentCode,
      notes: 'حساب تاريخي تم تحديثه للشجرة القياسية',
      archived: false,
      updatedAt: serverTimestamp()
    }
    await setDoc(doc(db, 'accounts', id), payload, { merge: true })
  }
  console.log('✅ تم تحديث كافة الحسابات الـ 26 بنجاح.')

  // 3. Seed all other standard accounts from standardChartOfAccounts
  console.log('\n🌱 زرع باقي شجرة الحسابات القياسية ذات الـ 6 مستويات...')
  const accountsToSeed = stdAccounts.filter(acc => !preservedCodes.has(acc.code))
  console.log(`سيتم زرع ${accountsToSeed.length} حساباً قياسياً جديداً...`)

  // Chunk in batches of 400
  const chunks = []
  let chunk = []
  for (const acc of accountsToSeed) {
    chunk.push(acc)
    if (chunk.length >= 350) {
      chunks.push(chunk)
      chunk = []
    }
  }
  if (chunk.length > 0) chunks.push(chunk)

  for (let i = 0; i < chunks.length; i++) {
    const batch = writeBatch(db)
    for (const acc of chunks[i]) {
      const ref = doc(collection(db, 'accounts'))
      batch.set(ref, {
        code: acc.code,
        name: acc.name,
        nameEn: acc.nameEn || '',
        level: acc.level || acc.code.split('-').length,
        type: acc.type,
        categoryName: acc.categoryName || '',
        isGroup: Boolean(acc.isGroup),
        isPosting: Boolean(acc.isPosting),
        role: acc.role || null,
        normalBalance: acc.normalBalance || null,
        parentCode: acc.parentCode || null,
        notes: acc.notes || '',
        archived: false,
        createdAt: serverTimestamp()
      })
    }
    await batch.commit()
    console.log(`تم إدخال الدفعة ${i + 1} من ${chunks.length}...`)
  }

  // Check final count
  const finalSnap = await getDocs(collection(db, 'accounts'))
  console.log(`\n🎉 اكتمل زرع الشجرة القياسية! إجمالي الحسابات الآن في iyora-eg: ${finalSnap.size} حساب.`)
}

runMigration().catch(err => {
  console.error('❌ خطأ أثناء الهجرة:', err)
  process.exit(1)
})
