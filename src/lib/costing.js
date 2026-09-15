import { monthKey, round2, toNumber } from './format'

/**
 * تكاليف الشغل المباشرة: كل جنيه يُصرف على شغلانة بعينها
 * (موديل، مونتير، مصمم، إيجار معدات، عمولة) مربوط بالفاتورة نفسها،
 * حتى يظهر الربح الحقيقي لكل فاتورة وخدمة وعميل — لا مجرد الإيراد.
 */

export const COST_TYPES = ['model', 'video', 'design', 'equipment', 'commission', 'other']

/** دور الحساب المحاسبي المقابل لكل نوع تكلفة */
export const COST_ROLE = {
  model: 'costModel',
  video: 'costVideo',
  design: 'costDesign',
  equipment: 'costEquipment',
  commission: 'costCommission',
  other: 'costOther',
}

/** تحويل كود نوع التكلفة أو التخصص (مثل 'model' أو 'موديل') إلى مسمى فريد واضح للواجهة */
export function vendorTypeLabel(value, t) {
  if (!value) return ''
  const str = String(value).trim()
  if (!str) return ''

  const key = `vendors.type.${str}`
  const translated = t ? t(key) : null
  if (translated && translated !== key) return translated

  const map = {
    model: t ? t('vendors.type.model') : 'موديل',
    video: t ? t('vendors.type.video') : 'تصوير ومونتاج',
    design: t ? t('vendors.type.design') : 'تصميم جرافيك',
    equipment: t ? t('vendors.type.equipment') : 'إيجار معدات',
    commission: t ? t('vendors.type.commission') : 'عمولة ونسبة',
    other: t ? t('vendors.type.other') : 'أخرى',
  }
  if (map[str]) return map[str]
  return str
}

/** أتعاب الشركة في الفاتورة — بدون ميزانية الإعلانات وبدون الضريبة */
export function invoiceFees(invoice) {
  return round2(toNumber(invoice?.total) - toNumber(invoice?.adBudgetTotal) - toNumber(invoice?.taxAmount))
}

export function costsOfInvoice(costs, invoiceId) {
  return costs.filter((cost) => cost.invoiceId === invoiceId)
}

export function sumCosts(costs) {
  return round2(costs.reduce((sum, cost) => sum + toNumber(cost.amount), 0))
}

/** ربحية فاتورة واحدة */
export function invoiceProfit(invoice, costs = []) {
  const revenue = invoiceFees(invoice)
  const itemApprovedCosts = (invoice?.items || [])
    .filter((item) => item.supplierId && (item.costStatus === 'approved' || item.costStatus === 'partially_paid' || item.costStatus === 'paid') && item.approvedCost > 0)
    .reduce((sum, item) => sum + toNumber(item.approvedCost), 0)

  const legacyCost = sumCosts(costsOfInvoice(costs, invoice?.id))
  const cost = itemApprovedCosts > 0 ? round2(itemApprovedCosts) : legacyCost
  const profit = round2(revenue - cost)
  return {
    revenue,
    cost,
    profit,
    margin: revenue > 0 ? round2((profit / revenue) * 100) : 0,
  }
}

/** ربحية مجمّعة حسب مفتاح (عميل / خدمة / موظف) */
export function profitBy(invoices, costs, keyOf, labelOf) {
  const map = new Map()

  for (const invoice of invoices) {
    const key = keyOf(invoice)
    if (key === null || key === undefined) continue

    const entry = map.get(key) ?? { key, label: labelOf(invoice), revenue: 0, cost: 0, count: 0 }
    entry.revenue += invoiceFees(invoice)
    entry.cost += sumCosts(costsOfInvoice(costs, invoice.id))
    entry.count += 1
    map.set(key, entry)
  }

  return [...map.values()]
    .map((entry) => ({
      ...entry,
      revenue: round2(entry.revenue),
      cost: round2(entry.cost),
      profit: round2(entry.revenue - entry.cost),
      margin: entry.revenue > 0 ? round2(((entry.revenue - entry.cost) / entry.revenue) * 100) : 0,
    }))
    .sort((a, b) => b.profit - a.profit)
}

/**
 * ربحية متوقعة مجمّعة حسب مفتاح (عميل / موظف) — تعتمد على لقطة
 * expectedCost المخزَّنة على الفاتورة وقت إنشائها، لا على التكاليف الفعلية.
 */
export function expectedProfitBy(invoices, keyOf, labelOf) {
  const map = new Map()

  for (const invoice of invoices) {
    const key = keyOf(invoice)
    if (key === null || key === undefined) continue

    const entry = map.get(key) ?? { key, label: labelOf(invoice), revenue: 0, cost: 0, count: 0 }
    entry.revenue += invoiceFees(invoice)
    entry.cost += toNumber(invoice.expectedCost)
    entry.count += 1
    map.set(key, entry)
  }

  return [...map.values()]
    .map((entry) => ({
      ...entry,
      revenue: round2(entry.revenue),
      cost: round2(entry.cost),
      profit: round2(entry.revenue - entry.cost),
      margin: entry.revenue > 0 ? round2(((entry.revenue - entry.cost) / entry.revenue) * 100) : 0,
    }))
    .sort((a, b) => b.profit - a.profit)
}

/** ربحية متوقعة حسب الخدمة — يُوزَّع expectedCost على البنود بنسبة قيمة كل بند */
export function expectedProfitByService(invoices) {
  const map = new Map()

  for (const invoice of invoices) {
    const items = (invoice.items ?? []).filter((item) => !item.isAdBudget)
    const itemsTotal = items.reduce((sum, item) => sum + toNumber(item.total), 0)
    if (itemsTotal <= 0) continue

    const invoiceCost = toNumber(invoice.expectedCost)

    for (const item of items) {
      const share = toNumber(item.total) / itemsTotal
      const name = item.name || '—'
      const entry = map.get(name) ?? { key: name, label: name, revenue: 0, cost: 0, count: 0, qty: 0 }
      entry.revenue += toNumber(item.total)
      entry.cost += invoiceCost * share
      entry.qty += toNumber(item.qty)
      entry.count += 1
      map.set(name, entry)
    }
  }

  return [...map.values()]
    .map((entry) => ({
      ...entry,
      revenue: round2(entry.revenue),
      cost: round2(entry.cost),
      profit: round2(entry.revenue - entry.cost),
      margin: entry.revenue > 0 ? round2(((entry.revenue - entry.cost) / entry.revenue) * 100) : 0,
    }))
    .sort((a, b) => b.profit - a.profit)
}

/** ربحية حسب الخدمة — تُوزَّع التكاليف على البنود بنسبة قيمة كل بند */
export function profitByService(invoices, costs) {
  const map = new Map()

  for (const invoice of invoices) {
    const items = (invoice.items ?? []).filter((item) => !item.isAdBudget)
    const itemsTotal = items.reduce((sum, item) => sum + toNumber(item.total), 0)
    if (itemsTotal <= 0) continue

    const invoiceCost = sumCosts(costsOfInvoice(costs, invoice.id))

    for (const item of items) {
      const share = toNumber(item.total) / itemsTotal
      const name = item.name || '—'
      const entry = map.get(name) ?? { key: name, label: name, revenue: 0, cost: 0, count: 0, qty: 0 }
      entry.revenue += toNumber(item.total)
      entry.cost += invoiceCost * share
      entry.qty += toNumber(item.qty)
      entry.count += 1
      map.set(name, entry)
    }
  }

  return [...map.values()]
    .map((entry) => ({
      ...entry,
      revenue: round2(entry.revenue),
      cost: round2(entry.cost),
      profit: round2(entry.revenue - entry.cost),
      margin: entry.revenue > 0 ? round2(((entry.revenue - entry.cost) / entry.revenue) * 100) : 0,
    }))
    .sort((a, b) => b.profit - a.profit)
}

/**
 * العمولة التلقائية: نسبة الموظف من أتعاب الفاتورة (بدون ميزانية الإعلانات
 * والضريبة). تُخزَّن كتكلفة شغل بعلامة auto، فتنزل على ربح الفاتورة
 * وتظهر في مستحقات الموظف — وتُعاد حسابها كلما تغيّرت الفاتورة.
 */
export const AUTO_COMMISSION = 'commission'

export function commissionFor(invoice, employee, customRate) {
  const rate = customRate !== undefined && customRate !== null ? toNumber(customRate) : toNumber(employee?.commissionRate)
  if (!employee || rate <= 0) return 0
  return round2((invoiceFees(invoice) * rate) / 100)
}

/**
 * حساب العمولة للشرايح (التارجت وما فوق التارجت):
 * - إذا كان التارجت محدداً (مثلاً 50,000):
 *   - إذا كان خيار "اشتراط تحقيق التارجت" مفعلاً والمبيعات أقل من التارجت: العمولة = 0.
 *   - الجزء حتى التارجت يُحسب بالنسبة الأساسية commissionRate (مثلاً 20%).
 *   - الجزء ما فوق التارجت:
 *     - إذا كان خيار "نسبة ما فوق التارجت" مفعلاً: يُحسب بالنسبة فوق التارجت overTargetCommissionRate (مثلاً 10%).
 *     - وإلا: يُحسب بالنسبة الأساسية commissionRate.
 * - إذا لم يكن هناك تارجت: تُحسب بالنسبة الأساسية commissionRate مباشرة.
 */
export function calculateEmployeeTieredCommission(employee, monthlySalesValue) {
  const sales = round2(toNumber(monthlySalesValue))
  if (!employee || sales <= 0) {
    return { baseSales: 0, baseCommission: 0, overSales: 0, overCommission: 0, totalCommission: 0, hitTarget: false }
  }

  const baseRate = toNumber(employee.commissionRate)
  const target = toNumber(employee.targetAmount)
  const requireTarget = Boolean(employee.requireTargetForCommission)
  const overEnabled = Boolean(employee.overTargetCommissionEnabled)
  const overRate = overEnabled ? toNumber(employee.overTargetCommissionRate) : baseRate

  if (target <= 0) {
    const totalCommission = round2((sales * baseRate) / 100)
    return {
      baseSales: sales,
      baseCommission: totalCommission,
      overSales: 0,
      overCommission: 0,
      totalCommission,
      hitTarget: true,
    }
  }

  const hitTarget = sales >= target

  if (requireTarget && !hitTarget) {
    return {
      baseSales: sales,
      baseCommission: 0,
      overSales: 0,
      overCommission: 0,
      totalCommission: 0,
      hitTarget: false,
    }
  }

  const baseSales = Math.min(sales, target)
  const overSales = Math.max(0, sales - target)

  const baseCommission = round2((baseSales * baseRate) / 100)
  const overCommission = round2((overSales * overRate) / 100)
  const totalCommission = round2(baseCommission + overCommission)

  return {
    baseSales,
    baseCommission,
    overSales,
    overCommission,
    totalCommission,
    hitTarget,
  }
}

/** حساب عمولة فاتورة بعينها مع مراعاة تسلسل الشرايح الشهرية للموظف */
export function computeInvoiceCommission({ invoice, employee, monthInvoices = [] }) {
  if (!employee || invoice?.cancelled) return 0

  const baseRate = toNumber(employee.commissionRate)
  const target = toNumber(employee.targetAmount)
  const requireTarget = Boolean(employee.requireTargetForCommission)
  const overEnabled = Boolean(employee.overTargetCommissionEnabled)
  const overRate = overEnabled ? toNumber(employee.overTargetCommissionRate) : baseRate

  if (target <= 0 && !overEnabled) {
    return commissionFor(invoice, employee)
  }

  const invMonth = monthKey(invoice.date)
  const sameMonthInvoices = monthInvoices.filter(
    (inv) => inv.employeeId === employee.id && !inv.cancelled && monthKey(inv.date) === invMonth
  )

  const totalMonthSales = round2(
    sameMonthInvoices.reduce((sum, inv) => sum + invoiceFees(inv), 0)
  )

  if (target > 0 && requireTarget && totalMonthSales < target) {
    return 0
  }

  const sorted = [...sameMonthInvoices].sort((a, b) => {
    if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '')
    return (a.id || '').localeCompare(b.id || '')
  })

  let priorSales = 0
  for (const inv of sorted) {
    const fees = invoiceFees(inv)
    if (inv.id === invoice.id) {
      const start = priorSales
      const end = priorSales + fees

      const basePortion = target > 0 ? Math.max(0, Math.min(end, target) - start) : fees
      const overPortion = target > 0 ? Math.max(0, end - Math.max(start, target)) : 0

      return round2((basePortion * baseRate) / 100 + (overPortion * overRate) / 100)
    }
    priorSales += fees
  }

  const fees = invoiceFees(invoice)
  const start = totalMonthSales
  const end = totalMonthSales + fees
  const basePortion = target > 0 ? Math.max(0, Math.min(end, target) - start) : fees
  const overPortion = target > 0 ? Math.max(0, end - Math.max(start, target)) : 0
  return round2((basePortion * baseRate) / 100 + (overPortion * overRate) / 100)
}

/** يرجّع تعليمات المزامنة: إنشاء أو تعديل أو حذف تكلفة العمولة مع الحفاظ على النسبة التاريخية */
export function planCommission({ invoice, employee, existing, monthInvoices = [] }) {
  if (existing?.paid) {
    return { action: 'none' } // Paid/finalized commission records are strictly immutable
  }

  const rate = existing?.commissionRate !== undefined && existing?.commissionRate !== null
    ? toNumber(existing.commissionRate)
    : toNumber(employee?.commissionRate)

  let amount = 0
  if (!invoice?.cancelled) {
    if (employee && (employee.targetAmount > 0 || employee.overTargetCommissionEnabled)) {
      amount = computeInvoiceCommission({ invoice, employee, monthInvoices })
    } else {
      amount = commissionFor(invoice, employee, rate)
    }
  }

  if (amount <= 0) {
    return existing ? { action: 'delete', id: existing.id } : { action: 'none' }
  }

  const descRate = employee?.overTargetCommissionEnabled && employee?.targetAmount > 0
    ? `${employee.name} — ${employee.commissionRate}% / ${employee.overTargetCommissionRate}%`
    : `${employee.name} — ${rate}%`

  const data = {
    type: 'commission',
    auto: AUTO_COMMISSION,
    employeeId: employee.id,
    vendorId: null,
    commissionRate: rate,
    description: descRate,
    amount,
    date: invoice.date,
  }

  if (!existing) return { action: 'create', data: { ...data, paid: false, paidDate: null } }
  if (round2(existing.amount) === amount && existing.employeeId === employee.id && existing.date === invoice.date && existing.commissionRate === rate) {
    return { action: 'none' }
  }
  return { action: 'update', id: existing.id, data }
}

/** تحليل الشرايح الشهري المستحق لموظف (للعرض في ملف الموظف) */
export function monthlyEmployeeTierBreakdowns(employee, invoices = []) {
  if (!employee) return []
  const months = new Map()

  for (const inv of invoices) {
    if (inv.employeeId !== employee.id || inv.cancelled) continue
    const m = monthKey(inv.date)
    if (!m) continue
    const current = months.get(m) ?? 0
    months.set(m, current + invoiceFees(inv))
  }

  return [...months.entries()]
    .map(([month, totalSales]) => ({
      month,
      totalSales: round2(totalSales),
      ...calculateEmployeeTieredCommission(employee, totalSales),
    }))
    .sort((a, b) => b.month.localeCompare(a.month))
}

/** مستحقات عمولة موظف */
export function employeeCommission(employeeId, costs) {
  const own = costs.filter((cost) => cost.employeeId === employeeId && cost.type === 'commission')
  const earned = sumCosts(own)
  const paid = sumCosts(own.filter((cost) => cost.paid))
  return { earned, paid, due: round2(earned - paid), count: own.length, rows: own }
}

/**
 * شغلانات إضافية أُسندت لموظف على المرتب بأجر منفصل (مثلًا يصوّر
 * فيديو لعميل بعينه) — نفس فكرة تكلفة الشغل، لكن مربوطة بموظف
 * لا بمورد، فتظهر في كشفه الشهري بدل كشف أعمال مورد منفصل.
 */
export function employeeJobPay(employeeId, costs) {
  const own = costs.filter((cost) => cost.employeeId === employeeId && cost.type !== 'commission')
  const earned = sumCosts(own)
  const paid = sumCosts(own.filter((cost) => cost.paid))
  return { earned, paid, due: round2(earned - paid), count: own.length, rows: own }
}

/* ------------------------------------------------------------------ */
/*  التكلفة المعيارية الكاملة للخدمة                                    */
/*                                                                     */
/*  كل خدمة تحمل تكلفتها المتوقعة من أولها لآخرها: مباشر (موديل،         */
/*  مونتير، تصميم، إيجار معدات) + غير مباشر «بحيرة الأعباء» (إيجار،      */
/*  إنترنت، كهرباء، إضاءة، إهلاك معدات) — بيحطها المستخدم بنفسه كأرقام   */
/*  متوقعة. الفائدة: تظهر أرضية السعر والهامش وقت عمل الفاتورة، ويظهر    */
/*  الربح الحقيقي لكل خدمة لا مجرد الإيراد.                              */
/* ------------------------------------------------------------------ */

export const DIRECT_COST_KEYS = ['model', 'video', 'design', 'equipment', 'other']
export const INDIRECT_COST_KEYS = ['rent', 'internet', 'electricity', 'lighting', 'depreciation', 'other']

export function emptyServiceCosting() {
  return { direct: [], indirect: [], markupPct: '' }
}

function cleanCostLines(rows, fallbackKey) {
  return (rows ?? [])
    .map((row) => ({
      key: row.key ?? fallbackKey,
      label: (row.label ?? '').trim(),
      amount: round2(toNumber(row.amount)),
    }))
    .filter((row) => row.amount !== 0 || row.label)
}

/** يفكّك تكلفة الخدمة الواحدة: مباشر، غير مباشر، الإجمالي، والسعر المقترح */
export function serviceCostBreakdown(service) {
  const costing = service?.costing ?? {}
  const direct = cleanCostLines(costing.direct, 'other')
  const indirect = cleanCostLines(costing.indirect, 'other')
  const directTotal = round2(direct.reduce((sum, row) => sum + row.amount, 0))
  const indirectTotal = round2(indirect.reduce((sum, row) => sum + row.amount, 0))
  const fullCost = round2(directTotal + indirectTotal)
  const markupPct = toNumber(costing.markupPct)

  return {
    direct,
    indirect,
    directTotal,
    indirectTotal,
    fullCost,
    markupPct,
    suggestedPrice: round2(fullCost * (1 + markupPct / 100)),
    hasCosting: direct.length > 0 || indirect.length > 0,
  }
}

/** هامش بند فاتورة مقابل تكلفته المعيارية الكاملة */
export function lineMargin(sellTotal, fullCostTotal) {
  const revenue = round2(toNumber(sellTotal))
  const cost = round2(toNumber(fullCostTotal))
  const profit = round2(revenue - cost)
  return {
    revenue,
    cost,
    profit,
    margin: revenue > 0 ? round2((profit / revenue) * 100) : 0,
  }
}

/**
 * لقطة التكلفة المتوقعة لفاتورة: تُجمع من الخدمات المرتبطة ببنودها × الكمية.
 * تُخزَّن على الفاتورة نفسها (expectedCost / expectedCostBreakdown) فلا
 * تتأثر لو عُدِّلت الخدمة لاحقًا، وتظهر جنبًا إلى جنب مع التكلفة الفعلية.
 */
export function expectedCostOfItems(items, serviceMap) {
  let directTotal = 0
  let indirectTotal = 0
  const lines = []

  for (const item of items ?? []) {
    if (item.isAdBudget) continue
    const service = item.serviceId ? serviceMap.get(item.serviceId) : null
    const breakdown = serviceCostBreakdown(service)
    if (!breakdown.hasCosting) continue

    const qty = toNumber(item.qty) || 1
    const lineDirect = round2(breakdown.directTotal * qty)
    const lineIndirect = round2(breakdown.indirectTotal * qty)
    directTotal += lineDirect
    indirectTotal += lineIndirect

    lines.push({
      name: item.name || service?.name || '—',
      qty,
      direct: lineDirect,
      indirect: lineIndirect,
      total: round2(lineDirect + lineIndirect),
      components: [
        ...breakdown.direct.map((row) => ({ ...row, group: 'direct', amount: round2(row.amount * qty) })),
        ...breakdown.indirect.map((row) => ({ ...row, group: 'indirect', amount: round2(row.amount * qty) })),
      ],
    })
  }

  return {
    direct: round2(directTotal),
    indirect: round2(indirectTotal),
    total: round2(directTotal + indirectTotal),
    lines,
  }
}

/** ربحية متوقعة للفاتورة من لقطة التكلفة المعيارية المخزَّنة عليها */
export function invoiceExpectedProfit(invoice) {
  const revenue = invoiceFees(invoice)
  const cost = round2(toNumber(invoice?.expectedCost))
  const profit = round2(revenue - cost)
  return {
    revenue,
    cost,
    profit,
    margin: revenue > 0 ? round2((profit / revenue) * 100) : 0,
    hasEstimate: invoice?.expectedCost !== undefined && invoice?.expectedCost !== null,
  }
}

/* ------------------------------------------------------------------ */
/*  بونص التارجت الشهري للموظف                                          */
/*                                                                     */
/*  الموظف نوعان: مرتب ثابت فقط، أو مرتب + بونص لو عدّى تارجت الشهر      */
/*  (عدد الفواتير أو قيمتها). يُحسب لكل شهر على حدة من فواتير الموظف     */
/*  غير الملغاة. لا يُقيَّد تلقائيًا — يظهر في الكشف، ويُسجَّل كحركة بونص  */
/*  عند صرفه فعليًا.                                                     */
/* ------------------------------------------------------------------ */

export function monthlyTargetBonus(employee, invoices, month) {
  const rule = employee?.targetBonus
  const target = toNumber(rule?.target)
  const bonus = toNumber(rule?.bonus)
  const metric = rule?.metric === 'value' ? 'value' : 'count'

  if (!rule?.enabled || target <= 0 || bonus <= 0) {
    return { enabled: false, metric, target, bonus, actual: 0, hit: false, earned: 0 }
  }

  const own = invoices.filter(
    (invoice) =>
      invoice.employeeId === employee.id && !invoice.cancelled && monthKey(invoice.date) === month,
  )
  const actual =
    metric === 'value'
      ? round2(own.reduce((sum, invoice) => sum + toNumber(invoice.total), 0))
      : own.length
  const hit = actual >= target

  return { enabled: true, metric, target, bonus, actual, hit, earned: hit ? bonus : 0 }
}

/** أشهر بونص التارجت المستحقة لموظف (للكشف الشهري) */
export function targetBonusRows(employee, invoices) {
  if (!employee?.targetBonus?.enabled) return []
  const months = new Set()
  for (const invoice of invoices) {
    if (invoice.employeeId === employee.id && !invoice.cancelled) months.add(monthKey(invoice.date))
  }
  return [...months]
    .map((month) => ({ month, ...monthlyTargetBonus(employee, invoices, month) }))
    .filter((row) => row.earned > 0)
}

/** رصيد مستحق لكل مورد/فريلانسر (سجلات سابقة) */
export function vendorBalance(vendorId, costs) {
  const own = costs.filter((cost) => cost.vendorId === vendorId)
  const earned = sumCosts(own)
  const paid = sumCosts(own.filter((cost) => cost.paid))
  return { earned, paid, due: round2(earned - paid), jobs: own.length }
}

/** رصيد ذمم المورد المحاسبي الرسمي (حساب 211 - المصدر الحقيقي الموحد): فواتير الشراء وتكاليف البنود المعتمدة */
export function formalVendorBalance(vendorId, purchaseInvoices = [], supplierPayables = []) {
  const ownInvoices = (purchaseInvoices || []).filter((inv) => inv.vendorId === vendorId && !inv.cancelled)
  const ownPayables = (supplierPayables || []).filter((sp) => sp.supplierId === vendorId && sp.status !== 'cancelled' && sp.status !== 'reconciled')

  const piPurchases = round2(ownInvoices.reduce((sum, inv) => sum + toNumber(inv.total), 0))
  const piPaid = round2(ownInvoices.reduce((sum, inv) => sum + toNumber(inv.paidAmount), 0))

  const spPurchases = round2(ownPayables.reduce((sum, sp) => sum + toNumber(sp.approvedCost), 0))
  const spPaid = round2(ownPayables.reduce((sum, sp) => sum + toNumber(sp.paidAmount), 0))

  const totalPurchases = round2(piPurchases + spPurchases)
  const totalPaid = round2(piPaid + spPaid)
  const remainingDue = round2(totalPurchases - totalPaid)

  return {
    totalPurchases,
    totalPaid,
    due: remainingDue,
    count: ownInvoices.length + ownPayables.length,
    invoiceCount: ownInvoices.length,
    payableCount: ownPayables.length,
  }
}

/** تقرير مفصّل وشامل لكشف حساب الموظف عن شهر معين بكل حركاته */
export function buildDetailedEmployeeMonthReport({ employee, month, entries = [], jobCosts = [], invoices = [] }) {
  if (!employee || !month) return null

  const monthEntries = entries.filter(
    (e) => e.employeeId === employee.id && monthKey(e.date) === month
  )
  const monthCommissions = jobCosts.filter(
    (c) => c.employeeId === employee.id && c.type === 'commission' && monthKey(c.date) === month
  )
  const monthJobPays = jobCosts.filter(
    (c) => c.employeeId === employee.id && c.type !== 'commission' && monthKey(c.date) === month
  )

  const targetBonusInfo = monthlyTargetBonus(employee, invoices, month)

  const monthInvoices = invoices.filter(
    (inv) => inv.employeeId === employee.id && !inv.cancelled && monthKey(inv.date) === month
  )
  const totalSales = round2(monthInvoices.reduce((sum, inv) => sum + invoiceFees(inv), 0))
  const tierCalc = calculateEmployeeTieredCommission(employee, totalSales)

  let salaryTotal = 0
  let bonusTotal = 0
  let raiseTotal = 0
  let deductionTotal = 0

  const movementRows = []

  for (const e of monthEntries) {
    const amt = toNumber(e.amount)
    if (e.type === 'salary') salaryTotal += amt
    else if (e.type === 'bonus') bonusTotal += amt
    else if (e.type === 'raise') raiseTotal += amt
    else if (e.type === 'deduction') deductionTotal += amt

    movementRows.push({
      id: e.id,
      date: e.date,
      type: e.type,
      ref: e.voucherNumber || '—',
      description: e.note || `حركة ${e.type}`,
      earned: e.type === 'deduction' ? 0 : amt,
      deduction: e.type === 'deduction' ? amt : 0,
      paid: e.paid ? signedAmount(e.type, amt) : 0,
      paidStatus: e.paid,
      paidDate: e.paidDate || null,
      source: 'manual',
    })
  }

  let commissionTotal = 0
  let commissionPaidTotal = 0
  for (const c of monthCommissions) {
    const amt = toNumber(c.amount)
    commissionTotal += amt
    if (c.paid) commissionPaidTotal += amt

    movementRows.push({
      id: c.id,
      date: c.date,
      type: 'commission',
      ref: c.invoiceId ? 'فاتورة' : '—',
      description: c.description || 'عمولة مبيعات تلقائية',
      earned: amt,
      deduction: 0,
      paid: c.paid ? amt : 0,
      paidStatus: c.paid,
      paidDate: c.paidDate || null,
      source: 'invoice',
    })
  }

  let jobPayTotal = 0
  let jobPayPaidTotal = 0
  for (const c of monthJobPays) {
    const amt = toNumber(c.amount)
    jobPayTotal += amt
    if (c.paid) jobPayPaidTotal += amt

    movementRows.push({
      id: c.id,
      date: c.date,
      type: 'jobPay',
      ref: c.invoiceId ? 'شغلانة' : '—',
      description: c.description || 'أجر شغلانة إضافية',
      earned: amt,
      deduction: 0,
      paid: c.paid ? amt : 0,
      paidStatus: c.paid,
      paidDate: c.paidDate || null,
      source: 'jobPay',
    })
  }

  movementRows.sort((a, b) => (a.date || '').localeCompare(b.date || ''))

  const grossEntitlements = round2(
    salaryTotal + bonusTotal + raiseTotal - deductionTotal + commissionTotal + jobPayTotal + (targetBonusInfo.earned || 0)
  )

  const totalPaid = round2(
    monthEntries.filter((e) => e.paid).reduce((sum, e) => sum + signedAmount(e.type, e.amount), 0) +
    commissionPaidTotal +
    jobPayPaidTotal
  )

  const dueBalance = round2(grossEntitlements - totalPaid)

  return {
    employee,
    month,
    salesCount: monthInvoices.length,
    totalSales,
    tierCalc,
    targetBonusInfo,
    salaryTotal: round2(salaryTotal),
    bonusTotal: round2(bonusTotal),
    raiseTotal: round2(raiseTotal),
    deductionTotal: round2(deductionTotal),
    commissionTotal: round2(commissionTotal),
    jobPayTotal: round2(jobPayTotal),
    targetBonusTotal: round2(targetBonusInfo.earned || 0),
    grossEntitlements,
    totalPaid,
    dueBalance,
    movementRows,
  }
}
