function round2(val) {
  return Math.round((Number(val || 0) + Number.EPSILON) * 100) / 100
}

function toNumber(val) {
  const n = Number(val)
  return isNaN(n) ? 0 : n
}

function invoiceFees(invoice) {
  return round2(toNumber(invoice?.total) - toNumber(invoice?.adBudgetTotal) - toNumber(invoice?.taxAmount))
}

function resolveCommissionConfig(employee, departments = []) {
  if (employee?.commissionSource === 'department' && employee?.departmentId) {
    const dept = departments.find(d => d.id === employee.departmentId)
    if (dept?.commissionEnabled) return {
      commissionRate: toNumber(dept.commissionRate),
      targetAmount: toNumber(dept.targetAmount),
      requireTargetForCommission: Boolean(dept.requireTargetForCommission),
      overTargetCommissionEnabled: Boolean(dept.overTargetCommissionEnabled),
      overTargetCommissionRate: toNumber(dept.overTargetCommissionRate),
      source: 'department',
    }
  }
  return {
    commissionRate: toNumber(employee?.commissionRate),
    targetAmount: toNumber(employee?.targetAmount),
    requireTargetForCommission: Boolean(employee?.requireTargetForCommission),
    overTargetCommissionEnabled: Boolean(employee?.overTargetCommissionEnabled),
    overTargetCommissionRate: toNumber(employee?.overTargetCommissionRate),
    source: 'custom',
  }
}

function commissionFor(invoice, employee, customRate, departments) {
  const config = departments ? resolveCommissionConfig(employee, departments) : null
  const rate = customRate !== undefined && customRate !== null
    ? toNumber(customRate)
    : (config ? config.commissionRate : toNumber(employee?.commissionRate))
  if (!employee || rate <= 0) return 0
  const fees = invoiceFees(invoice)
  const total = toNumber(invoice?.total)
  const paidAmount = toNumber(invoice?.paidAmount)
  const paidRatio = total > 0 ? Math.min(paidAmount / total, 1) : 0
  const commissionableFees = round2(fees * paidRatio)
  return round2((commissionableFees * rate) / 100)
}

function calculatePeriodCommissions({ employees, departments, invoices, jobCosts = [], startDate, endDate }) {
  const validInvoices = invoices.filter(inv => {
    return inv.date >= startDate && inv.date <= endDate && !inv.cancelled
  })

  const employeeStats = {}

  validInvoices.forEach(inv => {
    const empId = inv.employeeId
    if (!empId) return
    if (!employeeStats[empId]) {
      employeeStats[empId] = { employeeId: empId, invoices: [] }
    }
    employeeStats[empId].invoices.push(inv)
  })

  const results = []

  for (const empId in employeeStats) {
    const empData = employeeStats[empId]
    const employee = employees.find(e => e.id === empId)
    if (!employee) continue

    const config = resolveCommissionConfig(employee, departments)
    
    let totalSales = 0
    let paidSales = 0

    empData.invoices.forEach(inv => {
      const fees = invoiceFees(inv)
      const total = toNumber(inv.total)
      const paidAmount = toNumber(inv.paidAmount)
      const paid = Math.min(paidAmount, total)
      totalSales += fees
      const paidRatio = total > 0 ? paid / total : 0
      paidSales += fees * paidRatio
    })

    totalSales = round2(totalSales)
    paidSales = round2(paidSales)

    let commissionEarned = 0
    const target = toNumber(config.targetAmount)
    const rate = toNumber(config.commissionRate)
    
    if (target > 0 && config.overTargetCommissionEnabled) {
       if (config.requireTargetForCommission && paidSales < target) {
          commissionEarned = 0
       } else {
          const baseSales = Math.min(paidSales, target)
          const overSales = Math.max(0, paidSales - target)
          const baseComm = baseSales * (rate / 100)
          const overComm = overSales * (toNumber(config.overTargetCommissionRate) / 100)
          commissionEarned = round2(baseComm + overComm)
       }
    } else {
       if (config.requireTargetForCommission && paidSales < target) {
          commissionEarned = 0
       } else {
          commissionEarned = round2(paidSales * (rate / 100))
       }
    }

    let commissionPaid = 0
    const empInvoiceIds = empData.invoices.map(i => i.id)
    const relevantJobCosts = jobCosts.filter(jc => 
      jc.type === 'commission' && 
      jc.employeeId === empId && 
      empInvoiceIds.includes(jc.invoiceId || jc.entityId)
    )
    
    relevantJobCosts.forEach(jc => {
      if (jc.paid) {
        commissionPaid += toNumber(jc.amount)
      }
    })

    commissionPaid = round2(commissionPaid)
    const commissionDue = round2(commissionEarned - commissionPaid)

    results.push({
      employeeId: empId,
      employeeName: employee.name,
      departmentId: employee.departmentId,
      totalSales,
      paidSales,
      commissionRate: rate,
      commissionEarned,
      commissionPaid,
      commissionDue,
      invoiceCount: empData.invoices.length
    })
  }

  return results
}

function employeePeriodDetail({ employee, departments, invoices, jobCosts = [], startDate, endDate }) {
  const validInvoices = invoices.filter(inv => {
    return inv.employeeId === employee.id && inv.date >= startDate && inv.date <= endDate && !inv.cancelled
  })

  const config = resolveCommissionConfig(employee, departments)
  const rate = toNumber(config.commissionRate)
  
  let totalSales = 0
  let paidSales = 0

  const invoiceDetails = validInvoices.map(inv => {
    const fees = invoiceFees(inv)
    const total = toNumber(inv.total)
    const paidAmount = Math.min(toNumber(inv.paidAmount), total)
    const paidRatio = total > 0 ? paidAmount / total : 0
    const invPaidSales = fees * paidRatio
    const invCommission = round2(invPaidSales * (rate / 100))

    totalSales += fees
    paidSales += invPaidSales

    return {
      invoiceId: inv.id,
      invoiceNumber: inv.number || inv.id,
      date: inv.date,
      total,
      paidAmount,
      commissionRate: rate,
      commissionAmount: invCommission,
      fees,
      paidSales: invPaidSales
    }
  })

  totalSales = round2(totalSales)
  paidSales = round2(paidSales)

  let commissionEarned = 0
  const target = toNumber(config.targetAmount)
  
  if (target > 0 && config.overTargetCommissionEnabled) {
     if (config.requireTargetForCommission && paidSales < target) {
        commissionEarned = 0
     } else {
        const baseSales = Math.min(paidSales, target)
        const overSales = Math.max(0, paidSales - target)
        const baseComm = baseSales * (rate / 100)
        const overComm = overSales * (toNumber(config.overTargetCommissionRate) / 100)
        commissionEarned = round2(baseComm + overComm)
     }
  } else {
     if (config.requireTargetForCommission && paidSales < target) {
        commissionEarned = 0
     } else {
        commissionEarned = round2(paidSales * (rate / 100))
     }
  }

  return {
    summary: { totalSales, paidSales, commissionEarned, commissionDue: commissionEarned, invoiceCount: validInvoices.length },
    invoices: invoiceDetails,
    targetInfo: {
      targetAmount: target,
      achievedPercentage: target > 0 ? round2((paidSales / target) * 100) : 0
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`)
    process.exit(1)
  }
  console.log(`✅ PASSED: ${message}`)
}

console.log('==================================================')
console.log('🧪 بدء اختبارات دورة العمل ونظام العمولات والتارجت...')
console.log('==================================================\n')

// 1. بيانات الاختبار للأقسام
const mockDepartments = [
  {
    id: 'dept_sales',
    name: 'المبيعات والتسويق',
    commissionEnabled: true,
    commissionRate: 15,
    targetAmount: 50000,
    requireTargetForCommission: true,
    overTargetCommissionEnabled: true,
    overTargetCommissionRate: 10,
  },
  {
    id: 'dept_tech',
    name: 'البرمجة وتكنولوجيا المعلومات',
    commissionEnabled: false,
    commissionRate: 0,
  },
]

// 2. بيانات الموظفين (أحدهما يرث من القسم والآخر تخصيص فردي)
const empInherit = {
  id: 'emp_ahmed',
  name: 'أحمد مبيعات',
  departmentId: 'dept_sales',
  commissionSource: 'department',
  commissionRate: 0,
}

const empCustom = {
  id: 'emp_sara',
  name: 'سارة VIP',
  departmentId: 'dept_sales',
  commissionSource: 'custom',
  commissionRate: 20,
  targetAmount: 30000,
  requireTargetForCommission: false,
}

// اختبار 1: التحقق من وراثة إعدادات القسم
console.log('--- اختبار 1: وراثة وتخصيص إعدادات العمولة ---')
const resolvedInherit = resolveCommissionConfig(empInherit, mockDepartments)
assert(resolvedInherit.source === 'department', 'مصدر عمولة أحمد هو القسم')
assert(resolvedInherit.commissionRate === 15, 'نسبة عمولة أحمد 15% موروثة من القسم')
assert(resolvedInherit.targetAmount === 50000, 'تارجت أحمد 50,000 موروث من القسم')
assert(resolvedInherit.overTargetCommissionRate === 10, 'نسبة فوق التارجت لأحمد 10% موروثة')

const resolvedCustom = resolveCommissionConfig(empCustom, mockDepartments)
assert(resolvedCustom.source === 'custom', 'مصدر عمولة سارة تخصيص فردي')
assert(resolvedCustom.commissionRate === 20, 'نسبة عمولة سارة 20% خاصة بها')
assert(resolvedCustom.targetAmount === 30000, 'تارجت سارة 30,000 خاص بها')

// اختبار 2: احتساب العمولة على المدفوع فعلياً (لو لم يدفع العميل = العمولة 0)
console.log('\n--- اختبار 2: احتساب العمولة بناءً على السداد الفعلي فقط ---')
const invUnpaid = {
  id: 'inv_1',
  number: 'INV-001',
  total: 100000,
  paidAmount: 0,
  adBudgetTotal: 0,
  taxAmount: 0,
  date: '2026-09-05',
}

const commUnpaid = commissionFor(invUnpaid, empInherit, null, mockDepartments)
assert(commUnpaid === 0, 'الفاتورة غير المسددة عمولتها صفر (0 جنيه)')

// اختبار 3: العميل دفع 40,000 من أصل 100,000 (سداد جزئي 40%)
const invPartial = {
  id: 'inv_2',
  number: 'INV-002',
  total: 100000,
  paidAmount: 40000,
  adBudgetTotal: 0,
  taxAmount: 0,
  date: '2026-09-10',
}
const commPartial = commissionFor(invPartial, empInherit, null, mockDepartments)
// 40,000 * 15% = 6,000
assert(commPartial === 6000, `عمولة السداد الجزئي 40,000 × 15% = 6,000 جنيه (الناتج: ${commPartial})`)

// اختبار 4: سداد كامل 100,000
const invFull = {
  id: 'inv_3',
  number: 'INV-003',
  total: 100000,
  paidAmount: 100000,
  adBudgetTotal: 0,
  taxAmount: 0,
  date: '2026-09-15',
}
const commFull = commissionFor(invFull, empInherit, null, mockDepartments)
assert(commFull === 15000, `عمولة السداد الكامل 100,000 × 15% = 15,000 جنيه (الناتج: ${commFull})`)

// اختبار 5: حساب الشرايح والتارجت في فترة مبيعات شهر سبتمبر
console.log('\n--- اختبار 3: حساب الشرايح والتارجت في فترة مبيعات ---')
const mockInvoices = [
  {
    id: 'inv_a',
    number: 'INV-A',
    employeeId: 'emp_ahmed',
    total: 30000,
    paidAmount: 30000,
    adBudgetTotal: 0,
    taxAmount: 0,
    date: '2026-09-05',
    cancelled: false,
  },
  {
    id: 'inv_b',
    number: 'INV-B',
    employeeId: 'emp_ahmed',
    total: 35000,
    paidAmount: 35000,
    adBudgetTotal: 0,
    taxAmount: 0,
    date: '2026-09-20',
    cancelled: false,
  },
]

// إجمالي المسدد لأحمد = 30,000 + 35,000 = 65,000
// تارجت أحمد = 50,000 (تحقق)
// أول 50,000 بنسبة 15% = 7,500
// الـ 15,000 المتبقية بنسبة 10% = 1,500
// إجمالي العمولة المستحقة = 7,500 + 1,500 = 9,000 جنيه
const periodComms = calculatePeriodCommissions({
  employees: [empInherit],
  departments: mockDepartments,
  invoices: mockInvoices,
  jobCosts: [],
  startDate: '2026-09-01',
  endDate: '2026-09-30',
})

assert(periodComms.length === 1, 'تم العثور على ملخص أحمد في الفترة')
assert(periodComms[0].paidSales === 65000, 'إجمالي المبيعات المحصلة لأحمد = 65,000')
assert(periodComms[0].commissionEarned === 9000, `عمولة أحمد بالشرايح = 9,000 جنيه (الناتج: ${periodComms[0].commissionEarned})`)
assert(periodComms[0].commissionDue === 9000, 'العمولة المستحقة للصرف لأحمد = 9,000 جنيه')

// تفاصيل الموظف Drill-down
const detail = employeePeriodDetail({
  employee: empInherit,
  departments: mockDepartments,
  invoices: mockInvoices,
  jobCosts: [],
  startDate: '2026-09-01',
  endDate: '2026-09-30',
})

assert(detail.invoices.length === 2, 'تفاصيل فواتير أحمد في الفترة = فاتورتين')
assert(detail.targetInfo.achievedPercentage === 130, 'نسبة إنجاز التارجت = 130% (65,000 من أصل 50,000)')

console.log('\n==================================================')
console.log('🎉 جميع الاختبارات تمت بنجاح وبدقة حسابية 100%!')
console.log('==================================================')
