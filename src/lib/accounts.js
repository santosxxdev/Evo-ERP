import { COL, createDoc, deleteDocById, updateDocById } from './db'

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

export function getNormalBalance(account) {
  if (!account) return 'debit'
  if (account.normalBalance === 'debit' || account.normalBalance === 'credit') {
    return account.normalBalance
  }
  if (account.role === 'accumDep') return 'credit'
  if (account.role === 'drawings') return 'debit'
  return ACCOUNT_TYPES[account.type]?.normal ?? 'debit'
}

/** زرع الشجرة الافتراضية بدون تكرار المستندات */
export async function seedAccounts(existingAccounts = []) {
  const byCode = new Map()
  const existingByCode = new Map()
  for (const account of existingAccounts) {
    if (String(account.code) === '11010201' || account.name === 'الحساب البنكي الرئيسي') {
      await deleteDocById(ACCOUNTS_COL, account.id).catch(() => {})
      continue
    }
    existingByCode.set(String(account.code), account)
  }

  for (const account of DEFAULT_ACCOUNTS) {
    const codeStr = String(account.code)
    const existing = existingByCode.get(codeStr)
    const payload = {
      code: account.code,
      name: account.name,
      nameEn: account.nameEn ?? '',
      type: account.type,
      isGroup: Boolean(account.isGroup),
      role: account.role ?? null,
      normalBalance: account.normalBalance ?? null,
      parentCode: account.parent ?? null,
      archived: false,
    }

    if (existing?.id) {
      await updateDocById(ACCOUNTS_COL, existing.id, payload)
      byCode.set(codeStr, existing.id)
    } else {
      const created = await createDoc(ACCOUNTS_COL, payload)
      byCode.set(codeStr, created.id)
    }
  }

  if (existingAccounts.length > 0) {
    await cleanupDuplicateAccounts(existingAccounts)
  }

  return byCode
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

/**
 * شجرة الحسابات الافتراضية لشركة ميديا — بنفس مستويات ترقيم دفترة
 * (1 رئيسي → 11 مجموعة → 111 مجموعة فرعية → 1111 حساب تفصيلي).
 * `role` يسمح للنظام بإيجاد الحساب تلقائيًا حتى لو غيّر المستخدم الاسم أو الكود.
 */
export const DEFAULT_ACCOUNTS = [
  { code: '1', name: 'الأصول', nameEn: 'Assets', type: 'asset', isGroup: true },

  { code: '11', name: 'الأصول المتداولة', nameEn: 'Current assets', type: 'asset', isGroup: true, parent: '1' },
  { code: '1101', name: 'النقدية وما في حكمها', nameEn: 'Cash & cash equivalents', type: 'asset', isGroup: true, parent: '11' },
  { code: '110101', name: 'الخزينة الرئيسية', nameEn: 'Main cash treasury', type: 'asset', parent: '1101', role: 'cash' },
  { code: '110102', name: 'البنوك والمحافظ الرقمية', nameEn: 'Banks & digital wallets', type: 'asset', isGroup: true, parent: '1101' },
  { code: '11010202', name: 'محافظ فودافون كاش والرقمية', nameEn: 'E-Wallets & Mobile cash', type: 'asset', parent: '110102' },

  { code: '1102', name: 'العملاء والأرصدة المدينة', nameEn: 'Receivables & debtors', type: 'asset', isGroup: true, parent: '11' },
  { code: '110201', name: 'العملاء - مدينون تجاريون', nameEn: 'Accounts receivable - Trade', type: 'asset', parent: '1102', role: 'receivable' },
  { code: '110202', name: 'دفعات مقدمة للموردين', nameEn: 'Vendor advance prepayments', type: 'asset', parent: '1102', role: 'vendorAdvance' },
  { code: '110203', name: 'عهد وسلف الموظفين', nameEn: 'Employee advances & loans', type: 'asset', parent: '1102' },
  { code: '110204', name: 'أوراق قبض', nameEn: 'Notes receivable', type: 'asset', parent: '1102' },
  { code: '110205', name: 'مصاريف مدفوعة مقدماً', nameEn: 'Prepaid expenses', type: 'asset', parent: '1102' },
  { code: '110206', name: 'تأمينات وأمانات لدى الغير', nameEn: 'Deposits held by others', type: 'asset', parent: '1102' },

  { code: '1103', name: 'المخزون', nameEn: 'Inventory', type: 'asset', parent: '11', role: 'inventory' },
  { code: '1104', name: 'ضريبة المدخلات المستحقة', nameEn: 'Input tax receivable', type: 'asset', parent: '11', role: 'taxReceivable' },

  { code: '12', name: 'الأصول غير المتداولة', nameEn: 'Non-current assets', type: 'asset', isGroup: true, parent: '1' },
  { code: '1201', name: 'الأصول الثابتة', nameEn: 'Fixed assets', type: 'asset', isGroup: true, parent: '12' },
  { code: '120101', name: 'أجهزة كمبيوتر ومعدات تصوير', nameEn: 'Equipment & cameras', type: 'asset', parent: '1201', role: 'equipment' },
  { code: '120102', name: 'أثاث وتجهيزات مكتبية', nameEn: 'Furniture & fixtures', type: 'asset', parent: '1201' },
  { code: '120103', name: 'تحسينات المقر المستأجر', nameEn: 'Leased premises improvements', type: 'asset', parent: '1201' },

  { code: '1202', name: 'مجمع إهلاك الأصول الثابتة', nameEn: 'Accumulated depreciation', type: 'asset', isGroup: true, parent: '12' },
  { code: '120201', name: 'مجمع إهلاك الأجهزة والمعدات', nameEn: 'Accum. Depr. - Equipment', type: 'asset', parent: '1202', role: 'accumDep', normalBalance: 'credit' },
  { code: '120202', name: 'مجمع إهلاك الأثاث والتجهيزات', nameEn: 'Accum. Depr. - Furniture', type: 'asset', parent: '1202', normalBalance: 'credit' },

  { code: '1203', name: 'الأصول غير الملموسة', nameEn: 'Intangible assets', type: 'asset', isGroup: true, parent: '12' },
  { code: '120301', name: 'برمجيات وحسابات تراخيص', nameEn: 'Software & digital licenses', type: 'asset', parent: '1203' },

  { code: '2', name: 'الالتزامات', nameEn: 'Liabilities', type: 'liability', isGroup: true },
  { code: '21', name: 'الالتزامات المتداولة', nameEn: 'Current liabilities', type: 'liability', isGroup: true, parent: '2' },
  { code: '2101', name: 'الموردون والدائنون التجاريون', nameEn: 'Accounts payable - Trade vendors', type: 'liability', parent: '21', role: 'vendorPayable' },
  { code: '2102', name: 'مستحقات الموظفين والـ Freelancers', nameEn: 'Payroll & creator payables', type: 'liability', isGroup: true, parent: '21' },
  { code: '210201', name: 'رواتب ومستحقات الموظفين', nameEn: 'Employees payroll payable', type: 'liability', parent: '2102', role: 'employeePayable' },
  { code: '210202', name: 'مستحقات المبتكرين والـ Freelancers', nameEn: 'Creators & freelancers payable', type: 'liability', parent: '2102' },

  { code: '2103', name: 'أمانات ميزانيات إعلانات العملاء', nameEn: 'Client ad budgets held', type: 'liability', parent: '21', role: 'adBudgetHeld' },
  { code: '2104', name: 'الضرائب المستحقة', nameEn: 'Tax payable', type: 'liability', parent: '21', role: 'tax' },
  { code: '2105', name: 'أوراق دفع', nameEn: 'Notes payable', type: 'liability', parent: '21' },
  { code: '2106', name: 'مصروفات مستحقة غير مدفوعة', nameEn: 'Accrued expenses', type: 'liability', parent: '21' },
  { code: '2107', name: 'دفوعات مقدمة من العملاء', nameEn: 'Client advance prepayments', type: 'liability', parent: '21' },

  { code: '22', name: 'الالتزامات غير المتداولة', nameEn: 'Non-current liabilities', type: 'liability', isGroup: true, parent: '2' },
  { code: '2201', name: 'قروض وتسهيلات طويلة الأجل', nameEn: 'Long-term loans', type: 'liability', parent: '22' },

  { code: '3', name: 'حقوق الملكية', nameEn: 'Equity', type: 'equity', isGroup: true },
  { code: '3101', name: 'رأس المال المدفوع', nameEn: 'Paid-in Capital', type: 'equity', parent: '3', role: 'capital' },
  { code: '32', name: 'الاحتياطيات العامة والنظامية', nameEn: 'Reserves', type: 'equity', parent: '3' },
  { code: '33', name: 'الأرباح المحتجزة / المدورة', nameEn: 'Retained earnings', type: 'equity', parent: '3', role: 'retained' },
  { code: '34', name: 'مسحوبات الشركاء والملاّك', nameEn: 'Owner drawings', type: 'equity', parent: '3', role: 'drawings', normalBalance: 'debit' },

  { code: '4', name: 'الإيرادات', nameEn: 'Revenue', type: 'revenue', isGroup: true },
  { code: '41', name: 'إيرادات المبيعات والخدمات', nameEn: 'Service revenue', type: 'revenue', isGroup: true, parent: '4' },
  { code: '4101', name: 'إيرادات تسويق وإدارة إعلانات', nameEn: 'Digital marketing revenue', type: 'revenue', parent: '41', role: 'revenue' },
  { code: '4102', name: 'إيرادات إنتاج فني وتصوير', nameEn: 'Media production revenue', type: 'revenue', parent: '41' },
  { code: '4103', name: 'إيرادات تصميم وهوية بصرية', nameEn: 'Graphic & branding revenue', type: 'revenue', parent: '41' },
  { code: '4104', name: 'إيرادات استشارات وتطوير', nameEn: 'Consulting revenue', type: 'revenue', parent: '41' },
  { code: '4201', name: 'إيرادات أخرى متنوعة', nameEn: 'Other income', type: 'revenue', parent: '4' },

  { code: '5', name: 'المصروفات والتكاليف', nameEn: 'Expenses & costs', type: 'expense', isGroup: true },

  { code: '51', name: 'التكاليف المباشرة للخدمات', nameEn: 'Direct cost of services (COGS)', type: 'expense', isGroup: true, parent: '5' },
  { code: '5101', name: 'أجور موديلز وصناع محتوى', nameEn: 'Model & creator fees', type: 'expense', parent: '51', role: 'costModel' },
  { code: '5102', name: 'تكاليف تصوير ومونتاج وإنتاج', nameEn: 'Filming & editing costs', type: 'expense', parent: '51', role: 'costVideo' },
  { code: '5103', name: 'تكاليف تصميم جرافيك خارجي', nameEn: 'Graphic design costs', type: 'expense', parent: '51', role: 'costDesign' },
  { code: '5104', name: 'إيجار معدات واستوديوهات خارجية', nameEn: 'Equipment rental costs', type: 'expense', parent: '51', role: 'costEquipment' },
  { code: '5105', name: 'عمولات ونسب مبيعات ومسوقين', nameEn: 'Commissions', type: 'expense', parent: '51', role: 'costCommission' },
  { code: '5106', name: 'تكاليف إنتاجية ودفعات سحابية أخرى', nameEn: 'Other direct production costs', type: 'expense', parent: '51', role: 'costOther' },

  { code: '52', name: 'المصروفات الإدارية والعمومية', nameEn: 'General & administrative expenses', type: 'expense', isGroup: true, parent: '5' },
  { code: '5201', name: 'رواتب وأجور الإدارة', nameEn: 'Salaries & admin wages', type: 'expense', parent: '52', role: 'salaryExpense' },
  { code: '5202', name: 'إيجار وتكاليف المقر', nameEn: 'Office rent', type: 'expense', parent: '52' },
  { code: '5203', name: 'كهرباء، مياه، إنترنت واتصالات', nameEn: 'Utilities & telecom', type: 'expense', parent: '52' },
  { code: '5204', name: 'صيانة أجهزة وتجهيزات', nameEn: 'Equipment maintenance', type: 'expense', parent: '52', role: 'maintenance' },
  { code: '5205', name: 'إهلاك الأصول الثابتة', nameEn: 'Depreciation expense', type: 'expense', parent: '52', role: 'depreciation' },
  { code: '5206', name: 'مصروفات بنكية وعمولات تحويل', nameEn: 'Bank charges & fees', type: 'expense', parent: '52' },
  { code: '5207', name: 'اشتراكات أدوات وبرمجيات رقمية', nameEn: 'Software subscriptions & SaaS', type: 'expense', parent: '52' },
  { code: '5208', name: 'ضيافة ونظافة ومستلزمات مكتبية', nameEn: 'Office supplies & hospitality', type: 'expense', parent: '52' },
  { code: '5209', name: 'مصروفات إدارية ونثرية أخرى', nameEn: 'Other admin expenses', type: 'expense', parent: '52', role: 'otherExpense' },

  { code: '53', name: 'المصروفات التسويقية والبيعية', nameEn: 'Selling & marketing expenses', type: 'expense', isGroup: true, parent: '5' },
  { code: '5301', name: 'إعلانات وحملات الشركة الذاتية', nameEn: 'Company own paid ads', type: 'expense', parent: '53' },
  { code: '5302', name: 'مطبوعات وهدايا تسويقية', nameEn: 'Marketing materials', type: 'expense', parent: '53' },
]

export const DEFAULT_PAYMENT_METHODS = [
  { name: 'الخزينة الرئيسية', type: 'cash', accountCode: '1111' },
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

export async function seedMissingAccounts(accounts) {
  const missing = missingDefaults(accounts)

  for (const account of missing) {
    await createDoc(ACCOUNTS_COL, {
      code: account.code,
      name: account.name,
      nameEn: account.nameEn ?? '',
      type: account.type,
      isGroup: Boolean(account.isGroup),
      role: account.role ?? null,
      parentCode: account.parent ?? null,
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
 * أول كود فرعي شاغر تحت حساب أب: كود الأب + رقم تسلسلي (يبدأ بخانة واحدة
 * ويتوسّع عند الحاجة). يتخطّى الأكواد المستخدمة فعلًا حتى لا يتكرر كود.
 */
export function nextChildCode(accounts, parentCode) {
  const used = new Set(accounts.map((account) => String(account.code)))
  const prefix = parentCode ? String(parentCode) : ''

  const siblings = accounts
    .filter((account) => (account.parentCode ?? '') === (parentCode ?? ''))
    .map((account) => String(account.code))

  /* أطول امتداد لكود شقيق يحدّد عدد الخانات المطلوبة */
  let width = 1
  for (const code of siblings) {
    if (code.startsWith(prefix) && code.length > prefix.length) {
      width = Math.max(width, code.length - prefix.length)
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const max = 10 ** width
    for (let n = 1; n < max; n += 1) {
      const candidate = `${prefix}${String(n).padStart(width, '0')}`
      if (!used.has(candidate)) return candidate
    }
    width += 1
  }
  return `${prefix}1`
}

export function accountLabel(account, lang) {
  if (!account) return '—'
  return lang === 'en' && account.nameEn ? account.nameEn : account.name
}

/** بناء شجرة متداخلة من قائمة مسطّحة معتمدة على parentCode */
export function buildTree(accounts) {
  if (!accounts || !Array.isArray(accounts)) return []
  const sorted = [...accounts].sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')))
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

/** إيجاد حساب بدوره الوظيفي */
export function byRole(accounts, role) {
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
      (account.role === 'cash' || account.role === 'bank' || linked.has(account.id)),
  )
}

export { COL }
