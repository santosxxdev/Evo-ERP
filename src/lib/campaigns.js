import { isWithin, round2, toNumber, todayISO } from './format'

export const CAMPAIGNS_COL = 'campaigns'

export const FEE_MODES = ['percent', 'fixed']
export const FEE_FROM = ['fromBudget', 'onTop']

/** يوم البداية + عدد الأيام ← تاريخ النهاية (شامل يوم البداية) */
export function campaignEndDate(startDate, days) {
  const n = Math.max(1, Math.round(toNumber(days)))
  if (!startDate) return null
  const [y, m, d] = startDate.split('-').map(Number)
  const end = new Date(y, m - 1, d + n - 1)
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
}

/** أتعاب إدارة الشركة على الحملة */
export function campaignFee(campaign) {
  const budget = toNumber(campaign?.budget)
  if (campaign?.feeMode === 'fixed') return round2(toNumber(campaign?.feeFixed))
  return round2((budget * toNumber(campaign?.feePct)) / 100)
}

/**
 * تفكيك أرقام الحملة:
 *  - fromBudget: الأتعاب مخصومة من الميزانية، فاللي يروح للمنصات = الميزانية − الأتعاب
 *  - onTop: الأتعاب فوق الميزانية، فكل الميزانية تروح للمنصات
 */
export function campaignBreakdown(campaign) {
  const budget = round2(toNumber(campaign?.budget))
  const fee = campaignFee(campaign)
  const onTop = campaign?.feeFrom === 'onTop'
  const toPlatforms = onTop ? budget : round2(budget - fee)
  return {
    budget,
    fee,
    onTop,
    toPlatforms,
    /** إجمالي ما يدفعه العميل قبل الضريبة */
    clientPaysExTax: onTop ? round2(budget + fee) : budget,
  }
}

/** معدل الصرف اليومي المخطّط = ما يروح للمنصات ÷ عدد الأيام */
export function campaignDailyRate(campaign) {
  const { toPlatforms } = campaignBreakdown(campaign)
  const days = Math.max(1, Math.round(toNumber(campaign?.days)))
  return round2(toPlatforms / days)
}

/** حالة الحملة من تواريخها */
export function campaignStatus(campaign, today = todayISO()) {
  if (campaign?.status === 'cancelled') return 'cancelled'
  const start = campaign?.startDate
  const end = campaignEndDate(start, campaign?.days)
  if (!start) return 'planned'
  if (today < start) return 'planned'
  if (end && today > end) return 'ended'
  return 'running'
}

/** الأيام المنقضية والمتبقية */
export function campaignDaysProgress(campaign, today = todayISO()) {
  const total = Math.max(1, Math.round(toNumber(campaign?.days)))
  const start = campaign?.startDate
  if (!start) return { total, elapsed: 0, left: total }
  const [sy, sm, sd] = start.split('-').map(Number)
  const [ty, tm, td] = today.split('-').map(Number)
  const startMs = new Date(sy, sm - 1, sd).getTime()
  const todayMs = new Date(ty, tm - 1, td).getTime()
  const elapsed = Math.min(total, Math.max(0, Math.floor((todayMs - startMs) / 86400000) + (todayMs >= startMs ? 1 : 0)))
  return { total, elapsed, left: Math.max(0, total - elapsed) }
}

/**
 * المصروف الفعلي على الحملة = الإنفاق الإعلاني المموَّل من العميل
 * خلال فترة الحملة. isClientFunded محسوبة في الصفحة وتُمرَّر كدالة.
 */
export function campaignSpend(campaign, expenses, isClientFunded) {
  const end = campaignEndDate(campaign?.startDate, campaign?.days)
  return round2(
    expenses
      .filter(
        (e) =>
          e.clientId === campaign.clientId &&
          isClientFunded(e) &&
          isWithin(e.date, campaign.startDate, end),
      )
      .reduce((sum, e) => sum + toNumber(e.amount), 0),
  )
}

/**
 * بنود فاتورة الحملة الجاهزة:
 *  - بند عهدة الإعلانات (معفى من الضريبة) بقيمة toPlatforms
 *  - بند أتعاب الإدارة (يخضع للضريبة حسب إعداد الشركة)
 */
export function campaignInvoiceItems(campaign, adServiceId) {
  const b = campaignBreakdown(campaign)
  const items = []
  if (b.toPlatforms > 0) {
    items.push({
      serviceId: adServiceId ?? null,
      name: `ميزانية إعلانات — ${campaign.name}`,
      price: b.toPlatforms,
      qty: 1,
      isAdBudget: true,
      total: b.toPlatforms,
    })
  }
  if (b.fee > 0) {
    items.push({
      serviceId: null,
      name: `أتعاب إدارة الحملة — ${campaign.name}`,
      price: b.fee,
      qty: 1,
      isAdBudget: false,
      total: b.fee,
    })
  }
  return items
}
