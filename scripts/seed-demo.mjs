/*
 * بذر بيانات تجريبية شاملة في Firestore (iyora-eg) — تغطّي كل وحدة في النظام
 * عشان تختبرها كلها: شجرة حسابات، خدمات بتكلفة، موردون، معدات (نقدي وآجل)،
 * موظفون بحركات كشف، عملاء، فواتير (مدفوعة/جزئية/غير مدفوعة/دائنة/بضريبة/
 * بميزانية إعلانات/ملغاة)، مصروفات شركة + إنفاق إعلاني لعميل، عروض أسعار،
 * باقات شهرية، سندات (افتتاحي/صرف/قبض/مسحوبات/ضريبة/تحويل/قيد يدوي)، صيانة.
 *
 * الاستخدام — لازم تسجّل دخول بحساب «مدير»:
 *   node scripts/seed-demo.mjs --email admin@iyora.app --password xxxx
 *
 * حذف كل ما بُذر (كل مستند متعلّم بـ demoSeed:true):
 *   node scripts/seed-demo.mjs --clean --email admin@iyora.app --password xxxx
 *
 * الحساب وكلمة السر عندك أنت، السكربت بيكلّم مشروعك مباشرةً.
 */
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where,
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

/* ---------- args ---------- */
const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const CLEAN = argv.includes('--clean')
const EMAIL = arg('email') || process.env.IYORA_EMAIL
const PASSWORD = arg('password') || process.env.IYORA_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('✖ محتاج --email و --password (أو IYORA_EMAIL / IYORA_PASSWORD). لازم حساب مدير.')
  process.exit(1)
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const S = (path) => collection(db, path)
const create = (path, data) => addDoc(S(path), { ...data, demoSeed: true, createdAt: serverTimestamp() })
const M = (n) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })

/* ---------- تكلفة الخدمة (نفس منطق src/lib/costing.js) ---------- */
function breakdown(costing = {}) {
  const sum = (rows) => round2((rows ?? []).reduce((s, r) => s + Number(r.amount || 0), 0))
  const directTotal = sum(costing.direct)
  const indirectTotal = sum(costing.indirect)
  return { directTotal, indirectTotal }
}
function expectedCostOfItems(items, serviceMap) {
  let direct = 0, indirect = 0
  const lines = []
  for (const it of items) {
    if (it.isAdBudget) continue
    const svc = it.serviceId ? serviceMap.get(it.serviceId) : null
    if (!svc?.costing) continue
    const b = breakdown(svc.costing)
    if (b.directTotal === 0 && b.indirectTotal === 0) continue
    const qty = Number(it.qty) || 1
    const d = round2(b.directTotal * qty)
    const ind = round2(b.indirectTotal * qty)
    direct += d; indirect += ind
    lines.push({ name: it.name, qty, direct: d, indirect: ind, total: round2(d + ind) })
  }
  return { direct: round2(direct), indirect: round2(indirect), total: round2(direct + indirect), lines }
}

/* ---------- شجرة الحسابات الافتراضية (نسخة من src/lib/accounts.js) ---------- */
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

/* ---------- clean ---------- */
async function cleanCollection(path, { withPayments = false } = {}) {
  const snap = await getDocs(query(S(path), where('demoSeed', '==', true)))
  let n = 0
  for (const d of snap.docs) {
    if (withPayments) {
      const pay = await getDocs(S(`${path}/${d.id}/payments`))
      for (const p of pay.docs) await deleteDoc(p.ref)
    }
    await deleteDoc(d.ref)
    n += 1
  }
  if (n > 0) console.log(`  − ${path}: حذف ${n}`)
}

/* ================================================================ */
async function main() {
  console.log(`→ تسجيل الدخول: ${EMAIL}`)
  await signInWithEmailAndPassword(auth, EMAIL, PASSWORD)
  console.log('✓ تم')

  if (CLEAN) {
    console.log('\n🧹 حذف كل البيانات التجريبية…')
    await cleanCollection('invoices', { withPayments: true })
    await cleanCollection('jobCosts')
    await cleanCollection('expenses')
    await cleanCollection('journalEntries')
    await cleanCollection('quotations')
    await cleanCollection('retainers')
    await cleanCollection('campaigns')
    await cleanCollection('maintenance')
    await cleanCollection('employeeEntries')
    await cleanCollection('clients')
    await cleanCollection('services')
    await cleanCollection('serviceCategories')
    await cleanCollection('vendors')
    await cleanCollection('assets')
    await cleanCollection('employees')
    await cleanCollection('activityTypes')
    await cleanCollection('expenseCategories')
    await cleanCollection('paymentMethods')
    await cleanCollection('assetCategories')
    await cleanCollection('vendorSpecialties')
    await cleanCollection('accounts')
    console.log('\n✓ خلص. (الإعدادات وعدّاد الفواتير مش بيترجعوا — عدّلهم يدويًا لو محتاج.)')
    process.exit(0)
  }

  const guard = await getDocs(query(S('invoices'), where('demoSeed', '==', true)))
  if (!guard.empty) {
    console.log(`\n⚠ فيه ${guard.size} فاتورة تجريبية موجودة. امسح الأول:`)
    console.log('   node scripts/seed-demo.mjs --clean --email … --password …')
    process.exit(0)
  }

  console.log('\n🌱 بذر البيانات الشاملة…\n')

  /* ---------- 1) شجرة الحسابات ---------- */
  let accounts = (await getDocs(S('accounts'))).docs.map((d) => ({ id: d.id, ...d.data() }))
  if (accounts.length === 0) {
    for (const a of DEFAULT_ACCOUNTS) {
      await create('accounts', {
        code: a.code, name: a.name, nameEn: '', type: a.type,
        isGroup: Boolean(a.isGroup), role: a.role ?? null,
        parentCode: a.parent ?? null, archived: false,
      })
    }
    accounts = (await getDocs(S('accounts'))).docs.map((d) => ({ id: d.id, ...d.data() }))
    console.log(`  + accounts: ${DEFAULT_ACCOUNTS.length} (شجرة جديدة)`)
  } else {
    console.log(`  · accounts: ${accounts.length} موجودة — استخدمناها`)
  }
  const acc = (role) => accounts.find((a) => a.role === role)?.id ?? null

  /* ---------- 2) الإعدادات: تفعيل الضريبة ---------- */
  await setDoc(doc(db, 'settings', 'company'), {
    companyName: 'iyora', taxEnabled: true, taxRate: 14, invoicePrefix: 'INV',
    websiteUrl: 'https://iyora-eg.web.app',
    companyPhone: '01000000000', companyEmail: 'hello@iyora.eg', companyAddress: 'المعادي، القاهرة',
    bankName: 'CIB — انستاباي', bankAccount: '100012345678', bankHolder: 'iyora للإنتاج الإعلامي',
    contractTerms:
      '١. الدفعة المقدّمة 50% عند التعاقد والباقي عند التسليم.\n' +
      '٢. التسليم خلال المدة المتفق عليها من تاريخ استلام المادة الخام.\n' +
      '٣. تعديلان مجانيان لكل مخرج، وأي تعديل إضافي يُحاسب عليه.\n' +
      '٤. الإلغاء بعد بدء التنفيذ لا يُسترد معه المقدّم.',
  }, { merge: true })
  console.log('  + settings: ضريبة 14% + بيانات الشركة والبنك وشروط العقد')

  /* ---------- 3) طرق التحويل ---------- */
  const pmCash = await create('paymentMethods', { name: 'نقدي (الخزينة)', type: 'cash', accountNumber: '', accountHolder: '', accountId: acc('cash'), archived: false })
  const pmBank = await create('paymentMethods', { name: 'InstaPay — CIB', type: 'bank', accountNumber: '100012345678', accountHolder: 'iyora', accountId: acc('bank'), archived: false })
  const pmWallet = await create('paymentMethods', { name: 'فودافون كاش', type: 'wallet', accountNumber: '01012345678', accountHolder: 'iyora', accountId: acc('bank'), archived: false })
  console.log('  + paymentMethods: 3 (نقدي / بنك / محفظة)')

  /* ---------- 4) القوائم: أنواع نشاط + تصنيفات خدمات ---------- */
  for (const n of ['مطاعم وكافيهات', 'لياقة ورياضة', 'تجزئة وأزياء', 'رعاية صحية', 'تعليم']) {
    await create('activityTypes', { name: n, archived: false })
  }
  const scMap = {}
  for (const n of ['فيديو', 'تصميم', 'تصوير', 'إدارة حملات']) {
    const r = await create('serviceCategories', { name: n, archived: false })
    scMap[n] = r.id
  }
  console.log('  + activityTypes: 5 · serviceCategories: 4')

  /* ---------- 5) المعدات (منها واحدة آجل) + صيانة ---------- */
  for (const name of ['كاميرا', 'عدسة', 'إضاءة', 'صوت', 'كمبيوتر ولابتوب', 'درون', 'أخرى']) {
    await create('assetCategories', { name })
  }
  for (const name of ['موديل', 'تصوير ومونتاج', 'تصميم جرافيك', 'إيجار معدات', 'صوت', 'أخرى']) {
    await create('vendorSpecialties', { name })
  }

  const assetDefs = [
    { name: 'Sony A7 IV', category: 'كاميرا', serial: 'SN-A74-001', purchaseDate: '2026-01-15', purchaseCost: 95000, usefulLifeMonths: 36, salvageValue: 9500, acquisition: 'cash' },
    { name: 'Sony 24-70 GM II', category: 'عدسة', serial: 'SN-2470-002', purchaseDate: '2026-01-15', purchaseCost: 48000, usefulLifeMonths: 48, salvageValue: 6000, acquisition: 'cash' },
    { name: 'Aputure 300x ×2', category: 'إضاءة', serial: 'SN-AP300-003', purchaseDate: '2026-02-01', purchaseCost: 42000, usefulLifeMonths: 48, salvageValue: 4000, acquisition: 'cash' },
    { name: 'MacBook Pro M3 Max', category: 'كمبيوتر ولابتوب', serial: 'SN-MBP-004', purchaseDate: '2026-01-20', purchaseCost: 88000, usefulLifeMonths: 48, salvageValue: 12000, acquisition: 'cash' },
    { name: 'DJI Ronin 4D (آجل)', category: 'كاميرا', serial: 'SN-R4D-006', purchaseDate: '2026-05-10', purchaseCost: 120000, usefulLifeMonths: 48, salvageValue: 15000, acquisition: 'credit' },
  ]
  const assetIds = []
  for (const a of assetDefs) {
    const r = await create('assets', { ...a, status: 'active', assignedTo: null, notes: 'بيانات تجريبية' })
    assetIds.push({ id: r.id, name: a.name })
  }
  await create('maintenance', { assetId: assetIds[0].id, assetName: assetIds[0].name, date: '2026-06-20', description: 'تنظيف مستشعر + معايرة', cost: 850, vendorId: null, workshop: 'Sony Service', nextDueDate: '2026-12-20' })
  await create('maintenance', { assetId: assetIds[3].id, assetName: assetIds[3].name, date: '2026-07-05', description: 'تغيير بطارية', cost: 1900, vendorId: null, workshop: 'iStore', nextDueDate: null })
  console.log(`  + assets: ${assetDefs.length} (واحدة آجل) · maintenance: 2`)

  const depShare = 869

  /* ---------- 6) الخدمات ---------- */
  const serviceDefs = [
    { key: 's1', name: 'فيديو UGC', price: 6000, unit: 'فيديو', cat: 'فيديو', costing: {
      direct: [ { key: 'model', label: 'موديل', amount: 1200 }, { key: 'video', label: 'مصور + مونتير', amount: 1400 }, { key: 'equipment', label: 'عدسة إضافية', amount: 300 } ],
      indirect: [ { key: 'rent', label: 'إيجار', amount: 500 }, { key: 'internet', label: 'إنترنت', amount: 120 }, { key: 'electricity', label: 'كهربا', amount: 110 }, { key: 'lighting', label: 'إضاءة', amount: 90 }, { key: 'depreciation', label: 'إهلاك', amount: depShare } ],
      markupPct: 60 } },
    { key: 's2', name: 'باقة سوشيال ميديا شهرية', price: 12000, unit: 'شهر', cat: 'تصميم', costing: {
      direct: [ { key: 'design', label: '12 تصميم', amount: 2400 }, { key: 'video', label: '4 ريلز', amount: 2000 }, { key: 'model', label: 'موديل', amount: 1600 } ],
      indirect: [ { key: 'rent', label: 'إيجار', amount: 900 }, { key: 'internet', label: 'إنترنت', amount: 350 }, { key: 'electricity', label: 'كهربا', amount: 200 }, { key: 'lighting', label: 'إضاءة', amount: 120 }, { key: 'depreciation', label: 'إهلاك', amount: round2(depShare * 1.4) } ],
      markupPct: 55 } },
    { key: 's3', name: 'جلسة تصوير منتجات', price: 3500, unit: 'جلسة', cat: 'تصوير', costing: {
      direct: [ { key: 'video', label: 'مصور', amount: 700 }, { key: 'equipment', label: 'خلفيات', amount: 250 } ],
      indirect: [ { key: 'rent', label: 'إيجار', amount: 350 }, { key: 'electricity', label: 'كهربا', amount: 90 }, { key: 'lighting', label: 'إضاءة', amount: 140 }, { key: 'depreciation', label: 'إهلاك', amount: depShare } ],
      markupPct: 70 } },
    { key: 's4', name: 'إنفوجرافيك موشن', price: 4500, unit: 'فيديو', cat: 'فيديو', costing: {
      direct: [ { key: 'design', label: 'تصميم', amount: 1000 }, { key: 'video', label: 'موشن', amount: 1600 } ],
      indirect: [ { key: 'rent', label: 'إيجار', amount: 350 }, { key: 'internet', label: 'إنترنت', amount: 180 }, { key: 'electricity', label: 'كهربا', amount: 70 }, { key: 'depreciation', label: 'إهلاك', amount: round2(depShare * 0.7) } ],
      markupPct: 45 } },
    { key: 's5', name: 'إدارة حملات (ميديا باينج)', price: 2500, unit: 'شهر', cat: 'إدارة حملات', costing: {
      direct: [], indirect: [ { key: 'rent', label: 'إيجار', amount: 300 }, { key: 'internet', label: 'أدوات', amount: 220 }, { key: 'electricity', label: 'كهربا', amount: 70 } ], markupPct: 0 } },
    { key: 'ads', name: 'ميزانية إعلانات (عهدة عميل)', price: 0, unit: 'مبلغ', cat: 'إدارة حملات', isAdBudget: true, costing: {} },
  ]
  const serviceMap = new Map()
  for (const s of serviceDefs) {
    const r = await create('services', {
      name: s.name, price: s.price, unit: s.unit, categoryId: scMap[s.cat] ?? null,
      description: '', isAdBudget: Boolean(s.isAdBudget), costing: s.costing ?? {},
    })
    serviceMap.set(s.key, { id: r.id, ...s })
  }
  console.log(`  + services: ${serviceDefs.length} (منها بند ميزانية إعلانات)`)

  /* ---------- 7) الفريلانسرز ---------- */
  const vendorDefs = [
    { key: 'v1', name: 'سارة (موديل)', specialty: 'موديل', defaultRate: 1200 },
    { key: 'v2', name: 'كريم (مصور فيديو)', specialty: 'تصوير ومونتاج', defaultRate: 900 },
    { key: 'v3', name: 'عمر (مونتير)', specialty: 'تصوير ومونتاج', defaultRate: 700 },
    { key: 'v4', name: 'لينا (مصممة)', specialty: 'تصميم جرافيك', defaultRate: 2200 },
  ]
  const vendorMap = new Map()
  for (const v of vendorDefs) {
    const r = await create('vendors', { name: v.name, phone: '', specialty: v.specialty, defaultRate: v.defaultRate, notes: '' })
    vendorMap.set(v.key, r.id)
  }
  console.log(`  + vendors: ${vendorDefs.length}`)

  /* ---------- 8) الموظفون + حركات كشف ---------- */
  const empDefs = [
    { key: 'e1', name: 'محمود (مبيعات)', baseSalary: 6000, commissionRate: 0, targetBonus: { enabled: true, metric: 'count', target: 6, bonus: 2500 } },
    { key: 'e2', name: 'نورا (مبيعات)', baseSalary: 6500, commissionRate: 5, targetBonus: { enabled: true, metric: 'value', target: 40000, bonus: 3000 } },
    { key: 'e3', name: 'يوسف (تنفيذي حسابات)', baseSalary: 7000, commissionRate: 0, targetBonus: { enabled: false } },
  ]
  const empMap = new Map()
  for (const e of empDefs) {
    const r = await create('employees', { name: e.name, phone: '', email: '', address: '', baseSalary: e.baseSalary, commissionRate: e.commissionRate, notes: 'تجريبي', targetBonus: e.targetBonus })
    empMap.set(e.key, { id: r.id, name: e.name })
  }
  for (const ek of ['e1', 'e2', 'e3']) {
    const emp = empMap.get(ek)
    for (const m of ['2026-06', '2026-07']) {
      await create('employeeEntries', { employeeId: emp.id, employeeName: emp.name, type: 'salary', amount: empDefs.find((x) => x.key === ek).baseSalary, date: `${m}-28`, note: '', paid: true, paidDate: `${m}-28`, voucherNumber: null, expenseId: null })
    }
    await create('employeeEntries', { employeeId: emp.id, employeeName: emp.name, type: 'salary', amount: empDefs.find((x) => x.key === ek).baseSalary, date: '2026-08-28', note: '', paid: false, paidDate: null, voucherNumber: null, expenseId: null })
  }
  await create('employeeEntries', { employeeId: empMap.get('e1').id, employeeName: 'محمود (مبيعات)', type: 'bonus', amount: 1500, date: '2026-07-28', note: 'أداء ممتاز', paid: true, paidDate: '2026-07-28', voucherNumber: null, expenseId: null })
  await create('employeeEntries', { employeeId: empMap.get('e2').id, employeeName: 'نورا (مبيعات)', type: 'deduction', amount: 400, date: '2026-08-10', note: 'تأخيرات', paid: false, paidDate: null, voucherNumber: null, expenseId: null })
  console.log('  + employees: 3 · employeeEntries: 11 (مرتبات/بونص/خصم — منها معلّق)')

  /* ---------- 9) العملاء ---------- */
  const clientDefs = [
    { name: 'كافيه لاڤيدا', emp: 'e1', act: 0 },
    { name: 'جيم باور', emp: 'e1', act: 1 },
    { name: 'مطعم بيت الكبدة', emp: 'e2', act: 0 },
    { name: 'براند ملابس URBAN', emp: 'e2', act: 2 },
    { name: 'عيادة سمايل', emp: 'e1', act: 3 },
    { name: 'أكاديمي كودرز', emp: 'e2', act: 4 },
    { name: 'شركة نون (إعلانات)', emp: 'e3', act: 2 },
  ]
  const activityRows = (await getDocs(query(S('activityTypes'), where('demoSeed', '==', true)))).docs
  const clientIds = []
  for (const c of clientDefs) {
    const r = await create('clients', {
      name: c.name, phone: '', businessName: c.name,
      activityTypeId: activityRows[c.act]?.id ?? null,
      employeeId: empMap.get(c.emp).id, secondEmployeeId: null, notes: 'تجريبي',
      totalInvoiced: 0, totalPaid: 0, balance: 0, invoicesCount: 0,
    })
    clientIds.push(r.id)
  }
  console.log(`  + clients: ${clientDefs.length}`)

  /* ---------- 10) الفواتير — تشكيلة كاملة ---------- */
  // pay: full | partial | none | over    tax: bool    ad: مبلغ ميزانية إعلانات    cancel: bool
  const plan = [
    { s: 's1', qty: 1, e: 'e1', c: 0, m: '2026-06', jc: [['model','v1',1300],['video','v2',900],['video','v3',600]], pay: 'full' },
    { s: 's3', qty: 2, e: 'e1', c: 1, m: '2026-06', jc: [['video','v2',1500]], pay: 'full' },
    { s: 's2', qty: 1, e: 'e2', c: 2, m: '2026-06', jc: [['design','v4',2400],['video','v3',2100],['model','v1',1600]], pay: 'partial' },
    { s: 's4', qty: 1, e: 'e2', c: 3, m: '2026-06', jc: [['design','v4',1000],['video','v3',1700]], pay: 'full', tax: true },
    { s: 's1', qty: 1, e: 'e1', c: 4, m: '2026-06', jc: [['model','v1',1200],['video','v2',850]], pay: 'none' },
    { s: 's5', qty: 1, e: 'e3', c: 6, m: '2026-06', jc: [], pay: 'full', ad: 15000 },
    { s: 's1', qty: 2, e: 'e2', c: 0, m: '2026-07', jc: [['model','v1',2600],['video','v2',1800],['video','v3',1200]], pay: 'full' },
    { s: 's3', qty: 1, e: 'e2', c: 1, m: '2026-07', jc: [['video','v2',800]], pay: 'partial' },
    { s: 's2', qty: 1, e: 'e1', c: 2, m: '2026-07', jc: [['design','v4',2600],['video','v3',2000],['model','v1',1500]], pay: 'full', tax: true },
    { s: 's4', qty: 2, e: 'e1', c: 3, m: '2026-07', jc: [['design','v4',2000],['video','v3',3400]], pay: 'full' },
    { s: 's1', qty: 1, e: 'e2', c: 4, m: '2026-07', jc: [['model','v1',1400],['video','v2',900]], pay: 'over' },
    { s: 's5', qty: 1, e: 'e3', c: 6, m: '2026-07', jc: [], pay: 'full', ad: 20000 },
    { s: 's3', qty: 1, e: 'e1', c: 0, m: '2026-07', jc: [['video','v2',780]], pay: 'none' },
    { s: 's2', qty: 1, e: 'e1', c: 1, m: '2026-08', jc: [['design','v4',2500],['video','v3',1900],['model','v1',1700]], pay: 'full' },
    { s: 's1', qty: 1, e: 'e2', c: 2, m: '2026-08', jc: [['model','v1',1250],['video','v2',900]], pay: 'partial' },
    { s: 's4', qty: 1, e: 'e2', c: 3, m: '2026-08', jc: [['design','v4',950],['video','v3',1650]], pay: 'none', cancel: true },
    { s: 's1', qty: 3, e: 'e1', c: 4, m: '2026-08', jc: [['model','v1',3600],['video','v2',2700],['video','v3',1800]], pay: 'full' },
    { s: 's3', qty: 2, e: 'e1', c: 5, m: '2026-08', jc: [['video','v2',1450]], pay: 'none' },
    { s: 's5', qty: 1, e: 'e2', c: 0, m: '2026-08', jc: [], pay: 'full' },
    { s: 's2', qty: 1, e: 'e1', c: 1, m: '2026-08', jc: [['design','v4',2450],['video','v3',2050],['model','v1',1550]], pay: 'partial', tax: true },
  ]

  const clientTotals = new Map()
  let seq = 0
  let due = 0, credit = 0, cancelled = 0, taxed = 0
  for (const p of plan) {
    seq += 1
    const svc = serviceMap.get(p.s)
    const emp = empMap.get(p.e)
    const number = `INV-2026-${String(seq).padStart(4, '0')}`
    const date = `${p.m}-${String(4 + seq).padStart(2, '0')}`

    const items = [{ serviceId: svc.id, name: svc.name, price: svc.price, qty: p.qty, isAdBudget: false, total: round2(svc.price * p.qty) }]
    if (p.ad) items.push({ serviceId: serviceMap.get('ads').id, name: 'ميزانية إعلانات', price: p.ad, qty: 1, isAdBudget: true, total: p.ad })

    const subtotal = round2(items.reduce((s, it) => s + it.total, 0))
    const adBudgetTotal = p.ad ? p.ad : 0
    const fees = round2(subtotal - adBudgetTotal)
    const taxRate = p.tax ? 14 : 0
    const taxAmount = round2((fees * taxRate) / 100)
    const total = round2(fees + taxAmount + adBudgetTotal)

    let paidAmount = total
    if (p.pay === 'partial') paidAmount = round2(total * 0.4)
    else if (p.pay === 'none') paidAmount = 0
    else if (p.pay === 'over') paidAmount = round2(total + 500)

    const exp = expectedCostOfItems(items, serviceMap)

    const invRef = await create('invoices', {
      number, date, clientId: clientIds[p.c], clientName: clientDefs[p.c].name,
      employeeId: emp.id, employeeName: emp.name,
      items, subtotal, feesTotal: fees, adBudgetTotal,
      discount: 0, taxEnabled: p.tax || false, taxRate, taxAmount,
      total, paidAmount,
      nextPaymentDate: p.pay === 'partial' || p.pay === 'none' ? `${p.m}-28` : null,
      notes: 'فاتورة تجريبية', cancelled: Boolean(p.cancel),
      cancelledDate: p.cancel ? `${p.m}-28` : null, cancelReason: p.cancel ? 'اختبار الإلغاء' : '',
      expectedCost: exp.total, expectedCostDirect: exp.direct, expectedCostIndirect: exp.indirect, expectedCostBreakdown: exp.lines,
    })

    if (paidAmount > 0) {
      const method = seq % 3 === 0 ? { id: pmBank.id, name: 'InstaPay — CIB', type: 'bank' } : seq % 3 === 1 ? { id: pmCash.id, name: 'نقدي (الخزينة)', type: 'cash' } : { id: pmWallet.id, name: 'فودافون كاش', type: 'wallet' }
      await addDoc(S(`invoices/${invRef.id}/payments`), {
        amount: paidAmount, date, methodId: method.id, methodName: method.name, methodType: method.type,
        ourAccount: '', clientAccount: '', demoSeed: true, createdAt: serverTimestamp(),
      })
    }

    for (const [type, vk, amount] of p.jc) {
      await create('jobCosts', {
        invoiceId: invRef.id, clientId: clientIds[p.c], employeeId: null,
        type, vendorId: vendorMap.get(vk), description: 'تكلفة تجريبية',
        amount, paid: seq % 4 !== 0, paidDate: seq % 4 !== 0 ? date : null, date,
      })
    }

    if (!p.cancel) {
      const t = clientTotals.get(p.c) ?? { invoiced: 0, paid: 0, count: 0 }
      t.invoiced += total; t.paid += paidAmount; t.count += 1
      clientTotals.set(p.c, t)
    }
    if (p.cancel) cancelled += 1
    else if (paidAmount > total + 0.01) credit += 1
    else if (paidAmount < total - 0.01) due += 1
    if (p.tax) taxed += 1
  }
  console.log(`  + invoices: ${seq}  (مدفوعة/جزئية: ${due} مدين · ${credit} دائن · ${cancelled} ملغاة · ${taxed} بضريبة · 2 بميزانية إعلانات)`)

  /* ---------- 11) مصروفات الشركة + إنفاق إعلاني لعميل ---------- */
  const catSalary = (await getDocs(query(S('expenseCategories'), where('system', '==', 'salary')))).docs[0]
  const salaryCatId = catSalary ? catSalary.id : (await create('expenseCategories', { name: 'مرتبات', system: 'salary', isAdSpend: false, archived: false })).id
  const catRent = await create('expenseCategories', { name: 'إيجار', isAdSpend: false, archived: false })
  const catNet = await create('expenseCategories', { name: 'إنترنت واتصالات', isAdSpend: false, archived: false })
  const catPower = await create('expenseCategories', { name: 'كهرباء ومياه', isAdSpend: false, archived: false })
  const catAds = await create('expenseCategories', { name: 'إنفاق إعلاني', isAdSpend: true, archived: false })

  let ex = 0
  for (const m of ['2026-06', '2026-07', '2026-08']) {
    for (const [cid, cname, desc, amt] of [
      [salaryCatId, 'مرتبات', 'مرتبات الفريق', 19500],
      [catRent.id, 'إيجار', 'إيجار الاستوديو', 5000],
      [catNet.id, 'إنترنت واتصالات', 'اشتراك إنترنت + خطوط', 1200],
      [catPower.id, 'كهرباء ومياه', 'فاتورة كهرباء', 700],
    ]) {
      await create('expenses', { categoryId: cid, categoryName: cname, description: desc, amount: amt, date: `${m}-28`, paidBy: 'الشركة', clientId: null, source: 'manual' })
      ex += 1
    }
  }
  /* إنفاق إعلاني مموَّل من ميزانية عميل «شركة نون» */
  await create('expenses', { categoryId: catAds.id, categoryName: 'إنفاق إعلاني', description: 'حملة فيسبوك — يونيو', amount: 9000, date: '2026-06-20', paidBy: 'الشركة', clientId: clientIds[6], source: 'manual' })
  await create('expenses', { categoryId: catAds.id, categoryName: 'إنفاق إعلاني', description: 'حملة إنستجرام — يوليو', amount: 14500, date: '2026-07-18', paidBy: 'الشركة', clientId: clientIds[6], source: 'manual' })
  ex += 2
  console.log(`  + expenseCategories: 5 · expenses: ${ex} (منها 2 إنفاق إعلاني لعميل)`)

  /* ---------- 12) السندات والقيود ---------- */
  let jvSeq = 0
  const jv = async (type, description, date, lines) => {
    if (lines.some((l) => !l[0])) {
      console.log(`  ⚠ سند «${description}» اتخطّى — حساب ناقص في الشجرة`)
      return
    }
    jvSeq += 1
    return create('journalEntries', {
      number: `JV-2026-${String(jvSeq).padStart(4, '0')}`,
      date, type, description, notes: '',
      lines: lines.map((l) => ({ accountId: l[0], debit: round2(l[1] || 0), credit: round2(l[2] || 0) })),
    })
  }
  await jv('opening', 'أرصدة افتتاحية 1 يناير', '2026-01-01', [
    [acc('cash'), 200000, 0], [acc('bank'), 150000, 0], [acc('capital'), 0, 350000],
  ])
  await jv('transfer', 'سحب من البنك للخزينة', '2026-06-05', [[acc('cash'), 30000, 0], [acc('bank'), 0, 30000]])
  await jv('drawing', 'مسحوبات المالك — يونيو', '2026-06-30', [[acc('drawings'), 15000, 0], [acc('cash'), 0, 15000]])
  await jv('payment', 'مصاريف نثرية (سند صرف)', '2026-07-12', [[acc('otherExpense'), 2200, 0], [acc('cash'), 0, 2200]])
  await jv('receipt', 'إيراد متنوع — بيع خردة معدات', '2026-07-22', [[acc('cash'), 3500, 0], [accounts.find((a) => a.code === '42')?.id, 0, 3500]])
  await jv('tax', 'سداد دفعة ضريبة القيمة المضافة', '2026-08-15', [[acc('tax'), 4000, 0], [acc('bank'), 0, 4000]])
  await jv('manual', 'تسوية فرق تقريب', '2026-08-31', [[acc('otherExpense'), 12, 0], [acc('cash'), 0, 12]])
  console.log('  + journalEntries: 7 (افتتاحي / تحويل / مسحوبات / صرف / قبض / ضريبة / يدوي)')

  /* ---------- 13) عروض الأسعار ---------- */
  const qItems = (skey, qty) => {
    const s = serviceMap.get(skey)
    return [{ serviceId: s.id, name: s.name, price: s.price, qty, isAdBudget: false, total: round2(s.price * qty) }]
  }
  const quote = async (n, cIdx, skey, qty, status) => {
    const items = qItems(skey, qty)
    const sub = round2(items.reduce((a, b) => a + b.total, 0))
    const tax = round2(sub * 0.14)
    await create('quotations', {
      number: `QT-2026-${String(n).padStart(4, '0')}`, date: '2026-08-20',
      clientId: clientIds[cIdx], clientName: clientDefs[cIdx].name,
      employeeId: empMap.get('e1').id, employeeName: 'محمود (مبيعات)',
      validUntil: '2026-09-20', items, subtotal: sub, feesTotal: sub, adBudgetTotal: 0,
      discount: 0, taxEnabled: true, taxRate: 14, taxAmount: tax, total: round2(sub + tax),
      notes: '', status,
    })
  }
  await quote(1, 3, 's2', 1, 'draft')
  await quote(2, 5, 's1', 2, 'sent')
  await quote(3, 1, 's4', 1, 'accepted')
  console.log('  + quotations: 3 (مسودة / مُرسل / مقبول)')

  /* ---------- 14) الباقات الشهرية ---------- */
  const retainer = async (name, cIdx, skey, day) => {
    const items = qItems(skey, 1)
    const sub = round2(items.reduce((a, b) => a + b.total, 0))
    await create('retainers', {
      name, clientId: clientIds[cIdx], clientName: clientDefs[cIdx].name,
      employeeId: empMap.get('e2').id, employeeName: 'نورا (مبيعات)',
      startDate: '2026-06-01', endDate: null, dayOfMonth: day,
      items, subtotal: sub, feesTotal: sub, adBudgetTotal: 0,
      discount: 0, taxEnabled: false, taxRate: 0, taxAmount: 0, total: sub,
      active: true, lastGeneratedMonth: null,
    })
  }
  await retainer('باقة كافيه لاڤيدا الشهرية', 0, 's2', 1)
  await retainer('باقة جيم باور الشهرية', 1, 's5', 5)
  console.log('  + retainers: 2 (مستحقة الفوترة الشهر ده)')

  /* ---------- 15) الحملات الإعلانية ---------- */
  await create('campaigns', {
    name: 'حملة رمضان — فيسبوك وإنستجرام', clientId: clientIds[6], clientName: clientDefs[6].name,
    employeeId: empMap.get('e2').id, employeeName: 'نورا (مبيعات)',
    budget: 25000, feeMode: 'percent', feePct: 15, feeFixed: 0, feeFrom: 'fromBudget',
    startDate: '2026-08-05', days: 30, endDate: '2026-09-03', status: 'planned', invoiceId: null, notes: 'حملة تجريبية',
  })
  await create('campaigns', {
    name: 'حملة إطلاق منتج — تيك توك', clientId: clientIds[3], clientName: clientDefs[3].name,
    employeeId: empMap.get('e1').id, employeeName: 'محمود (مبيعات)',
    budget: 12000, feeMode: 'fixed', feePct: 0, feeFixed: 2500, feeFrom: 'onTop',
    startDate: '2026-08-20', days: 14, endDate: '2026-09-02', status: 'planned', invoiceId: null, notes: '',
  })
  console.log('  + campaigns: 2 (نسبة من الميزانية / مبلغ ثابت فوقها)')

  /* ---------- أرصدة العملاء + العدّاد ---------- */
  for (const [ci, t] of clientTotals) {
    await setDoc(doc(db, 'clients', clientIds[ci]), {
      totalInvoiced: round2(t.invoiced), totalPaid: round2(t.paid),
      balance: round2(t.invoiced - t.paid), invoicesCount: t.count, updatedAt: serverTimestamp(),
    }, { merge: true })
  }
  const bumpCounter = async (key, to) => {
    const cs = await getDoc(doc(db, 'counters', key))
    const cur = cs.exists() ? Number(cs.data().seq ?? 0) : 0
    if (cur < to) await setDoc(doc(db, 'counters', key), { seq: to, year: 2026 }, { merge: true })
  }
  await bumpCounter('invoices-2026', seq)
  await bumpCounter('vouchers-2026', jvSeq)
  await bumpCounter('quotations-2026', 3)

  console.log(`\n✓ خلص البذر الشامل. جرّب كل صفحة:`)
  console.log('  • المدين والدائن → المفروض تلاقي فواتير مدينة ودائنة')
  console.log('  • الإقرار الضريبي → ضريبة مخرجات من 4 فواتير')
  console.log('  • ميزانية الإعلانات → عميل «شركة نون»')
  console.log('  • الحسابات (ميزان/دخل/مركز مالي/تدفقات) · الخزينة · القيود والسندات')
  console.log('  • العروض (3) · الباقات (2 مستحقة) · المعدات + صيانة · كشوف الموظفين')
  console.log('\n  للحذف:  node scripts/seed-demo.mjs --clean --email … --password …')
  process.exit(0)
}

main().catch((e) => {
  console.error('\n✖ خطأ:', e.code || e.message)
  if (String(e.code).includes('auth/')) console.error('  تأكد من الإيميل/الباسورد ودور «مدير».')
  if (String(e.code).includes('permission')) console.error('  الحساب لازم دوره «مدير».')
  process.exit(1)
})
