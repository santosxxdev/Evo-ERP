import { ACCOUNT_TYPES, byRole, getNormalBalance } from './accounts'
import { COST_ROLE } from './costing'
import { addMonths, depreciation } from './assets'
import { round2, toNumber } from './format'

/**
 * القيود لا تُخزَّن في قاعدة البيانات — تُشتق من المستندات الأصلية
 * (فواتير، دفعات، مصروفات) في كل مرة. الفائدة: لا يوجد أي احتمال
 * لانفصال دفتر اليومية عن الواقع، ولا حاجة لترحيل بيانات قديمة.
 */

function line(account, debit, credit) {
  return {
    accountId: account?.id ?? null,
    code: account?.code ?? '—',
    account,
    debit: round2(debit),
    credit: round2(credit),
  }
}

function cashOrBank(accounts, methods, methodId, methodType) {
  const cashAcc = byRole(accounts, 'cash')
  const bankAcc = byRole(accounts, 'bank') || accounts.find((account) => (account.parentCode === '110102' || account.parentCode === '1112') && !account.isGroup && !account.archived)

  if (!methodId) {
    if (methodType === 'cash') return cashAcc
    return bankAcc || cashAcc || null
  }

  /* 1 — هل المعرف هو حساب محاسبي مباشرة (ID أو كود)؟ */
  const directAccount = accounts.find((account) => account.id === methodId || String(account.code) === String(methodId))
  if (directAccount && !directAccount.isGroup) return directAccount

  /* 2 — البحث في وسيلة الدفع بالمعرف أو الاسم أو كود الحساب */
  const method = methods.find((item) => item.id === methodId || item.name === methodId)
  if (method) {
    if (method.accountId) {
      const mapped = accounts.find((account) => account.id === method.accountId)
      if (mapped && !mapped.isGroup) return mapped
    }
    if (method.accountCode) {
      const mapped = accounts.find((account) => String(account.code) === String(method.accountCode))
      if (mapped && !mapped.isGroup) return mapped
    }
    const byName = accounts.find((account) => !account.isGroup && (account.name === method.name || account.nameEn === method.name))
    if (byName) return byName
  }

  /* 3 — الاحتياطي حسب نوع الوسيلة */
  const type = method?.type ?? methodType
  if (type === 'cash') return cashAcc
  return bankAcc || cashAcc || null
}

function expenseAccount(accounts, categories, expense) {
  const category = categories.find((item) => item.id === expense.categoryId)
  if (category?.accountId) {
    const mapped = accounts.find((account) => account.id === category.accountId)
    if (mapped) return mapped
  }
  if (expense.source === 'employee' || category?.system === 'salary') {
    return byRole(accounts, 'salaryExpense')
  }
  return byRole(accounts, 'otherExpense')
}

export function buildJournal({
  invoices = [],
  payments = [],
  expenses = [],
  accounts = [],
  expenseCategories = [],
  paymentMethods = [],
  jobCosts = [],
  vendors = [],
  vouchers = [],
  assets = [],
  maintenance = [],
  assetUsage = [],
  accountingTransactions = [],
  settings = {},
  asOf = new Date().toISOString().slice(0, 10),
}) {
  const receivable = byRole(accounts, 'receivable')
  const revenue = byRole(accounts, 'revenue')
  const adHeld = byRole(accounts, 'adBudgetHeld')
  const tax = byRole(accounts, 'tax')

  const entries = []
  
  const postedTransactions = accountingTransactions.filter((tx) => tx.status === 'posted' || !tx.status)
  const postedIds = new Set(postedTransactions.map((tx) => `${tx.sourceType}:${tx.sourceId}`))

  for (const tx of postedTransactions) {
    entries.push({
      id: tx.id,
      date: tx.transactionDate,
      refType: tx.sourceType,
      ref: tx.referenceNumber || '',
      description: tx.description || '',
      lines: (tx.lines || []).map((lineItem) => ({
        accountId: lineItem.accountId,
        code: accounts.find((a) => a.id === lineItem.accountId)?.code ?? '—',
        account: accounts.find((a) => a.id === lineItem.accountId) || { id: lineItem.accountId, name: 'Unknown' },
        debit: lineItem.debit,
        credit: lineItem.credit,
        subLedgerType: lineItem.subLedgerType || null,
        subLedgerId: lineItem.subLedgerId || null,
        subLedgerName: lineItem.subLedgerName || '',
      })),
    })
  }

  /* ١ — الفواتير: إثبات إيراد ومديونية على العميل */
  for (const invoice of invoices) {
    if (postedIds.has(`invoice:${invoice.id}`) || postedIds.has(`invoices:${invoice.id}`)) continue
    const total = toNumber(invoice.total)
    if (total === 0) continue

    const adBudget = toNumber(invoice.adBudgetTotal)
    const taxAmount = toNumber(invoice.taxAmount)
    const fees = total - adBudget - taxAmount

    const lines = [line(receivable, total, 0)]
    if (fees !== 0) lines.push(line(revenue, 0, fees))
    if (adBudget !== 0) lines.push(line(adHeld, 0, adBudget))
    if (taxAmount !== 0) lines.push(line(tax, 0, taxAmount))

    entries.push({
      id: `inv-${invoice.id}`,
      date: invoice.date,
      refType: 'invoice',
      ref: invoice.number,
      description: invoice.clientName || '',
      lines,
    })

    /* فاتورة ملغاة: قيد عكسي بتاريخ الإلغاء بدل حذف الأثر المحاسبي */
    if (invoice.cancelled) {
      entries.push({
        id: `inv-rev-${invoice.id}`,
        date: invoice.cancelledDate || invoice.date,
        refType: 'creditNote',
        ref: invoice.number,
        description: invoice.cancelReason || '',
        lines: lines.map((item) => line(item.account, item.credit, item.debit)),
      })
    }
  }

  /* ٢ — التحصيلات: تحويل مديونية إلى نقدية */
  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]))

  for (const payment of payments) {
    if (postedIds.has(`payments:${payment.id}`) || postedIds.has(`payment:${payment.id}`)) continue

    if (payment.invoiceId) {
      const parentInv = invoiceMap.get(payment.invoiceId)
      if (!parentInv || parentInv.cancelled) continue
    }

    const amount = toNumber(payment.amount)
    if (amount === 0) continue

    const target = cashOrBank(accounts, paymentMethods, payment.methodId, payment.methodType)

    entries.push({
      id: `pay-${payment.id}`,
      date: payment.date,
      refType: 'payment',
      ref: payment.invoiceNumber || '',
      description: [payment.methodName, payment.collectedBy].filter(Boolean).join(' — '),
      lines: [line(target, amount, 0), line(receivable, 0, amount)],
    })
  }

  /* ٣ — المصروفات: مصروف شركة، أو خصم من أمانة ميزانية عميل */
  for (const expense of expenses) {
    if (postedIds.has(`expenses:${expense.id}`)) continue
    const amount = toNumber(expense.amount)
    if (amount === 0) continue

    const category = expenseCategories.find((item) => item.id === expense.categoryId)
    const fundedByClient = Boolean(expense.clientId) && Boolean(category?.isAdSpend)

    /* الطرف المدين: عهدة إعلانات عميل، أو حساب مختار مباشرة، أو حساب الفئة */
    const chosenDebit =
      expense.target?.kind === 'account'
        ? accounts.find((account) => account.id === expense.target.id)
        : null
    const debitAccount = fundedByClient
      ? adHeld
      : chosenDebit ?? expenseAccount(accounts, expenseCategories, expense)

    /* الطرف الدائن: مستحق للمورد/الموظف لو «على الحساب»، وإلا الخزينة المختارة */
    const treasuryAccount = expense.treasuryAccountId
      ? accounts.find((account) => account.id === expense.treasuryAccountId)
      : null
    let creditAccount
    if (expense.settled === false && expense.target?.kind === 'vendor') {
      creditAccount = byRole(accounts, 'vendorPayable')
    } else if (expense.settled === false && expense.target?.kind === 'employee') {
      creditAccount = byRole(accounts, 'employeePayable')
    } else {
      creditAccount = treasuryAccount ?? cashOrBank(accounts, paymentMethods, expense.methodId, 'cash')
    }

    /*
     * مصروف بمبلغ سالب (خصم من مرتب موظف) يعكس الطرفين بدل أن ينزل
     * برقم سالب على كل طرف — رياضيًا متكافئ، لكن قيدًا سالبًا على
     * الطرفين يظهر فارغًا "—/—" في دفتر اليومية وكأن القيد ضاع.
     */
    const magnitude = Math.abs(amount)
    const isVendorExpense = expense.target?.kind === 'vendor' && Boolean(expense.target?.id)
    const expSubLedgerType = isVendorExpense ? 'vendor' : null
    const expSubLedgerId = isVendorExpense ? expense.target.id : null
    const expSubLedgerName = isVendorExpense ? (expense.target.name || '') : ''

    const lines =
      amount >= 0
        ? [
            line(debitAccount, magnitude, 0),
            {
              ...line(creditAccount, 0, magnitude),
              ...(isVendorExpense ? { subLedgerType: expSubLedgerType, subLedgerId: expSubLedgerId, subLedgerName: expSubLedgerName } : {}),
            },
          ]
        : [
            {
              ...line(creditAccount, magnitude, 0),
              ...(isVendorExpense ? { subLedgerType: expSubLedgerType, subLedgerId: expSubLedgerId, subLedgerName: expSubLedgerName } : {}),
            },
            line(debitAccount, 0, magnitude),
          ]

    entries.push({
      id: `exp-${expense.id}`,
      date: expense.date,
      refType: 'expense',
      ref: expense.categoryName || '',
      description: [expense.description, expense.target?.name].filter(Boolean).join(' — '),
      lines,
    })
  }

  /* ٤ — تكاليف الشغل المباشرة: مصروف إنتاج مقابل نقدية أو مستحق للمورد */
  const vendorPayable = byRole(accounts, 'vendorPayable')

  const employeePayable = byRole(accounts, 'employeePayable')

  for (const cost of jobCosts) {
    if (postedIds.has(`jobCosts:${cost.id}`)) continue
    const amount = toNumber(cost.amount)
    if (amount === 0) continue

    /* شغلانة إضافية لموظف على المرتب تُستحق لحساب مستحقات الموظفين،
       لا حساب الموردين — الاثنان التزامان مختلفان محاسبيًا */
    const isEmployeeLinked = Boolean(cost.employeeId)
    const isVendorLinked = Boolean(cost.vendorId)
    const debitAccount = byRole(accounts, COST_ROLE[cost.type] ?? 'costOther') ?? byRole(accounts, 'otherExpense')
    const creditAccount = cost.paid
      ? byRole(accounts, 'cash')
      : isEmployeeLinked
        ? employeePayable
        : vendorPayable
    const vendor = vendors.find((item) => item.id === cost.vendorId)

    const costSubLedgerType = isVendorLinked ? 'vendor' : isEmployeeLinked ? 'employee' : null
    const costSubLedgerId = isVendorLinked ? cost.vendorId : isEmployeeLinked ? cost.employeeId : null
    const costSubLedgerName = isVendorLinked ? (vendor?.name || '') : isEmployeeLinked ? (cost.employeeName || '') : ''

    entries.push({
      id: `cost-${cost.id}`,
      date: cost.date,
      refType: 'cost',
      ref: cost.employeeName ?? vendor?.name ?? '',
      description: cost.description || '',
      lines: [
        line(debitAccount, amount, 0),
        {
          ...line(creditAccount, 0, amount),
          ...(costSubLedgerType ? { subLedgerType: costSubLedgerType, subLedgerId: costSubLedgerId, subLedgerName: costSubLedgerName } : {}),
        },
      ],
    })
  }

  /* ٥ — القيود والمستندات اليدوية المخزَّنة */
  for (const voucher of vouchers) {
    if (postedIds.has(`voucher:${voucher.id}`) || postedIds.has(`journal:${voucher.id}`)) continue
    entries.push({
      id: `jv-${voucher.id}`,
      date: voucher.date,
      refType: voucher.type === 'manual' ? 'manual' : `voucher.${voucher.type}`,
      ref: voucher.number ?? '',
      description: voucher.description || '',
      lines: (voucher.lines ?? []).map((item) => ({
        ...line(
          accounts.find((account) => account.id === item.accountId),
          toNumber(item.debit),
          toNumber(item.credit),
        ),
        subLedgerType: item.subLedgerType || null,
        subLedgerId: item.subLedgerId || null,
        subLedgerName: item.subLedgerName || '',
      })),
    })
  }

  /* ٦ — الأصول: شراء، ثم إهلاك شهري بالقسط الثابت، ثم الصيانة */
  const equipment = byRole(accounts, 'equipment')
  const accumDep = byRole(accounts, 'accumDep')
  const depExpense = byRole(accounts, 'depreciation')
  const upkeep = byRole(accounts, 'maintenance')

  for (const asset of assets) {
    if (postedIds.has(`assets:${asset.id}`)) continue
    const cost = toNumber(asset.purchaseCost)

    if (cost > 0 && asset.purchaseDate) {
      /* مصدر الشراء: الحساب المحدَّد على الأصل (نقدية/بنك/موردون…)،
         وإلا موردون لو آجل، وإلا الخزينة */
      const payFrom =
        (asset.acquisitionAccountId &&
          accounts.find((account) => account.id === asset.acquisitionAccountId)) ||
        (asset.acquisition === 'credit' ? vendorPayable ?? byRole(accounts, 'cash') : byRole(accounts, 'cash'))
      /* حساب الأصل: المحدَّد يدويًا (مهم للأراضي والأصول الثابتة)، وإلا المعدات */
      const assetAccount =
        (asset.assetAccountId && accounts.find((account) => account.id === asset.assetAccountId)) || equipment

      /* سعر الشراء قبل الضريبة — ضريبة المدخلات تُثبَت مدينة على حساب
         الضرائب المستحقة (تقاصّ من ضريبة المخرجات)، والدائن بالمبلغ شاملًا */
      const taxRate =
        asset.taxKind === 'tax2'
          ? toNumber(settings.taxRate2)
          : asset.taxKind === 'tax1'
            ? toNumber(settings.taxRate1 ?? settings.taxRate)
            : 0
      const inputTax = round2((cost * taxRate) / 100)

      const lines =
        inputTax > 0 && tax
          ? [line(assetAccount, cost, 0), line(tax, inputTax, 0), line(payFrom, 0, round2(cost + inputTax))]
          : [line(assetAccount, cost, 0), line(payFrom, 0, cost)]

      entries.push({
        id: `asset-${asset.id}`,
        date: asset.purchaseDate,
        refType: 'asset',
        ref: asset.name ?? '',
        description: asset.serial || '',
        lines,
      })
    }

    /* حسابات الإهلاك المخصّصة لكل أصل، وإلا الأدوار الافتراضية */
    const assetDepExpense =
      (asset.depExpenseAccountId && accounts.find((account) => account.id === asset.depExpenseAccountId)) ||
      depExpense
    const assetAccumDep =
      (asset.accumDepAccountId && accounts.find((account) => account.id === asset.accumDepAccountId)) ||
      accumDep

    const plan = depreciation(asset, asOf, assetUsage)
    plan.schedule.forEach((row, index) => {
      entries.push({
        id: `dep-${asset.id}-${index}`,
        date: row.date,
        refType: 'depreciation',
        ref: asset.name ?? '',
        description: '',
        lines: [line(assetDepExpense, row.amount, 0), line(assetAccumDep, 0, row.amount)],
      })
    })
  }

  for (const row of maintenance) {
    const amount = toNumber(row.cost)
    if (amount === 0) continue

    entries.push({
      id: `maint-${row.id}`,
      date: row.date,
      refType: 'maintenance',
      ref: row.assetName ?? '',
      description: row.description || '',
      lines: [line(upkeep, amount, 0), line(byRole(accounts, 'cash'), 0, amount)],
    })
  }

  /**
   * قيد ينقصه حساب لا يُرحَّل أبدًا بطرف واحد — وإلا اختل ميزان المراجعة
   * بصمت. يُستبعد كاملًا، وتنبّه الواجهة إلى الحسابات الناقصة.
   */
  return entries
    .filter((entry) => entry.lines.length > 0 && entry.lines.every((item) => item.accountId))
    .map((entry) => ({
      ...entry,
      total: round2(entry.lines.reduce((sum, item) => sum + item.debit, 0)),
    }))
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
}

/** حركات حساب واحد (أو حساب رئيسي/مجموعة مع كافة حساباته الفرعية التابعة) مع الرصيد التراكمي */
export function accountMovements(journal, accountId, accounts = []) {
  let running = 0
  const rows = []

  const targetAccount = accounts.find((a) => a.id === accountId)
  const targetCode = targetAccount ? String(targetAccount.code) : null

  // إيجاد كافة المعرفات التابعة للحساب (سواء كان حساباً تفصيلياً أو حساب أباً/مجموعة)
  const targetIds = new Set()
  if (accountId) {
    targetIds.add(accountId)
  }

  if (targetCode && accounts.length > 0) {
    const childrenMap = new Map()
    for (const account of accounts) {
      const parent = account.parentCode ? String(account.parentCode) : null
      if (parent) {
        childrenMap.set(parent, [...(childrenMap.get(parent) ?? []), account])
      }
    }
    const collect = (code) => {
      const children = childrenMap.get(code) ?? []
      for (const child of children) {
        targetIds.add(child.id)
        collect(String(child.code))
      }
    }
    collect(targetCode)
  }

  const subLedgerTargetIds = new Set()
  for (const id of targetIds) {
    if (typeof id === 'string') {
      const rawId = id.replace(/^(client|vendor|emp-payable|emp-advance)-/, '')
      subLedgerTargetIds.add(rawId)
      subLedgerTargetIds.add(id)
    } else {
      subLedgerTargetIds.add(id)
    }
  }

  for (const entry of journal) {
    for (const item of entry.lines) {
      const matchAccount = targetIds.has(item.accountId)
      const rawSubLedgerId = item.subLedgerId ? String(item.subLedgerId).replace(/^(client|vendor|emp-payable|emp-advance)-/, '') : null
      const matchSubLedger = Boolean(
        item.subLedgerId && (subLedgerTargetIds.has(item.subLedgerId) || (rawSubLedgerId && subLedgerTargetIds.has(rawSubLedgerId)))
      )
      if (!matchAccount && !matchSubLedger) continue

      running += item.debit - item.credit
      rows.push({
        entryId: entry.id,
        date: entry.date,
        ref: entry.ref,
        refType: entry.refType,
        description: entry.description,
        debit: item.debit,
        credit: item.credit,
        balance: round2(running),
        subAccountId: item.accountId,
        subAccountCode: item.code ?? item.account?.code ?? '—',
        subAccountName: item.account?.name ?? item.account?.nameEn ?? '—',
        account: item.account,
        subLedgerType: item.subLedgerType || null,
        subLedgerId: item.subLedgerId || null,
        subLedgerName: item.subLedgerName || '',
      })
    }
  }

  return rows
}

/** أرصدة كل الحسابات — أساس ميزان المراجعة والقوائم المالية */
export function accountBalances(journal, accounts) {
  const map = new Map(accounts.map((account) => [account.id, { account, debit: 0, credit: 0 }]))

  for (const entry of journal) {
    for (const item of entry.lines) {
      let bucket = map.get(item.accountId)
      if (item.subLedgerType === 'client' && item.subLedgerId) {
        const rawId = String(item.subLedgerId).replace(/^client-/, '')
        const clientBucket = map.get(`client-${rawId}`) || map.get(rawId)
        if (clientBucket) bucket = clientBucket
      } else if (item.subLedgerType === 'vendor' && item.subLedgerId) {
        const rawId = String(item.subLedgerId).replace(/^vendor-/, '')
        const vendorBucket = map.get(`vendor-${rawId}`) || map.get(rawId)
        if (vendorBucket) bucket = vendorBucket
      } else if (item.subLedgerType === 'employee' && item.subLedgerId) {
        const rawId = String(item.subLedgerId).replace(/^emp-(payable|advance)-/, '')
        const payBucket = map.get(`emp-payable-${rawId}`)
        const advBucket = map.get(`emp-advance-${rawId}`)
        if (item.accountId && String(item.accountId).includes('110203')) {
          if (advBucket) bucket = advBucket
        } else {
          if (payBucket) bucket = payBucket || map.get(rawId)
        }
      }
      if (!bucket) continue
      bucket.debit += item.debit
      bucket.credit += item.credit
    }
  }

  return [...map.values()]
    .map((bucket) => {
      const normal = getNormalBalance(bucket.account)
      const raw = bucket.debit - bucket.credit
      return {
        ...bucket,
        debit: round2(bucket.debit),
        credit: round2(bucket.credit),
        balance: round2(normal === 'debit' ? raw : -raw),
        net: round2(raw),
      }
    })
    .sort((a, b) => String(a.account.code).localeCompare(String(b.account.code)))
}

/**
 * قائمة التدفقات النقدية (الطريقة المباشرة، مبسّطة): صافي حركة النقدية
 * والبنوك خلال الفترة، مبوّبة تشغيلي / استثماري / تمويلي حسب نوع المستند.
 */
export function cashFlow(journal, accounts) {
  const cashIds = new Set(
    accounts.filter((account) => account.role === 'cash' || account.role === 'bank').map((account) => account.id),
  )

  const bucket = {
    operatingIn: 0, operatingOut: 0,
    investingIn: 0, investingOut: 0,
    financingIn: 0, financingOut: 0,
  }
  const rows = []

  for (const entry of journal) {
    const cashLines = entry.lines.filter((item) => cashIds.has(item.accountId))
    if (cashLines.length === 0) continue

    const delta = round2(cashLines.reduce((sum, item) => sum + item.debit - item.credit, 0))
    if (delta === 0) continue

    let category = 'operating'
    if (entry.refType === 'asset') category = 'investing'
    else if (
      entry.refType === 'voucher.opening' ||
      entry.refType === 'voucher.drawing' ||
      entry.refType === 'voucher.transfer'
    ) {
      category = 'financing'
    }

    bucket[`${category}${delta > 0 ? 'In' : 'Out'}`] += Math.abs(delta)
    rows.push({
      id: entry.id, date: entry.date, refType: entry.refType,
      ref: entry.ref, description: entry.description, delta,
    })
  }

  const operating = round2(bucket.operatingIn - bucket.operatingOut)
  const investing = round2(bucket.investingIn - bucket.investingOut)
  const financing = round2(bucket.financingIn - bucket.financingOut)

  return {
    operatingIn: round2(bucket.operatingIn),
    operatingOut: round2(bucket.operatingOut),
    investingIn: round2(bucket.investingIn),
    investingOut: round2(bucket.investingOut),
    financingIn: round2(bucket.financingIn),
    financingOut: round2(bucket.financingOut),
    operating, investing, financing,
    net: round2(operating + investing + financing),
    rows: rows.sort((a, b) => String(a.date).localeCompare(String(b.date))),
  }
}

/** إجمالي رصيد نوع معيّن من الحسابات */
export function totalOfType(balances, type) {
  return round2(
    balances
      .filter((row) => row.account.type === type && !row.account.isGroup)
      .reduce((sum, row) => sum + row.balance, 0),
  )
}
