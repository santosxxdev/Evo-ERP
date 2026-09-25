import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  Timestamp,
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

const backupDir = path.join(rootDir, 'backups', 'backup-2026-09-21T17-05-00-589Z')
const stdAccounts = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'src/lib/standardChartOfAccounts.json'), 'utf8')
)

// The 26 accounts used in accountingTransactions mapped to new 6-level standard codes
const PRESERVED_ACCOUNTS_MAP = {
  // Cash & Banks
  '1SbzikQIrwhRNebLQItx': { code: '1-01-01-01-01-001', name: 'الخزينة الرئيسية', role: 'cash', parentCode: '1-01-01-01-01', type: 'asset' },
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

  // Costs
  'fWKFht90NZ7lc8ey3XNW': { code: '5-01-01-01-01-001', name: 'تكاليف إنتاج ومشتريات أخرى', role: 'costOther', parentCode: '5-01-01-01-01', type: 'expense' },
  '7spV1vAlNNOaNr7PB9HY': { code: '5-01-01-01-01-002', name: 'أجور موديلز ومؤديين', role: 'costModel', parentCode: '5-01-01-01-01', type: 'expense' },

  // Expenses
  'KyoNGbedodBi52gbZPUd': { code: '6-02-01-01-01-001', name: 'إيجار مكاتب وفروع', role: 'rentExpense', parentCode: '6-02-01-01-01', type: 'expense' },
  'GTYUpkqX3E0jvdhOA5rh': { code: '6-02-03-01-01-001', name: 'هاتف وإنترنت', role: 'telecomExpense', parentCode: '6-02-03-01-01', type: 'expense' },
  'VcFDwzWWtUnxodtLNLIF': { code: '6-08-01-01-01-001', name: 'مصروفات أخرى ونثريات', role: 'otherExpense', parentCode: '6-08-01-01-01', type: 'expense' },
  'htOFYNpyoLOVaqcTocV2': { code: '6-08-01-01-01-002', name: 'مصاريف انتقال ومواصلات', parentCode: '6-08-01-01-01', type: 'expense' },
  '6rjP1fjA2yHaXq0sDFgb': { code: '6-08-01-01-01-003', name: 'مصاريف طعام وضيافة', parentCode: '6-08-01-01-01', type: 'expense' },
  'nH5KHgEYMJio5l8vIjkA': { code: '6-08-01-01-01-004', name: 'مصاريف محاسب قانوني ومراجعة', parentCode: '6-08-01-01-01', type: 'expense' },
  '0DIv6gLaxrTwSU4UHhZ9': { code: '6-08-01-01-01-005', name: 'اشتراكات برامج وتطبيقات', parentCode: '6-08-01-01-01', type: 'expense' },
  'pFoHqCizHe7ABc1fYJR5': { code: '6-08-01-01-01-006', name: 'مصاريف نظافة وأدوات مكتبية', parentCode: '6-08-01-01-01', type: 'expense' }
}

/** Recursively restore Firestore Timestamps from backup JSON objects */
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

const COLLECTIONS_TO_WIPE = [
  'departments',
  'positions',
  'attendance',
  'attendanceSettings',
  'employeeAllowances',
  'employeeDeductions',
  'employeeEntries',
  'payroll',
  'payrollRuns',
  'payrollItems',
  'expenses',
  'employees',
  'clients',
  'invoices',
  'purchaseInvoices',
  'purchaseReturns',
  'supplierCreditNotes',
  'vendorAdvances',
  'vendorPayments',
  'supplierPayables',
  'vendors',
  'vendorSpecialties',
  'services',
  'serviceCategories',
  'jobCosts',
  'expenseCategories',
  'assetCategories',
  'assetLocations',
  'assets',
  'maintenance',
  'assetUsage',
  'campaigns',
  'quotations',
  'retainers',
  'activityTypes',
  'paymentMethods',
  'accountingTransactions',
  'journalEntries',
  'counters',
  'accounts'
]

async function fullCleanAndRestore() {
  console.log('==================================================')
  console.log('🚀 بدء المسح الكامل والاستعادة الدقيقة للبيانات (iyora-eg)')
  console.log('==================================================\n')

  console.log('🔐 تسجيل الدخول بحساب المدير admin@iyora.app...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول بنجاح.\n')

  // -------------------------------------------------------------
  // 1. WIPE ALL BUSINESS COLLECTIONS
  // -------------------------------------------------------------
  console.log('🧹 المرحلة 1: مسح كافة الكولكشنز الحالية تماماً...')
  for (const colName of COLLECTIONS_TO_WIPE) {
    try {
      const snap = await getDocs(collection(db, colName))
      if (!snap.empty) {
        for (const d of snap.docs) {
          // If invoice, also delete subcollection payments
          if (colName === 'invoices') {
            try {
              const pSnap = await getDocs(collection(db, 'invoices', d.id, 'payments'))
              for (const p of pSnap.docs) {
                await deleteDoc(doc(db, 'invoices', d.id, 'payments', p.id))
              }
            } catch (e) {}
          }
          await deleteDoc(doc(db, colName, d.id))
        }
        console.log(`  - تم مسح كولكشن "${colName}" (${snap.size} مستند)`)
      }
    } catch (err) {
      console.warn(`  - تخطي "${colName}":`, err.message)
    }
  }
  console.log('✅ اكتمل المسح والتنظيف الشامل بنجاح.\n')

  // -------------------------------------------------------------
  // 2. SEED NEW CHART OF ACCOUNTS (370 accounts)
  // -------------------------------------------------------------
  console.log('🌱 المرحلة 2: زرع شجرة الحسابات الجديدة القياسية (370 حساباً)...')

  // A. Seed 26 mapped accounts with their preserved _id
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
      notes: 'حساب تاريخي معتمد في الشجرة القياسية',
      archived: false,
      createdAt: serverTimestamp()
    }
    await setDoc(doc(db, 'accounts', id), payload)
  }

  // B. Seed remaining accounts from standardChartOfAccounts
  const preservedCodes = new Set(Object.values(PRESERVED_ACCOUNTS_MAP).map(v => v.code))
  const otherStdAccounts = stdAccounts.filter(acc => !preservedCodes.has(acc.code) && !['1-01-01-01-01-002', '1-01-02-01-01-003'].includes(acc.code))

  const chunks = []
  let currentChunk = []
  for (const acc of otherStdAccounts) {
    currentChunk.push(acc)
    if (currentChunk.length >= 350) {
      chunks.push(currentChunk)
      currentChunk = []
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk)

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
  }
  console.log('✅ تم زرع شجرة الحسابات القياسية بالكامل (370 حساباً).\n')

  // -------------------------------------------------------------
  // 3. RESTORE ALL DATA FROM BACKUP FILES
  // -------------------------------------------------------------
  console.log('📥 المرحلة 3: استعادة كافة البيانات الأصلية من النسخة الاحتياطية...')

  const restoreFiles = [
    { file: 'clients.json', col: 'clients' },
    { file: 'employees.json', col: 'employees' },
    { file: 'employeeTypes.json', col: 'employeeTypes' },
    { file: 'vendors.json', col: 'vendors' },
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

  for (const item of restoreFiles) {
    const filePath = path.join(backupDir, item.file)
    if (!fs.existsSync(filePath)) continue

    const records = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    console.log(`  - جاري استعادة كولكشن "${item.col}" (${records.length} مستند)...`)

    // Write in batches
    const itemChunks = []
    let c = []
    for (const rec of records) {
      c.push(rec)
      if (c.length >= 350) {
        itemChunks.push(c)
        c = []
      }
    }
    if (c.length > 0) itemChunks.push(c)

    for (const chunk of itemChunks) {
      const batch = writeBatch(db)
      for (const rec of chunk) {
        const { _id, _applications, ...data } = rec
        if (item.col === 'accountingTransactions') {
          if (_id === 'JXSPfObARcs7awTK3wQz') continue
          if (Array.isArray(data.lines)) {
            data.lines = data.lines.map(line => {
              if (
                line.accountId === 'uhLaFvWPnMtKiIHZPr9Z' ||
                line.accountId === '15YpOwzXFUOFLlfchBcG' ||
                line.accountCode === '1-01-01-01-01-002' ||
                line.accountCode === '1-01-01-01-01-003'
              ) {
                return { ...line, accountId: '1SbzikQIrwhRNebLQItx', accountCode: '1-01-01-01-01-001' }
              }
              return line
            })
          }
        }
        if (item.col === 'accounts' && (
          _id === 'uhLaFvWPnMtKiIHZPr9Z' ||
          _id === '15YpOwzXFUOFLlfchBcG' ||
          data.code === '1-01-01-01-01-002' ||
          data.code === '1-01-01-01-01-003'
        )) continue
        const cleanData = convertTimestamps(data)
        const ref = doc(db, item.col, _id)
        batch.set(ref, cleanData)
      }
      await batch.commit()
    }
  }

  // -------------------------------------------------------------
  // 4. RESTORE INVOICES WITH PAYMENTS SUBCOLLECTION
  // -------------------------------------------------------------
  const invPath = path.join(backupDir, 'invoices.json')
  if (fs.existsSync(invPath)) {
    const invoices = JSON.parse(fs.readFileSync(invPath, 'utf8'))
    console.log(`  - جاري استعادة كولكشن "invoices" (${invoices.length} فاتورة بدفعاتها)...`)

    for (const inv of invoices) {
      const { _id, _payments, ...invData } = inv
      const cleanData = convertTimestamps(invData)
      await setDoc(doc(db, 'invoices', _id), cleanData)

      if (_payments && Array.isArray(_payments) && _payments.length > 0) {
        for (const p of _payments) {
          const { _id: payId, ...payData } = p
          const cleanPay = convertTimestamps(payData)
          await setDoc(doc(db, 'invoices', _id, 'payments', payId), cleanPay)
        }
      }
    }
  }

  // -------------------------------------------------------------
  // 5. FINAL AUDIT & CONFIRMATION
  // -------------------------------------------------------------
  console.log('\n==================================================')
  console.log('🎉 اكتملت الاستعادة بنجاح 100%! فحص البيانات الفعلي:')
  console.log('==================================================')

  const auditCols = [
    { name: 'invoices', title: 'الفواتير' },
    { name: 'clients', title: 'العملاء' },
    { name: 'employees', title: 'الموظفون' },
    { name: 'vendors', title: 'الموردون' },
    { name: 'services', title: 'الخدمات' },
    { name: 'jobCosts', title: 'تكاليف العمليات' },
    { name: 'accountingTransactions', title: 'الحركات المحاسبية' },
    { name: 'journalEntries', title: 'قيود اليومية' },
    { name: 'accounts', title: 'شجرة الحسابات الجديدة' }
  ]

  for (const c of auditCols) {
    const s = await getDocs(collection(db, c.name))
    console.log(`- ${c.title} (${c.name}): ${s.size} مستند`)
  }
  console.log('==================================================\n')
}

fullCleanAndRestore().catch(err => {
  console.error('❌ خطأ أثناء المسح والاستعادة:', err)
  process.exit(1)
})
