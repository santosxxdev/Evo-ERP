import { COL, createDoc, deleteDocById, updateDocById } from './db'
import { db } from './firebase'
import { collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore'
import standardChartOfAccounts from './standardChartOfAccounts.json'

export async function cleanupDuplicateAccounts(accounts) {
  if (!accounts || accounts.length === 0) return
  const seenCodes = new Map()
  const duplicateIds = []

  for (const account of accounts) {
    const codeStr = String(account.code)
    if (!seenCodes.has(codeStr)) {
      seenCodes.set(codeStr, account)
    } else {
      const first = seenCodes.get(codeStr)
      if (!first.role && account.role) {
        duplicateIds.push(first.id)
        seenCodes.set(codeStr, account)
      } else {
        duplicateIds.push(account.id)
      }
    }
  }

  for (const dupId of duplicateIds) {
    await deleteDocById(ACCOUNTS_COL, dupId).catch(() => {})
  }
}

export const ACCOUNTS_COL = 'accounts'

/** أنواع الحسابات وطبيعة رصيدها */
export const ACCOUNT_TYPES = {
  asset: { normal: 'debit' },
  liability: { normal: 'credit' },
  equity: { normal: 'credit' },
  revenue: { normal: 'credit' },
  expense: { normal: 'debit' },
}

export function getNormalBalance(account) {
  if (!account) return 'debit'
  if (account.normalBalance === 'debit' || account.normalBalance === 'credit') {
    return account.normalBalance
  }
  if (account.role === 'accumDep') return 'credit'
  if (account.role === 'drawings') return 'debit'
  const root = String(account.code || '').charAt(0)
  if (root === '1' || root === '5' || root === '6') return 'debit'
  if (root === '2' || root === '3' || root === '4' || root === '7') return 'credit'
  return ACCOUNT_TYPES[account.type]?.normal ?? 'debit'
}

/**
 * شجرة الحسابات القياسية ذات الـ 6 مستويات المستخرجة من ملف الإكسيل:
 * (367 حساباً موزعة على 6 مستويات ومقسمة على 8 مجموعات رئيسية).
 */
export const DEFAULT_ACCOUNTS = standardChartOfAccounts

export const DEFAULT_PAYMENT_METHODS = [
  { name: 'الخزينة الرئيسية', type: 'cash', accountCode: '1-01-01-01-01-001' },
]

/**
 * حسابات النظام الافتراضية الناقصة من الشجرة الحالية.
 * تُفحص فقط الحسابات التي تحمل دوراً وظيفياً أساسياً بالنظام (role).
 */
export function missingDefaults(accounts) {
  const rolesInAccounts = new Set(accounts.map((account) => account.role).filter(Boolean))
  const codesInAccounts = new Set(accounts.map((account) => String(account.code)))
  return DEFAULT_ACCOUNTS.filter((account) => {
    if (!account.role) return false
    return !rolesInAccounts.has(account.role) && !codesInAccounts.has(String(account.code))
  })
}

/**
 * حسابات موجودة بالكود لكن ينقصها الدور الوظيفي — تحدث عندما يُضاف دور
 * لحساب افتراضي بعد زرع الشجرة. بدون الدور لا يجده النظام فيسقط القيد.
 */
export function accountsMissingRole(accounts) {
  return accounts.filter((account) => {
    const preset = DEFAULT_ACCOUNTS.find((item) => item.code === String(account.code))
    return preset?.role && !account.role
  })
}

/** زرع الشجرة القياسية ذات الـ 6 مستويات باستخدام دفعات Firestore */
export async function seedAccounts(existingAccounts = []) {
  const byCode = new Map()
  const existingByCode = new Map()
  for (const account of existingAccounts) {
    existingByCode.set(String(account.code), account)
  }

  // تقسيم الـ 367 حساباً إلى دفعات (Chunks of 400 docs)
  const chunks = []
  let currentChunk = []
  for (const account of DEFAULT_ACCOUNTS) {
    currentChunk.push(account)
    if (currentChunk.length >= 400) {
      chunks.push(currentChunk)
      currentChunk = []
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk)

  for (const chunk of chunks) {
    const batch = writeBatch(db)
    for (const account of chunk) {
      const codeStr = String(account.code)
      const existing = existingByCode.get(codeStr)
      const payload = {
        code: account.code,
        name: account.name,
        nameEn: account.nameEn ?? '',
        level: account.level ?? (account.code.split('-').length),
        type: account.type,
        categoryName: account.categoryName ?? '',
        isGroup: Boolean(account.isGroup),
        isPosting: Boolean(account.isPosting),
        role: account.role ?? null,
        normalBalance: account.normalBalance ?? null,
        parentCode: account.parentCode ?? null,
        notes: account.notes ?? '',
        archived: false,
      }

      if (existing?.id) {
        const ref = doc(db, ACCOUNTS_COL, existing.id)
        batch.update(ref, payload)
        byCode.set(codeStr, existing.id)
      } else {
        const ref = doc(collection(db, ACCOUNTS_COL))
        batch.set(ref, { ...payload, createdAt: serverTimestamp() })
        byCode.set(codeStr, ref.id)
      }
    }
    await batch.commit()
  }

  return byCode
}

export async function seedMissingAccounts(accounts) {
  const missing = missingDefaults(accounts)

  for (const account of missing) {
    await createDoc(ACCOUNTS_COL, {
      code: account.code,
      name: account.name,
      nameEn: account.nameEn ?? '',
      level: account.level ?? (account.code.split('-').length),
      type: account.type,
      categoryName: account.categoryName ?? '',
      isGroup: Boolean(account.isGroup),
      isPosting: Boolean(account.isPosting),
      role: account.role ?? null,
      normalBalance: account.normalBalance ?? null,
      parentCode: account.parentCode ?? null,
      notes: account.notes ?? '',
      archived: false,
    })
  }

  /* ترقيع الأدوار الناقصة على الحسابات القائمة */
  const roleless = accountsMissingRole(accounts)
  for (const account of roleless) {
    const preset = DEFAULT_ACCOUNTS.find((item) => item.code === String(account.code))
    await updateDocById(ACCOUNTS_COL, account.id, { role: preset.role })
  }

  return missing.length + roleless.length
}

/**
 * أول كود فرعي شاغر تحت حساب أب: يدعم نمط الـ 6 مستويات بالواصلات
 * المستوى 1: 1 إلى 8
 * المستوى 2: 1-01
 * المستوى 3: 1-01-01
 * المستوى 4: 1-01-01-01
 * المستوى 5: 1-01-01-01-01
 * المستوى 6: 1-01-01-01-01-001 (ثلاث خانات)
 */
export function nextChildCode(accounts, parentCode) {
  const used = new Set(accounts.map((account) => String(account.code)))
  if (!parentCode) {
    for (let i = 1; i <= 9; i++) {
      if (!used.has(String(i))) return String(i)
    }
    return String(accounts.length + 1)
  }
  const prefix = String(parentCode)
  const segments = prefix.split('-')
  const isLevel5Parent = segments.length === 5 // المستوى التالي سيكون السادس (3 أرقام: 001, 002...)

  const padDigits = isLevel5Parent ? 3 : 2
  for (let i = 1; i <= 999; i++) {
    const suffix = String(i).padStart(padDigits, '0')
    const candidate = `${prefix}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `${prefix}-01`
}

export function accountLabel(account, lang) {
  if (!account) return '—'
  return lang === 'en' && account.nameEn ? account.nameEn : account.name
}

/** بناء شجرة متداخلة من قائمة مسطّحة معتمدة على parentCode */
export function buildTree(accounts) {
  if (!accounts || !Array.isArray(accounts)) return []
  const sorted = [...accounts].sort((a, b) =>
    String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true })
  )
  const knownCodes = new Set(sorted.map((account) => String(account.code)))
  const children = new Map()

  for (const account of sorted) {
    const parentCode = account.parentCode ? String(account.parentCode) : null
    const accountCode = String(account.code)
    const key = parentCode && knownCodes.has(parentCode) && parentCode !== accountCode ? parentCode : '__root__'
    children.set(key, [...(children.get(key) ?? []), account])
  }

  const visited = new Set()
  const attach = (account, depth) => {
    const codeKey = String(account.code)
    if (visited.has(codeKey)) {
      return { ...account, depth, children: [] }
    }
    visited.add(codeKey)
    const childNodes = (children.get(codeKey) ?? []).map((child) => attach(child, depth + 1))
    visited.delete(codeKey)
    return {
      ...account,
      depth,
      level: account.level || (depth + 1),
      children: childNodes,
    }
  }

  return (children.get('__root__') ?? []).map((account) => attach(account, 0))
}

export function flattenTree(nodes, output = [], visited = new Set()) {
  if (!nodes || !Array.isArray(nodes)) return output
  for (const node of nodes) {
    const key = String(node.id || node.code)
    if (visited.has(key)) continue
    visited.add(key)
    output.push(node)
    flattenTree(node.children ?? [], output, visited)
  }
  return output
}

/** إيجاد حساب بدوره الوظيفي — مع إعطاء الأولوية لحسابات الحركة غير التجميعية */
export function byRole(accounts, role) {
  if (!accounts || !Array.isArray(accounts)) return null
  const nonGroup = accounts.find((account) => account.role === role && !account.isGroup)
  if (nonGroup) return nonGroup
  return accounts.find((account) => account.role === role) ?? null
}

/**
 * حسابات «الخزينة»: كل حسابات النقدية والبنوك عبر جميع الخزائن فقط —
 * الأدوار cash/bank + أي حساب مرتبط بطريقة تحصيل. تُستخدم في سندات
 * الصرف والقبض وشاشة المصروفات بدل عرض شجرة الحسابات كاملة.
 */
export function treasuryAccounts(accounts, paymentMethods = []) {
  const linked = new Set(paymentMethods.map((method) => method.accountId).filter(Boolean))
  return accounts.filter(
    (account) =>
      !account.isGroup &&
      (account.role === 'cash' ||
        account.role === 'bank' ||
        account.role === 'adTreasury' ||
        linked.has(account.id) ||
        String(account.code).startsWith('1-01-01') ||
        String(account.code).startsWith('1-01-02')),
  )
}

/**
 * بناء شجرة حسابات نظيفة ومكتملة تشمل كافة الحسابات الفرعية والأستاذ المساعد:
 * - الحسابات الفرعية للموظفين (مستحقات وسلف وكشف شامل)
 * - الحسابات الفرعية للعملاء
 * - الحسابات الفرعية للموردين
 */
export function buildCleanAccounts(accounts = [], clients = [], employees = [], vendors = []) {
  const empMap = new Map((employees || []).map((e) => [e.id, e]))
  const map = new Map()
  for (const account of accounts) {
    const codeKey = String(account.code)
    if (codeKey === '11010201' || (account.name || '').includes('البنكي الرئيسي') || (account.name || '').includes('البنكى الرئيسى')) {
      continue
    }
    if (!map.has(codeKey)) {
      map.set(codeKey, account)
    } else {
      const existing = map.get(codeKey)
      if (!existing.role && account.role) {
        map.set(codeKey, account)
      }
    }
  }

  const baseList = Array.from(map.values())

  // دالة مساعدة لتوليد كود فرعي متوافق
  const makeChildCode = (parentCode, index, pad = 3) => {
    const pStr = String(parentCode)
    if (pStr.includes('-')) {
      return `${pStr}-${String(index).padStart(pad, '0')}`
    }
    return `${pStr}${String(index).padStart(Math.min(pad, 2), '0')}`
  }

  // 1 — إضافة شجرة العملاء
  let recIdx = baseList.findIndex(
    (a) =>
      a.role === 'receivableGroup' ||
      String(a.code) === '1-01-03-01-01' ||
      (a.role === 'receivable' && a.isGroup) ||
      String(a.code) === '110201' ||
      String(a.code) === '112' ||
      String(a.code).startsWith('110201'),
  )
  if (recIdx === -1) {
    recIdx = baseList.findIndex((a) => a.role === 'receivable')
  }

  if (recIdx !== -1 && clients.length > 0) {
    baseList[recIdx] = { ...baseList[recIdx], isGroup: true }
    const recCode = String(baseList[recIdx].code)

    const parentClients = clients.filter((c) => c.isParent || (!c.parentId && clients.some((sub) => sub.parentId === c.id)))
    const standaloneClients = clients.filter((c) => !c.isParent && !c.parentId && !clients.some((sub) => sub.parentId === c.id))

    let pIndex = 1
    for (const pClient of parentClients) {
      const pCode = makeChildCode(recCode, pIndex, 3)
      pIndex += 1
      const childBranches = clients.filter((c) => c.parentId === pClient.id)

      baseList.push({
        id: `client-${pClient.id}`,
        code: pCode,
        name: `${pClient.name} (عميل رئيسي)`,
        nameEn: pClient.businessName || '',
        type: 'asset',
        isGroup: true,
        parentCode: recCode,
        clientId: pClient.id,
        isClientNode: true,
        isParentClient: true,
        subLedgerType: 'client',
        subLedgerId: pClient.id,
        category: 'client',
        badge: 'أستاذ مساعد عميل',
      })

      let bIndex = 1
      for (const bClient of childBranches) {
        const bCode = makeChildCode(pCode, bIndex, 2)
        bIndex += 1

        baseList.push({
          id: `client-${bClient.id}`,
          code: bCode,
          name: `${bClient.name} (فرع)`,
          nameEn: bClient.businessName || '',
          type: 'asset',
          isGroup: false,
          parentCode: pCode,
          clientId: bClient.id,
          isClientNode: true,
          isChildClient: true,
          subLedgerType: 'client',
          subLedgerId: bClient.id,
          category: 'client',
          badge: 'أستاذ مساعد عميل (فرع)',
        })
      }
    }

    for (const sClient of standaloneClients) {
      const sCode = makeChildCode(recCode, pIndex, 3)
      pIndex += 1

      baseList.push({
        id: `client-${sClient.id}`,
        code: sCode,
        name: sClient.name,
        nameEn: sClient.businessName || '',
        type: 'asset',
        isGroup: false,
        parentCode: recCode,
        clientId: sClient.id,
        isClientNode: true,
        subLedgerType: 'client',
        subLedgerId: sClient.id,
        category: 'client',
        badge: 'أستاذ مساعد عميل',
      })
    }
  }

  // 2 — إضافة حسابات الموظفين تفصيليًا تحت مستحقات الموظفين (دائنون 2-01-03-01-01 أو 210201)
  let empPayIdx = baseList.findIndex(
    (a) =>
      a.role === 'employeePayableGroup' ||
      String(a.code) === '2-01-03-01-01' ||
      (a.role === 'employeePayable' && a.isGroup) ||
      String(a.code) === '210201',
  )
  if (empPayIdx === -1) {
    empPayIdx = baseList.findIndex((a) => a.role === 'employeePayable')
  }

  if (empPayIdx !== -1 && employees.length > 0) {
    baseList[empPayIdx] = { ...baseList[empPayIdx], isGroup: true }
    const empPayCode = String(baseList[empPayIdx].code)
    let eIndex = 1
    for (const emp of employees) {
      const eCode = makeChildCode(empPayCode, eIndex, 3)
      eIndex += 1
      baseList.push({
        id: `emp-payable-${emp.id}`,
        code: eCode,
        name: `${emp.name} (مستحقات موظف)`,
        type: 'liability',
        isGroup: false,
        parentCode: empPayCode,
        employeeId: emp.id,
        subLedgerType: 'employee',
        subLedgerId: emp.id,
        isEmployeeNode: true,
        category: 'employee',
        badge: 'أستاذ مساعد موظف (مستحقات)',
      })
    }
  }

  // 3 — إضافة حسابات الموظفين تفصيليًا تحت عهد وسلف الموظفين (أصول 1-01-06-02-01 أو 110203)
  let empAdvIdx = baseList.findIndex(
    (a) =>
      a.role === 'employeeAdvance' ||
      String(a.code) === '1-01-06-02-01' ||
      String(a.code) === '1-01-06-02' ||
      String(a.code) === '110203',
  )
  if (empAdvIdx !== -1 && employees.length > 0) {
    baseList[empAdvIdx] = { ...baseList[empAdvIdx], isGroup: true }
    const empAdvCode = String(baseList[empAdvIdx].code)
    let eIndex = 1
    for (const emp of employees) {
      const eCode = makeChildCode(empAdvCode, eIndex, 3)
      eIndex += 1
      baseList.push({
        id: `emp-advance-${emp.id}`,
        code: eCode,
        name: `${emp.name} (عهدة/سلفة)`,
        type: 'asset',
        isGroup: false,
        parentCode: empAdvCode,
        employeeId: emp.id,
        subLedgerType: 'employee',
        subLedgerId: emp.id,
        isEmployeeNode: true,
        category: 'employee',
        badge: 'أستاذ مساعد موظف (سلفة)',
      })
    }
  }

  // 4 — إضافة كشف حساب موظف شامل (يجمع كل الحركات المالية للموظف)
  if (employees.length > 0) {
    for (const emp of employees) {
      baseList.push({
        id: `emp-full-${emp.id}`,
        code: `EMP-${emp.employeeCode || String(emp.id).slice(-4).toUpperCase()}`,
        name: `${emp.name} (كشف حساب موظف شامل)`,
        type: 'liability',
        isGroup: false,
        parentCode: empPayIdx !== -1 ? String(baseList[empPayIdx].code) : null,
        employeeId: emp.id,
        subLedgerType: 'employee',
        subLedgerId: emp.id,
        isEmployeeFullNode: true,
        category: 'employee',
        badge: 'كشف حساب موظف شامل',
      })
    }
  }

  // 5 — إضافة حسابات الموردين تفصيليًا تحت الموردين (دائنون 2-01-01-01-01 أو 211)
  let vendorIdx = baseList.findIndex(
    (a) =>
      a.role === 'vendorPayableGroup' ||
      String(a.code) === '2-01-01-01-01' ||
      (a.role === 'vendorPayable' && a.isGroup) ||
      String(a.code) === '211' ||
      String(a.code) === '2101' ||
      String(a.code) === '210101' ||
      String(a.code) === '21101' ||
      String(a.code).startsWith('211') ||
      String(a.code).startsWith('2101'),
  )
  if (vendorIdx === -1) {
    vendorIdx = baseList.findIndex((a) => a.role === 'vendorPayable')
  }

  if (vendors.length > 0) {
    if (vendorIdx === -1) {
      const autoVendorGroup = {
        id: 'group-vendor-2-01-01-01-01-auto',
        code: '2-01-01-01-01',
        name: 'حسابات الموردين والدائنين التجاريين',
        type: 'liability',
        isGroup: true,
        parentCode: '2-01-01-01',
        role: 'vendorPayableGroup',
      }
      baseList.push(autoVendorGroup)
      vendorIdx = baseList.length - 1
    } else {
      baseList[vendorIdx] = { ...baseList[vendorIdx], isGroup: true }
    }

    const vendorCode = String(baseList[vendorIdx].code)
    let vIndex = 1
    for (const vendor of vendors) {
      const vCode = makeChildCode(vendorCode, vIndex, 3)
      vIndex += 1
      baseList.push({
        id: `vendor-${vendor.id}`,
        code: vCode,
        name: vendor.name,
        type: 'liability',
        isGroup: false,
        parentCode: vendorCode,
        vendorId: vendor.id,
        subLedgerType: 'vendor',
        subLedgerId: vendor.id,
        isVendorNode: true,
        category: 'vendor',
        badge: 'أستاذ مساعد مورد',
      })
    }
  }

  return baseList
}

export { COL }

