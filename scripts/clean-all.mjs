/*
 * مسح وحذف جميع البيانات التجريبية والتجارية في النظام (iyora-eg)
 * وإعادة النظام نقيًا بالكامل مع الإبقاء على المستخدم الأول فقط وشجرة الحسابات الأساسية.
 *
 * الاستخدام — يلزم إيميل وكلمة سر مدير:
 *   node scripts/clean-all.mjs --email admin@iyora.app --password xxxx
 */
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  addDoc, collection, collectionGroup, deleteDoc, doc, getDocs, serverTimestamp, setDoc,
} from 'firebase/firestore'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyCb1BmZI6H7rw4fPO72yNJBQHtsfpzwr8M',
  authDomain: 'iyora-eg.firebaseapp.com',
  projectId: 'iyora-eg',
  storageBucket: 'iyora-eg.firebasestorage.app',
  messagingSenderId: '1064818599797',
  appId: '1:1064818599797:web:90b4742b1a38763dcd953c',
}

const DEFAULT_ACCOUNTS = [
  { code: '1', name: 'الأصول', type: 'asset', isGroup: true },
  { code: '11', name: 'الأصول المتداولة', type: 'asset', isGroup: true, parent: '1' },
  { code: '111', name: 'النقدية والبنوك', type: 'asset', isGroup: true, parent: '11' },
  { code: '1111', name: 'الخزينة', type: 'asset', parent: '111', role: 'cash' },
  { code: '1112', name: 'البنوك والمحافظ', type: 'asset', parent: '111', role: 'bank' },
  { code: '112', name: 'العملاء (مدينون)', type: 'asset', parent: '11', role: 'receivable' },
  { code: '113', name: 'المخزون', type: 'asset', parent: '11' },
  { code: '12', name: 'الأصول غير المتداولة', type: 'asset', isGroup: true, parent: '1' },
  { code: '121', name: 'الأصول الثابتة', type: 'asset', isGroup: true, parent: '12' },
  { code: '1211', name: 'معدات وأجهزة', type: 'asset', parent: '121', role: 'equipment' },
  { code: '1212', name: 'مجمع إهلاك المعدات', type: 'asset', parent: '121', role: 'accumDep' },
  { code: '122', name: 'الأصول غير الملموسة', type: 'asset', isGroup: true, parent: '12' },
  { code: '1221', name: 'برمجيات وتراخيص', type: 'asset', parent: '122' },
  { code: '2', name: 'الالتزامات', type: 'liability', isGroup: true },
  { code: '21', name: 'الالتزامات المتداولة', type: 'liability', isGroup: true, parent: '2' },
  { code: '211', name: 'الموردون', type: 'liability', parent: '21', role: 'vendorPayable' },
  { code: '212', name: 'مستحقات الموظفين', type: 'liability', parent: '21', role: 'employeePayable' },
  { code: '213', name: 'أمانات ميزانيات إعلانات العملاء', type: 'liability', parent: '21', role: 'adBudgetHeld' },
  { code: '214', name: 'ضرائب مستحقة', type: 'liability', parent: '21', role: 'tax' },
  { code: '22', name: 'الالتزامات غير المتداولة', type: 'liability', isGroup: true, parent: '2' },
  { code: '221', name: 'قروض طويلة الأجل', type: 'liability', parent: '22' },
  { code: '3', name: 'حقوق الملكية', type: 'equity', isGroup: true },
  { code: '31', name: 'رأس المال', type: 'equity', parent: '3', role: 'capital' },
  { code: '32', name: 'الاحتياطات', type: 'equity', parent: '3' },
  { code: '33', name: 'الأرباح المحتجزة', type: 'equity', parent: '3', role: 'retained' },
  { code: '34', name: 'المسحوبات الشخصية', type: 'equity', parent: '3', role: 'drawings' },
  { code: '4', name: 'الإيرادات', type: 'revenue', isGroup: true },
  { code: '41', name: 'إيرادات المبيعات', type: 'revenue', parent: '4', role: 'revenue' },
  { code: '42', name: 'إيرادات متنوعة', type: 'revenue', parent: '4' },
  { code: '5', name: 'المصروفات', type: 'expense', isGroup: true },
  { code: '51', name: 'المصروفات الإدارية', type: 'expense', isGroup: true, parent: '5' },
  { code: '511', name: 'مرتبات وأجور', type: 'expense', parent: '51', role: 'salaryExpense' },
  { code: '512', name: 'إيجار', type: 'expense', parent: '51' },
  { code: '513', name: 'إنترنت واتصالات', type: 'expense', parent: '51' },
  { code: '514', name: 'مواصلات', type: 'expense', parent: '51' },
  { code: '515', name: 'صيانة معدات', type: 'expense', parent: '51', role: 'maintenance' },
  { code: '516', name: 'إهلاك المعدات', type: 'expense', parent: '51', role: 'depreciation' },
  { code: '517', name: 'مصروفات أخرى', type: 'expense', parent: '51', role: 'otherExpense' },
  { code: '52', name: 'المصروفات البيعية', type: 'expense', isGroup: true, parent: '5' },
  { code: '521', name: 'إعلانات الشركة', type: 'expense', parent: '52' },
  { code: '53', name: 'المصروفات التشغيلية', type: 'expense', isGroup: true, parent: '5' },
  { code: '531', name: 'أجور موديلز', type: 'expense', parent: '53', role: 'costModel' },
  { code: '532', name: 'تصوير ومونتاج', type: 'expense', parent: '53', role: 'costVideo' },
  { code: '533', name: 'تصميم جرافيك', type: 'expense', parent: '53', role: 'costDesign' },
  { code: '534', name: 'إيجار معدات', type: 'expense', parent: '53', role: 'costEquipment' },
  { code: '535', name: 'عمولات ونسب', type: 'expense', parent: '53', role: 'costCommission' },
  { code: '536', name: 'تكاليف إنتاج أخرى', type: 'expense', parent: '53', role: 'costOther' },
]

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const EMAIL = arg('email') || process.env.IYORA_EMAIL
const PASSWORD = arg('password') || process.env.IYORA_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('✖ محتاج --email و --password (أو IYORA_EMAIL / IYORA_PASSWORD). لازم حساب مدير.')
  process.exit(1)
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)
const S = (path) => collection(db, path)

async function main() {
  console.log(`→ تسجيل الدخول: ${EMAIL}`)
  const cred = await signInWithEmailAndPassword(auth, EMAIL, PASSWORD)
  const currentUid = cred.user.uid
  console.log(`✓ تم تسجيل الدخول للمدير (${currentUid})`)

  console.log('\n🧹 بدء تنظيف وتصفير النظام بالكامل…\n')

  // 1. Payments subcollections
  try {
    const paySnap = await getDocs(collectionGroup(db, 'payments'))
    for (const p of paySnap.docs) await deleteDoc(p.ref)
    if (paySnap.size > 0) console.log(`  − payments: حذف ${paySnap.size}`)
  } catch (e) {
    console.warn('  ! payments error:', e.message)
  }

  // 2. Collections to clear completely
  const collections = [
    'invoices', 'clients', 'employees', 'employeeEntries', 'vendors', 'assets',
    'assetUsage', 'assetLocations', 'jobCosts', 'expenses', 'expenseCategories',
    'services', 'serviceCategories', 'quotations', 'retainers', 'campaigns',
    'maintenance', 'journalEntries', 'activityTypes', 'paymentMethods',
    'assetCategories', 'vendorSpecialties', 'counters',
  ]

  for (const col of collections) {
    const snap = await getDocs(S(col))
    let count = 0
    for (const d of snap.docs) {
      await deleteDoc(d.ref)
      count++
    }
    if (count > 0) console.log(`  − ${col}: حذف ${count}`)
  }

  // 3. Clear users keeping only the logged in user
  const usersSnap = await getDocs(S('users'))
  let deletedUsers = 0
  for (const uDoc of usersSnap.docs) {
    if (uDoc.id !== currentUid) {
      await deleteDoc(uDoc.ref)
      deletedUsers++
    }
  }
  console.log(`  − users: حذف ${deletedUsers} مستخدمين (تم الإبقاء على المستخدم الأول/الحالي)`)

  // 4. Reset accounts
  const accSnap = await getDocs(S('accounts'))
  for (const d of accSnap.docs) await deleteDoc(d.ref)
  for (const a of DEFAULT_ACCOUNTS) {
    await addDoc(S('accounts'), {
      code: a.code, name: a.name, nameEn: '', type: a.type,
      isGroup: Boolean(a.isGroup), role: a.role ?? null,
      parentCode: a.parent ?? null, archived: false,
      createdAt: serverTimestamp(),
    })
  }
  console.log(`  + accounts: تم إعادة إنشاء ${DEFAULT_ACCOUNTS.length} حساب أساسي`)

  // 5. Reset company settings
  await setDoc(doc(db, 'settings', 'company'), {
    companyName: 'iyora', taxEnabled: false, taxRate: 14, invoicePrefix: 'INV',
    updatedAt: serverTimestamp(),
  }, { merge: true })
  console.log('  + settings: تم ضبط الإعدادات الافتراضية')

  console.log('\n✨ اكتمل تنظيف وتصفير النظام بنجاح!')
  process.exit(0)
}

main().catch((err) => {
  console.error('✖ خطأ أثناء التنظيف:', err)
  process.exit(1)
})
