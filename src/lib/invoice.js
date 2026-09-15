import { round2, toNumber } from './format'

/** نسبة الضريبة من الإعدادات حسب النوع المختار (`tax1` / `tax2` / `none`) */
export function resolveTaxRate(settings, taxKind) {
  if (taxKind === 'tax2') return toNumber(settings?.taxRate2)
  if (taxKind === 'tax1') return toNumber(settings?.taxRate1 ?? settings?.taxRate)
  return 0
}

/** تسمية الضريبة المعروضة على الفاتورة */
export function taxLabelOf(settings, taxKind) {
  if (taxKind === 'tax2') return settings?.taxLabel2 || 'ضريبة ٢'
  if (taxKind === 'tax1') return settings?.taxLabel1 || 'ضريبة ١'
  return ''
}

/**
 * حساب إجماليات الفاتورة من بنودها. الخصم يُطبَّق قبل الضريبة، والضريبة
 * على الصافي بعده. الخصم نوعان: مبلغ ثابت (`discountMode = 'amount'`،
 * الافتراضي المتوافق مع الفواتير القديمة عبر `discount`) أو نسبة مئوية
 * من الأتعاب (`discountMode = 'percent'` مع `discountValue`).
 */
export function computeTotals({
  items = [],
  discount = 0,
  discountMode = 'amount',
  discountValue = 0,
  taxRate = 0,
  taxEnabled = false,
}) {
  const subtotal = items.reduce((sum, item) => sum + toNumber(item.price) * toNumber(item.qty), 0)

  /* ميزانية الإعلانات أموال عميل تُنفَق على المنصات — ليست إيراد شركة،
     فلا يقع عليها خصم ولا ضريبة، وتُفصل عن الأتعاب في كل التقارير. */
  const adBudget = items
    .filter((item) => item.isAdBudget)
    .reduce((sum, item) => sum + toNumber(item.price) * toNumber(item.qty), 0)
  const fees = subtotal - adBudget

  const rawDiscount =
    discountMode === 'percent'
      ? (fees * toNumber(discountValue)) / 100
      : toNumber(discountValue) || toNumber(discount)
  const appliedDiscount = Math.min(Math.max(rawDiscount, 0), fees)
  const feesAfterDiscount = fees - appliedDiscount
  const taxAmount = taxEnabled ? (feesAfterDiscount * toNumber(taxRate)) / 100 : 0

  return {
    subtotal: round2(subtotal),
    adBudgetTotal: round2(adBudget),
    feesTotal: round2(feesAfterDiscount),
    discount: round2(appliedDiscount),
    discountMode: discountMode === 'percent' ? 'percent' : 'amount',
    discountValue: round2(toNumber(discountValue) || toNumber(discount)),
    taxAmount: round2(taxAmount),
    total: round2(feesAfterDiscount + taxAmount + adBudget),
  }
}

/** هل هذا المصروف أموال عميل (عهدة إعلانات) وليس مصروف شركة؟ */
export function isClientFunded(expense, categoryMap) {
  return Boolean(expense?.clientId) && Boolean(categoryMap?.get(expense.categoryId)?.isAdSpend)
}

export function lineTotal(item) {
  return round2(toNumber(item.price) * toNumber(item.qty))
}

/**
 * حالة الفاتورة من منظور الشركة:
 *  unpaid  = مدين (لم يُحصَّل شيء)
 *  partial = مدين جزئيًا
 *  paid    = خالص
 *  credit  = دائن (حُصِّل أكثر من الإجمالي)
 */
export function statusOf(invoice) {
  const total = round2(invoice?.total)
  const paid = round2(invoice?.paidAmount)

  if (paid > total) return 'credit'
  if (total > 0 && paid >= total) return 'paid'
  if (paid > 0) return 'partial'
  return 'unpaid'
}

export function statusTone(status) {
  return { paid: 'green', partial: 'amber', unpaid: 'red', credit: 'sky' }[status] ?? 'slate'
}

export function remainingOf(invoice) {
  return round2(toNumber(invoice?.total) - toNumber(invoice?.paidAmount))
}

/** فاتورة متأخرة: عليها متبقٍ وموعد الاستكمال فات */
export function isOverdue(invoice, today) {
  return (
    remainingOf(invoice) > 0 &&
    Boolean(invoice?.nextPaymentDate) &&
    invoice.nextPaymentDate < today
  )
}
