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
  if (expense.accountId) {
    const direct = accounts.find((a) => a.id === expense.accountId || String(a.code) === String(expense.accountCode))
    if (direct) return direct
  }
  if (expense.accountCode) {
    const byCode = accounts.find((a) => !a.isGroup && String(a.code) === String(expense.accountCode))
    if (byCode) return byCode
  }
  const category = categories.find((item) => item.id === expense.categoryId)
  if (category?.accountId) {
    const mapped = accounts.find((account) => account.id === category.accountId)
    if (mapped) return mapped
  }
  const catName = (category?.name || expense.categoryName || '').toLowerCase()
  const expDesc = (expense.description || '').toLowerCase()
  const combined = `${catName} ${expDesc}`

  if (expense.source === 'employee' || category?.system === 'salary' || combined.includes('مرتب') || combined.includes('رواتب')) {
    return byRole(accounts, 'salaryExpense') || byRole(accounts, 'otherExpense')
  }
  if (combined.includes('إيجار') || combined.includes('ايجار')) {
    return byRole(accounts, 'rentExpense') || byRole(accounts, 'otherExpense')
  }
  if (combined.includes('كهرباء') || combined.includes('مياه') || combined.includes('غاز') || combined.includes('مرافق')) {
    return byRole(accounts, 'utilitiesExpense') || byRole(accounts, 'otherExpense')
  }
  if (combined.includes('هاتف') || combined.includes('انترنت') || combined.includes('إنترنت') || combined.includes('اتصالات')) {
    return byRole(accounts, 'telecomExpense') || byRole(accounts, 'otherExpense')
  }
  if (combined.includes('إعلان') || combined.includes('اعلان') || combined.includes('تسويق') || combined.includes('حملة') || combined.includes('فيسبوك') || combined.includes('تيك توك') || combined.includes('سناب')) {
    return byRole(accounts, 'marketingExpense') || byRole(accounts, 'otherExpense')
  }
  if (combined.includes('صيانة')) {
    return byRole(accounts, 'maintenance') || byRole(accounts, 'otherExpense')
  }
  if (combined.includes('بنك') || combined.includes('عمولة بنكية') || combined.includes('مصاريف بنكية')) {
    return byRole(accounts, 'bankExpense') || byRole(accounts, 'otherExpense')
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
  clients = [],
  purchaseInvoices = [],
  vendorPayments = [],
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

  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]))
  const paymentMap = new Map(payments.map((p) => [p.id, p]))
  const purchaseInvoiceMap = new Map(purchaseInvoices.map((pi) => [pi.id, pi]))
  const vendorPaymentMap = new Map(vendorPayments.map((vp) => [vp.id, vp]))
  const clientMap = new Map(clients.map((c) => [c.id, c]))
  const vendorMap = new Map(vendors.map((v) => [v.id, v]))
  const voucherMap = new Map(vouchers.map((v) => [v.id, v]))
  const expenseMap = new Map(expenses.map((e) => [e.id, e]))
  const jobCostMap = new Map(jobCosts.map((j) => [j.id, j]))
  const recAcc = receivable || accounts.find((a) => a.role === 'receivable' || String(a.code) === '110201' || String(a.code) === '112')
  const isRecAccount = (accId, accCode) => {
    if (!accId && !accCode) return false
    const acc = accounts.find((a) => a.id === accId || (accCode && String(a.code) === String(accCode)))
    return (
      accId === recAcc?.id ||
      acc?.role === 'receivable' ||
      String(acc?.code) === '1-01-03-01-01-001' ||
      String(acc?.code) === '110201' ||
      String(acc?.code) === '112'
    )
  }

  const isVendorAccount = (accId, accCode) => {
    if (!accId && !accCode) return false
    const acc = accounts.find((a) => a.id === accId || (accCode && String(a.code) === String(accCode)))
    return (
      acc?.role === 'vendorPayable' ||
      acc?.role === 'vendorAdvance' ||
      String(acc?.code).startsWith('2-01-01') ||
      String(acc?.code).startsWith('2101') ||
      String(acc?.code).startsWith('211')
    )
  }

  for (const tx of postedTransactions) {
    let defaultSubLedgerType = null
    let defaultSubLedgerId = null
    let defaultSubLedgerName = ''

    let ref = tx.referenceNumber || ''
    let invoiceNumber = ''
    let invoiceId = tx.invoiceId || null
    let purchaseInvoiceId = tx.purchaseInvoiceId || null
    let voucherId = tx.voucherId || null
    let expenseId = tx.expenseId || null
    let clientName = ''
    let vendorName = ''
    let partyName = ''
    let description = tx.description || ''
    let refType = tx.sourceType

    if (tx.sourceType === 'invoice') {
      invoiceId = tx.sourceId || invoiceId
      const inv = invoiceMap.get(tx.sourceId) || invoices.find((i) => i.id === tx.sourceId)
      if (inv) {
        invoiceNumber = inv.number || ''
        clientName = inv.clientName || clientMap.get(inv.clientId)?.name || ''
        partyName = clientName
        if (!ref) ref = inv.number || ''
        if (!description) description = clientName ? `فاتورة مبيعات — ${clientName}` : 'فاتورة مبيعات'
        if (inv.clientId) {
          defaultSubLedgerType = 'client'
          defaultSubLedgerId = inv.clientId
          defaultSubLedgerName = clientName
        }
      }
    } else if (tx.sourceType === 'payment') {
      const p = paymentMap.get(tx.sourceId) || payments.find((pay) => pay.id === tx.sourceId)
      const invId = p?.invoiceId || (tx.lines || []).find((l) => l.invoiceId)?.invoiceId
      const inv = invId ? (invoiceMap.get(invId) || invoices.find((i) => i.id === invId)) : null
      invoiceId = invId || p?.invoiceId || invoiceId

      invoiceNumber = p?.invoiceNumber || inv?.number || ''
      clientName = p?.clientName || inv?.clientName || clientMap.get(p?.clientId || inv?.clientId)?.name || ''
      partyName = clientName
      if (!ref) ref = invoiceNumber || p?.ref || ''
      if (!description) {
        description = p?.notes || (clientName ? `تحصيل دفعة — ${clientName}${invoiceNumber ? ` (فاتورة #${invoiceNumber})` : ''}` : 'تحصيل دفعة')
      }
      if (p?.clientId || inv?.clientId) {
        defaultSubLedgerType = 'client'
        defaultSubLedgerId = p?.clientId || inv?.clientId
        defaultSubLedgerName = clientName
      }
    } else if (tx.sourceType === 'purchaseInvoice') {
      purchaseInvoiceId = tx.sourceId || purchaseInvoiceId
      const pi = purchaseInvoiceMap.get(tx.sourceId) || purchaseInvoices.find((p) => p.id === tx.sourceId)
      if (pi) {
        invoiceNumber = pi.number || ''
        vendorName = pi.vendorName || vendorMap.get(pi.vendorId)?.name || tx.vendorName || ''
        partyName = vendorName
        if (!ref) ref = pi.number || ''
        if (!description) description = pi.notes || (vendorName ? `فاتورة مشتريات — ${vendorName}` : 'فاتورة مشتريات')
      }
    } else if (tx.sourceType === 'vendorPayment') {
      const vp = vendorPaymentMap.get(tx.sourceId) || vendorPayments.find((v) => v.id === tx.sourceId)
      const pi = vp?.purchaseInvoiceId ? (purchaseInvoiceMap.get(vp.purchaseInvoiceId) || purchaseInvoices.find((p) => p.id === vp.purchaseInvoiceId)) : null
      purchaseInvoiceId = vp?.purchaseInvoiceId || purchaseInvoiceId
      invoiceNumber = pi?.number || vp?.purchaseInvoiceNumber || ''
      vendorName = vp?.vendorName || pi?.vendorName || vendorMap.get(vp?.vendorId || pi?.vendorId)?.name || tx.vendorName || ''
      partyName = vendorName
      if (!ref) ref = invoiceNumber || vp?.ref || ''
      if (!description) {
        description = vp?.notes || (vendorName ? `سداد مورد — ${vendorName}${invoiceNumber ? ` (فاتورة #${invoiceNumber})` : ''}` : 'سداد للمورد')
      }
    } else if (tx.sourceType === 'voucher') {
      voucherId = tx.sourceId || voucherId
      const v = voucherMap.get(tx.sourceId) || vouchers.find((v) => v.id === tx.sourceId)
      if (v) {
        if (!ref) ref = v.number || ''
        if (!description) description = v.description || ''
        if (v.type) refType = v.type === 'manual' ? 'manual' : `voucher.${v.type}`
      }
    } else if (tx.sourceType === 'expense') {
      expenseId = tx.sourceId || expenseId
      const exp = expenseMap.get(tx.sourceId) || expenses.find((e) => e.id === tx.sourceId)
      if (exp) {
        if (!ref) ref = exp.ref || ''
        if (!description) description = exp.description || (exp.category ? `مصروف — ${exp.category}` : 'مصروف')
      }
    } else if (tx.sourceType === 'jobCosts' || tx.sourceType === 'invoice_item_cost') {
      const jc = jobCostMap.get(tx.sourceId) || jobCosts.find((j) => j.id === tx.sourceId)
      const inv = jc?.invoiceId ? (invoiceMap.get(jc.invoiceId) || invoices.find((i) => i.id === jc.invoiceId)) : null
      invoiceId = jc?.invoiceId || inv?.id || invoiceId
      invoiceNumber = jc?.invoiceNumber || inv?.number || ''
      clientName = jc?.clientName || inv?.clientName || ''
      partyName = clientName
      if (!ref) ref = invoiceNumber || ''
      if (!description) description = jc?.serviceName || jc?.description || 'تكلفة أمر عمل'
    }

    if (!partyName) {
      const subLine = (tx.lines || []).find((l) => l.subLedgerName)
      if (subLine) partyName = subLine.subLedgerName
    }

    const defaultVendorSubLedger = tx.vendorId || tx.supplierId || null
    const defaultVendorSubLedgerName = vendorName || tx.vendorName || tx.supplierName || ''

    entries.push({
      id: tx.id,
      date: tx.transactionDate,
      refType,
      ref,
      invoiceNumber,
      invoiceId,
      purchaseInvoiceId,
      voucherId,
      expenseId,
      clientName,
      vendorName,
      partyName,
      description,
      lines: (tx.lines || []).map((lineItem) => {
        const attachSubLedger = !lineItem.subLedgerType && defaultSubLedgerType && isRecAccount(lineItem.accountId, lineItem.accountCode)
        const attachVendorSubLedger = !lineItem.subLedgerType && defaultVendorSubLedger && isVendorAccount(lineItem.accountId, lineItem.accountCode)
        
        const subType = lineItem.subLedgerType || (attachSubLedger ? defaultSubLedgerType : (attachVendorSubLedger ? 'vendor' : null))
        const subId = lineItem.subLedgerId || (attachSubLedger ? defaultSubLedgerId : (attachVendorSubLedger ? defaultVendorSubLedger : null))
        const subName = lineItem.subLedgerName || (attachSubLedger ? defaultSubLedgerName : (attachVendorSubLedger ? defaultVendorSubLedgerName : partyName))

        const matchedAccount =
          accounts.find((a) => a.id === lineItem.accountId) ||
          (lineItem.accountCode && accounts.find((a) => String(a.code) === String(lineItem.accountCode))) ||
          (lineItem.accountRole && byRole(accounts, lineItem.accountRole)) ||
          { id: lineItem.accountId, code: lineItem.accountCode || '—', name: 'Unknown' }

        return {
          accountId: matchedAccount?.id || lineItem.accountId,
          code: matchedAccount?.code ?? lineItem.accountCode ?? '—',
          account: matchedAccount,
          debit: toNumber(lineItem.debit),
          credit: toNumber(lineItem.credit),
          subLedgerType: subType,
          subLedgerId: subId,
          subLedgerName: subName,
          invoiceNumber,
          invoiceId: lineItem.invoiceId || invoiceId,
          purchaseInvoiceId: lineItem.purchaseInvoiceId || purchaseInvoiceId,
          voucherId: lineItem.voucherId || voucherId,
          expenseId: lineItem.expenseId || expenseId,
          clientName,
          vendorName,
          partyName,
        }
      }),
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

    const lines = [
      {
        ...line(receivable, total, 0),
        subLedgerType: 'client',
        subLedgerId: invoice.clientId,
        subLedgerName: invoice.clientName || '',
      },
    ]
    if (fees !== 0) lines.push(line(revenue, 0, fees))
    if (adBudget !== 0) lines.push(line(adHeld, 0, adBudget))
    if (taxAmount !== 0) lines.push(line(tax, 0, taxAmount))

    entries.push({
      id: `inv-${invoice.id}`,
      date: invoice.date,
      refType: 'invoice',
      ref: invoice.number,
      invoiceNumber: invoice.number,
      invoiceId: invoice.id,
      clientName: invoice.clientName || '',
      partyName: invoice.clientName || '',
      description: invoice.clientName ? `فاتورة مبيعات — ${invoice.clientName}` : 'فاتورة مبيعات',
      lines: lines.map((l) => ({ ...l, invoiceId: invoice.id, invoiceNumber: invoice.number })),
    })

    /* فاتورة ملغاة: قيد عكسي بتاريخ الإلغاء بدل حذف الأثر المحاسبي */
    if (invoice.cancelled) {
      entries.push({
        id: `inv-rev-${invoice.id}`,
        date: invoice.cancelledDate || invoice.date,
        refType: 'creditNote',
        ref: invoice.number,
        invoiceNumber: invoice.number,
        invoiceId: invoice.id,
        description: invoice.cancelReason || '',
        lines: lines.map((item) => ({ ...line(item.account, item.credit, item.debit), invoiceId: invoice.id, invoiceNumber: invoice.number })),
      })
    }
  }

  /* ٢ — التحصيلات: تحويل مديونية إلى نقدية */
  const adTreasury = byRole(accounts, 'adTreasury')

  for (const payment of payments) {
    if (postedIds.has(`payments:${payment.id}`) || postedIds.has(`payment:${payment.id}`)) continue

    let parentInv = null
    if (payment.invoiceId) {
      parentInv = invoiceMap.get(payment.invoiceId)
      if (!parentInv || parentInv.cancelled) continue
    }

    const amount = toNumber(payment.amount)
    if (amount === 0) continue

    const target = cashOrBank(accounts, paymentMethods, payment.methodId, payment.methodType)
    const invTotal = toNumber(parentInv?.total)
    const invAdBudget = toNumber(parentInv?.adBudgetTotal)

    const paymentLines = []
    if (invAdBudget > 0 && adTreasury && invTotal > 0) {
      const adRatio = Math.min(1, Math.max(0, invAdBudget / invTotal))
      const adPayment = round2(amount * adRatio)
      const feesPayment = round2(amount - adPayment)

      if (feesPayment > 0) paymentLines.push(line(target, feesPayment, 0))
      if (adPayment > 0) paymentLines.push(line(adTreasury, adPayment, 0))
    } else {
      paymentLines.push(line(target, amount, 0))
    }
    paymentLines.push({
      ...line(receivable, 0, amount),
      subLedgerType: 'client',
      subLedgerId: payment.clientId || parentInv?.clientId,
      subLedgerName: payment.clientName || parentInv?.clientName || '',
    })

    const clientName = payment.clientName || parentInv?.clientName || ''
    const invoiceNumber = payment.invoiceNumber || parentInv?.number || ''
    const invId = payment.invoiceId || parentInv?.id || null
    entries.push({
      id: `pay-${payment.id}`,
      date: payment.date,
      refType: 'payment',
      ref: invoiceNumber || payment.ref || '',
      invoiceNumber,
      invoiceId: invId,
      clientName,
      partyName: clientName,
      description: payment.notes || [payment.methodName, payment.collectedBy].filter(Boolean).join(' — ') || (clientName ? `تحصيل دفعة — ${clientName}${invoiceNumber ? ` (فاتورة #${invoiceNumber})` : ''}` : 'تحصيل دفعة'),
      lines: paymentLines.map((l) => ({ ...l, invoiceId: invId, invoiceNumber })),
    })
  }

  /* ٣ — المصروفات: مصروف شركة، أو خصم من أمانة ميزانية عميل */
  for (const expense of expenses) {
    if (postedIds.has(`expenses:${expense.id}`)) continue
    const amount = toNumber(expense.amount)
    if (amount === 0) continue

    const category = expenseCategories.find((item) => item.id === expense.categoryId)
    const fundedByClient = Boolean(expense.clientId) && Boolean(category?.isAdSpend)

    /* الطرف المدين: عهدة إعلانات عميل، أو حساب فرعي مختار مباشرة، أو حساب الفئة */
    const chosenDebit =
      (expense.accountId && accounts.find((account) => account.id === expense.accountId || String(account.code) === String(expense.accountCode))) ||
      (expense.debitAccountId && accounts.find((account) => account.id === expense.debitAccountId || String(account.code) === String(expense.debitAccountId))) ||
      (expense.target?.kind === 'account'
        ? accounts.find((account) => account.id === expense.target.id)
        : null)
    const debitAccount = fundedByClient
      ? adHeld
      : chosenDebit ?? expenseAccount(accounts, expenseCategories, expense)

    /* الطرف الدائن: مستحق للمورد/الموظف لو «على الحساب»، وإلا الخزينة المختارة أو محفظة الإعلانات */
    const treasuryAccount = expense.treasuryAccountId
      ? accounts.find((account) => account.id === expense.treasuryAccountId)
      : null
    let creditAccount
    if (expense.settled === false && expense.target?.kind === 'vendor') {
      creditAccount = byRole(accounts, 'vendorPayable')
    } else if (expense.settled === false && expense.target?.kind === 'employee') {
      creditAccount = byRole(accounts, 'employeePayable')
    } else {
      creditAccount =
        fundedByClient && !expense.treasuryAccountId && adTreasury
          ? adTreasury
          : (treasuryAccount ?? cashOrBank(accounts, paymentMethods, expense.methodId, 'cash'))
    }

    /*
     * مصروف بمبلغ سالب (خصم من مرتب موظف) يعكس الطرفين بدل أن ينزل
     * برقم سالب على كل طرف — رياضيًا متكافئ، لكن قيدًا سالبًا على
     * الطرفين يظهر فارغًا "—/—" في دفتر اليومية وكأن القيد ضاع.
     */
    const magnitude = Math.abs(amount)
    const isVendorExpense = expense.target?.kind === 'vendor' && Boolean(expense.target?.id)
    const isEmployeeExpense = (expense.target?.kind === 'employee' && Boolean(expense.target?.id)) || Boolean(expense.employeeId)
    const isClientExpense = (expense.target?.kind === 'client' && Boolean(expense.target?.id)) || Boolean(expense.clientId)

    const expSubLedgerType = isVendorExpense ? 'vendor' : isEmployeeExpense ? 'employee' : isClientExpense ? 'client' : null
    const expSubLedgerId = isVendorExpense
      ? expense.target.id
      : isEmployeeExpense
        ? (expense.target?.id || expense.employeeId)
        : isClientExpense
          ? (expense.target?.id || expense.clientId)
          : null
    const expSubLedgerName = isVendorExpense
      ? (expense.target.name || '')
      : isEmployeeExpense
        ? (expense.target?.name || expense.employeeName || '')
        : isClientExpense
          ? (expense.target?.name || expense.clientName || '')
          : ''

    const subLedgerTag = expSubLedgerType
      ? { subLedgerType: expSubLedgerType, subLedgerId: expSubLedgerId, subLedgerName: expSubLedgerName }
      : {}

    const isAdvance =
      debitAccount?.role === 'employeeAdvance' ||
      String(debitAccount?.code).startsWith('1-01-06-02') ||
      String(debitAccount?.code) === '110203'

    const isPayable =
      creditAccount?.role === 'employeePayable' ||
      creditAccount?.role === 'vendorPayable' ||
      String(creditAccount?.code).startsWith('2-01-03') ||
      String(creditAccount?.code).startsWith('2-01-01')

    const debitTag = (isAdvance || (isEmployeeExpense && !isPayable) || (isClientExpense && !isPayable)) ? subLedgerTag : {}
    const creditTag = (isPayable || (!isAdvance && expSubLedgerType)) ? subLedgerTag : {}

    const lines =
      amount >= 0
        ? [
            { ...line(debitAccount, magnitude, 0), ...debitTag },
            { ...line(creditAccount, 0, magnitude), ...creditTag },
          ]
        : [
            { ...line(creditAccount, magnitude, 0), ...creditTag },
            { ...line(debitAccount, 0, magnitude), ...debitTag },
          ]

    entries.push({
      id: `exp-${expense.id}`,
      date: expense.date,
      refType: 'expense',
      ref: debitAccount ? String(debitAccount.code) : (expense.categoryName || ''),
      expenseId: expense.id,
      partyName: expSubLedgerName || expense.target?.name || '',
      clientName: isClientExpense ? expSubLedgerName : '',
      vendorName: isVendorExpense ? expSubLedgerName : '',
      employeeName: isEmployeeExpense ? expSubLedgerName : '',
      description: [expense.description, expSubLedgerName || expense.target?.name].filter(Boolean).join(' — '),
      lines: lines.map((l) => ({ ...l, expenseId: expense.id })),
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
      voucherId: voucher.id,
      description: voucher.description || '',
      lines: (voucher.lines ?? []).map((item) => ({
        ...line(
          accounts.find((account) => account.id === item.accountId),
          toNumber(item.debit),
          toNumber(item.credit),
        ),
        voucherId: voucher.id,
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
export function accountMovements(journal, accountId, accounts = [], filterSubId = null) {
  let running = 0
  const rows = []

  const targetAccount = accounts.find((a) => a.id === accountId)
  if (!targetAccount && !accountId) return rows

  const targetCode = targetAccount ? String(targetAccount.code) : null
  const normal = getNormalBalance(targetAccount)

  // 1. تحديد نوع الحساب المختار (رئيسي، فرعي من الدليل، أو حساب أستاذ مساعد لطرف محدد)
  const isEmployeeFull = Boolean(targetAccount?.isEmployeeFullNode)
  const isEmployeePayable = Boolean(targetAccount?.id?.startsWith('emp-payable-'))
  const isEmployeeAdvance = Boolean(targetAccount?.id?.startsWith('emp-advance-'))
  const isEmployeeSubNode = isEmployeeFull || isEmployeePayable || isEmployeeAdvance || Boolean(targetAccount?.isEmployeeNode)
  const targetEmpId = targetAccount?.employeeId || (isEmployeeSubNode ? String(targetAccount?.id || '').replace(/^emp-(payable|advance|full)-/, '') : null)

  const isClientNode = Boolean(targetAccount?.isClientNode || targetAccount?.id?.startsWith('client-'))
  const targetClientId = targetAccount?.clientId || (isClientNode ? String(targetAccount?.id || '').replace(/^client-/, '') : null)

  const isVendorNode = Boolean(targetAccount?.isVendorNode || targetAccount?.id?.startsWith('vendor-'))
  const targetVendorId = targetAccount?.vendorId || (isVendorNode ? String(targetAccount?.id || '').replace(/^vendor-/, '') : null)

  // 2. جمع كافة المعرفات التابعة للحساب (سواء كان حساباً تفصيلياً أو حساب أباً/مجموعة)
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

  for (const entry of journal) {
    for (const item of entry.lines) {
      let isMatch = false

      if (isEmployeeFull) {
        // كشف حساب موظف شامل: يطابق أي حركة خاصة بهذا الموظف
        const itemEmpId = item.subLedgerId ? String(item.subLedgerId).replace(/^emp-(payable|advance|full)-/, '') : null
        isMatch = item.subLedgerType === 'employee' && (itemEmpId === targetEmpId || item.subLedgerId === targetEmpId)
      } else if (isEmployeePayable) {
        // أستاذ مساعد مستحقات موظف (رواتب، مستحقات، بدلات، سداد مستحقات)
        const itemEmpId = item.subLedgerId ? String(item.subLedgerId).replace(/^emp-(payable|advance|full)-/, '') : null
        const matchEmp = item.subLedgerType === 'employee' && (itemEmpId === targetEmpId || item.subLedgerId === targetEmpId)
        const isPayableLine =
          item.account?.role === 'employeePayable' ||
          String(item.code).startsWith('2-01-03') ||
          String(item.code) === '210201' ||
          String(item.code).startsWith('2102') ||
          targetIds.has(item.accountId)
        isMatch = matchEmp && isPayableLine
      } else if (isEmployeeAdvance) {
        // أستاذ مساعد سلف وعُهد موظف
        const itemEmpId = item.subLedgerId ? String(item.subLedgerId).replace(/^emp-(payable|advance|full)-/, '') : null
        const matchEmp = item.subLedgerType === 'employee' && (itemEmpId === targetEmpId || item.subLedgerId === targetEmpId)
        const isAdvanceLine =
          item.account?.role === 'employeeAdvance' ||
          String(item.code).startsWith('1-01-06-02') ||
          String(item.code) === '110203' ||
          targetIds.has(item.accountId)
        isMatch = matchEmp && isAdvanceLine
      } else if (isClientNode) {
        // أستاذ مساعد عميل محدد
        const itemClientId = item.subLedgerId ? String(item.subLedgerId).replace(/^client-/, '') : null
        const isTargetClient = itemClientId === targetClientId || item.subLedgerId === targetClientId || item.clientId === targetClientId
        const isClientType = item.subLedgerType === 'client' || Boolean(entry.clientName)
        isMatch = (isTargetClient && (isClientType || targetIds.has(item.accountId))) || (targetIds.has(item.accountId) && isTargetClient)
      } else if (isVendorNode) {
        // أستاذ مساعد مورد محدد
        const itemVendorId = item.subLedgerId ? String(item.subLedgerId).replace(/^vendor-/, '') : null
        const isTargetVendor = itemVendorId === targetVendorId || item.subLedgerId === targetVendorId || item.vendorId === targetVendorId
        const isVendorType = item.subLedgerType === 'vendor' || Boolean(entry.vendorName)
        isMatch = (isTargetVendor && (isVendorType || targetIds.has(item.accountId))) || (targetIds.has(item.accountId) && isTargetVendor)
      } else {
        // حساب من الدليل (رئيسي أو فرعي)
        isMatch = targetIds.has(item.accountId)
      }

      // إذا وُجد فلتر إضافي لطرف معين داخل الحساب
      if (isMatch && filterSubId && filterSubId !== 'all') {
        const rawSubId = item.subLedgerId ? String(item.subLedgerId).replace(/^(client|vendor|emp-payable|emp-advance|emp-full)-/, '') : null
        const cleanFilter = String(filterSubId).replace(/^(client|vendor|emp-payable|emp-advance|emp-full)-/, '')
        const matchesParty =
          item.subLedgerId === filterSubId ||
          rawSubId === cleanFilter ||
          (item.subLedgerType === 'employee' && rawSubId === cleanFilter) ||
          (item.subLedgerType === 'client' && rawSubId === cleanFilter) ||
          (item.subLedgerType === 'vendor' && rawSubId === cleanFilter)
        if (!matchesParty) {
          isMatch = false
        }
      }

      if (!isMatch) continue

      running += normal === 'credit' ? (item.credit - item.debit) : (item.debit - item.credit)
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
        subLedgerType: item.subLedgerType || (entry.clientName ? 'client' : (entry.vendorName ? 'vendor' : (entry.employeeName ? 'employee' : null))),
        subLedgerId: item.subLedgerId || null,
        subLedgerName: item.subLedgerName || entry.partyName || entry.clientName || entry.vendorName || entry.employeeName || '',
        invoiceNumber: entry.invoiceNumber || item.invoiceNumber || (entry.refType === 'invoice' ? entry.ref : ''),
        invoiceId: item.invoiceId || entry.invoiceId || (entry.refType === 'invoice' && String(entry.id).startsWith('inv-') ? String(entry.id).replace(/^inv-/, '') : null) || null,
        purchaseInvoiceId: item.purchaseInvoiceId || entry.purchaseInvoiceId || (entry.refType === 'purchaseInvoice' && String(entry.id).startsWith('pi-') ? String(entry.id).replace(/^pi-/, '') : null) || null,
        voucherId: item.voucherId || entry.voucherId || ((entry.refType?.startsWith('voucher') || entry.refType === 'manual') && String(entry.id).startsWith('jv-') ? String(entry.id).replace(/^jv-/, '') : null) || null,
        expenseId: item.expenseId || entry.expenseId || (entry.refType === 'expense' && String(entry.id).startsWith('exp-') ? String(entry.id).replace(/^exp-/, '') : null) || null,
        clientName: entry.clientName || item.clientName || (item.subLedgerType === 'client' ? item.subLedgerName : ''),
        vendorName: entry.vendorName || item.vendorName || (item.subLedgerType === 'vendor' ? item.subLedgerName : ''),
        employeeName: entry.employeeName || item.employeeName || (item.subLedgerType === 'employee' ? item.subLedgerName : ''),
        partyName: entry.partyName || item.partyName || item.subLedgerName || entry.clientName || entry.vendorName || entry.employeeName || '',
      })
    }
  }

  return rows
}

/** رابط تفاصيل المستند أو العملية المرتبطة بحركة الأستاذ */
export function getMovementDocUrl(row, invoices = []) {
  if (!row) return null

  // 1. معرّف الفاتورة المباشر
  if (row.invoiceId) {
    return `/invoices/${row.invoiceId}`
  }

  // 2. البحث عن الفاتورة بالرقم (INV-xxxx أو invoiceNumber)
  const numToFind = row.invoiceNumber || (String(row.ref || '').toUpperCase().startsWith('INV-') ? row.ref : null)
  if (numToFind && Array.isArray(invoices) && invoices.length > 0) {
    const cleanNum = String(numToFind).replace(/^#/, '').trim()
    const foundInv = invoices.find(
      (inv) => inv.number === cleanNum || inv.id === cleanNum || String(inv.number).endsWith(cleanNum)
    )
    if (foundInv) {
      return `/invoices/${foundInv.id}`
    }
  }

  // 3. معرّف قيد الفاتورة التلقائي (inv-xxxx)
  if (row.entryId && String(row.entryId).startsWith('inv-') && !String(row.entryId).includes('-rev-')) {
    const raw = String(row.entryId).replace(/^inv-/, '')
    if (raw) {
      if (Array.isArray(invoices) && invoices.length > 0) {
        const found = invoices.find((i) => i.id === raw || i.number === raw)
        if (found) return `/invoices/${found.id}`
      }
      return `/invoices/${raw}`
    }
  }

  if (row.refType === 'invoice' || row.refType === 'payment') {
    return `/invoices`
  }
  if (row.purchaseInvoiceId || row.refType === 'purchaseInvoice' || row.refType === 'vendorPayment') {
    return `/vendors`
  }
  if (row.voucherId || row.refType === 'manual' || (typeof row.refType === 'string' && row.refType.startsWith('voucher'))) {
    return `/vouchers`
  }
  if (row.expenseId || row.refType === 'expense') {
    return `/expenses`
  }
  return null
}

/** أرصدة كل الحسابات — أساس ميزان المراجعة والقوائم المالية */
export function accountBalances(journal, accounts) {
  const map = new Map()
  const mapByCode = new Map()
  for (const account of accounts) {
    const bucket = { account, debit: 0, credit: 0 }
    map.set(account.id, bucket)
    if (account.code) {
      mapByCode.set(String(account.code), bucket)
    }
  }

  for (const entry of journal) {
    for (const item of entry.lines) {
      let bucket = map.get(item.accountId) || (item.code ? mapByCode.get(String(item.code)) : null)
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
        const isAdvance =
          String(item.subLedgerId).startsWith('emp-advance') ||
          item.account?.role === 'employeeAdvance' ||
          String(item.code).includes('1-01-06-02') ||
          String(item.code) === '110203' ||
          String(item.accountId).includes('110203')

        const payBucket = map.get(`emp-payable-${rawId}`)
        const advBucket = map.get(`emp-advance-${rawId}`)
        if (isAdvance) {
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

  const seenIds = new Set()
  const uniqueBuckets = []
  for (const bucket of map.values()) {
    if (!seenIds.has(bucket.account.id)) {
      seenIds.add(bucket.account.id)
      uniqueBuckets.push(bucket)
    }
  }

  return uniqueBuckets
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
    .sort((a, b) => String(a.account.code).localeCompare(String(b.account.code), undefined, { numeric: true }))
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
      .filter((row) => row.account.type === type && (!row.account.isGroup || (row.debit !== 0 || row.credit !== 0)))
      .reduce((sum, row) => sum + row.balance, 0),
  )
}
