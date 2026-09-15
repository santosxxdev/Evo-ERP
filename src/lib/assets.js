import { round2, toNumber } from './format'

export const ASSETS_COL = 'assets'
export const MAINTENANCE_COL = 'maintenance'
export const ASSET_USAGE_COL = 'assetUsage'

export const ASSET_CATEGORIES_COL = 'assetCategories'
export const ASSET_LOCATIONS_COL = 'assetLocations'
/** أسماء افتراضية تُقترح لأول مرة — القائمة كلها قابلة للتعديل من المستخدم */
export const ASSET_CATEGORY_DEFAULTS = ['كاميرا', 'عدسة', 'إضاءة', 'صوت', 'كمبيوتر ولابتوب', 'درون', 'أخرى']
export const ASSET_LOCATION_DEFAULTS = ['الاستوديو', 'المخزن', 'المكتب', 'مع فريق التصوير']

export const ASSET_STATUSES = ['active', 'repair', 'sold', 'retired']

/** ٣ أنواع: هالك (قابل للإهلاك) / ثابت / أرض (بدون إهلاك) */
export const ASSET_KINDS = ['depreciable', 'fixed', 'land']

/** طرق الإهلاك الأربع */
export const DEP_METHODS = ['straight', 'declining', 'units', 'none']

/** تحويل كود فئة الأصل (مثل 'camera' أو 'كاميرا') إلى مسمى فريد واضح للواجهة */
export function assetCategoryLabel(value, t) {
  if (!value) return ''
  const str = String(value).trim()
  if (!str) return ''

  const key = `assets.category.${str}`
  const translated = t ? t(key) : null
  if (translated && translated !== key) return translated

  const map = {
    camera: t ? t('assets.category.camera') : 'كاميرا',
    lens: t ? t('assets.category.lens') : 'عدسة',
    lighting: t ? t('assets.category.lighting') : 'إضاءة',
    audio: t ? t('assets.category.audio') : 'صوت',
    computer: t ? t('assets.category.computer') : 'كمبيوتر ولابتوب',
    drone: t ? t('assets.category.drone') : 'درون',
    other: t ? t('assets.category.other') : 'أخرى',
  }
  if (map[str]) return map[str]
  return str
}

/** عدد الشهور الكاملة بين تاريخين بصيغة YYYY-MM-DD */
export function monthsBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return 0
  const [fy, fm, fd] = fromISO.split('-').map(Number)
  const [ty, tm, td] = toISO.split('-').map(Number)
  if (!fy || !ty) return 0
  let months = (ty - fy) * 12 + (tm - fm)
  if (td < fd) months -= 1
  return Math.max(0, months)
}

/**
 * تاريخ اكتمال الشهر رقم count من عمر الأصل — أي نفس يوم الشراء بعد
 * count شهرًا. لا يصح تأخيره لآخر الشهر، وإلا ظهر قيد الشهر الجاري
 * بتاريخ مستقبلي فاختلف مجمع الإهلاك عن الدفاتر.
 */
export function addMonths(iso, count) {
  const [year, month, day] = iso.split('-').map(Number)
  const total = year * 12 + (month - 1) + count
  const nextYear = Math.floor(total / 12)
  const nextMonth = (total % 12) + 1
  const lastDay = new Date(nextYear, nextMonth, 0).getDate()
  const safeDay = Math.min(day || 1, lastDay)
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`
}

/**
 * خطة الإهلاك حسب الطريقة المختارة:
 *  - straight  قسط ثابت: (التكلفة − الخردة) ÷ العمر بالشهور
 *  - declining قسط متناقص: القيمة الدفترية × نسبة سنوية ÷ ١٢
 *  - units     وحدات إنتاج: (التكلفة − الخردة) ÷ إجمالي الوحدات × المستهلك
 *  - none      بدون إهلاك (الأراضي)
 * ترجع `schedule` = قائمة قيود [{ date, amount }] ليرحّلها دفتر اليومية،
 * مع ملخّص الأرصدة. القيمة الدفترية لا تنزل تحت الخردة أبدًا.
 */
export function depreciation(asset, asOfISO, usage = []) {
  const cost = toNumber(asset?.purchaseCost)
  const salvage = Math.min(toNumber(asset?.salvageValue), cost)
  const depreciable = Math.max(0, cost - salvage)
  const kind = asset?.kind ?? 'depreciable'
  const method = kind === 'land' ? 'none' : asset?.depMethod ?? 'straight'

  const empty = {
    monthly: 0,
    months: 0,
    accumulated: 0,
    bookValue: round2(cost),
    depreciable: round2(depreciable),
    life: 0,
    schedule: [],
  }

  if (cost <= 0 || !asset?.purchaseDate || method === 'none' || depreciable <= 0) return empty

  /* وحدات الإنتاج: قيد لكل إدخال استهلاك حتى asOf */
  if (method === 'units') {
    const totalUnits = Math.max(0, toNumber(asset?.totalUnits))
    if (totalUnits <= 0) return empty
    const perUnit = depreciable / totalUnits
    const rows = (usage ?? [])
      .filter((row) => row.assetId === asset.id && row.date && row.date <= asOfISO)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))

    let acc = 0
    const schedule = []
    for (const row of rows) {
      let amount = round2(perUnit * toNumber(row.units))
      if (acc + amount > depreciable) amount = round2(depreciable - acc)
      if (amount <= 0) continue
      acc = round2(acc + amount)
      schedule.push({ date: row.date, amount })
    }
    return {
      monthly: round2(perUnit),
      months: schedule.length,
      accumulated: round2(acc),
      bookValue: round2(cost - acc),
      depreciable: round2(depreciable),
      life: totalUnits,
      schedule,
    }
  }

  const life = Math.max(0, Math.round(toNumber(asset?.usefulLifeMonths)))
  if (life <= 0) return empty
  const elapsed = Math.min(monthsBetween(asset.purchaseDate, asOfISO), life)

  if (method === 'declining') {
    const years = Math.max(life / 12, 1 / 12)
    const annualRate = toNumber(asset?.decliningRate) || 200 / years /* افتراضي: ضعف القسط الثابت */
    const monthlyRate = annualRate / 100 / 12

    let book = cost
    let acc = 0
    const schedule = []
    for (let month = 1; month <= elapsed; month += 1) {
      let amount = round2(book * monthlyRate)
      if (acc + amount > depreciable) amount = round2(depreciable - acc)
      if (amount <= 0) break
      acc = round2(acc + amount)
      book = round2(cost - acc)
      schedule.push({ date: addMonths(asset.purchaseDate, month), amount })
    }
    return {
      monthly: schedule[0]?.amount ?? 0,
      months: schedule.length,
      accumulated: round2(acc),
      bookValue: round2(cost - acc),
      depreciable: round2(depreciable),
      life,
      schedule,
    }
  }

  /* القسط الثابت */
  const monthly = depreciable / life
  const schedule = []
  let sumSoFar = 0
  for (let month = 1; month <= elapsed; month += 1) {
    let amount = round2(monthly)
    if (month === life) {
      amount = round2(depreciable - sumSoFar)
    }
    sumSoFar = round2(sumSoFar + amount)
    schedule.push({ date: addMonths(asset.purchaseDate, month), amount: round2(amount) })
  }
  const accumulated = elapsed >= life ? depreciable : monthly * elapsed
  return {
    monthly: round2(monthly),
    months: elapsed,
    accumulated: round2(accumulated),
    bookValue: round2(cost - accumulated),
    depreciable: round2(depreciable),
    life,
    schedule,
  }
}

export function assetTotals(assets, maintenance, asOfISO, usage = []) {
  let cost = 0
  let accumulated = 0

  for (const asset of assets) {
    if (asset.status === 'sold') continue
    cost += toNumber(asset.purchaseCost)
    accumulated += depreciation(asset, asOfISO, usage).accumulated
  }

  const upkeep = maintenance.reduce((sum, row) => sum + toNumber(row.cost), 0)

  return {
    cost: round2(cost),
    accumulated: round2(accumulated),
    bookValue: round2(cost - accumulated),
    maintenance: round2(upkeep),
    count: assets.filter((asset) => asset.status !== 'sold').length,
  }
}

/** صيانة مستحقة أو فات موعدها */
export function dueMaintenance(maintenance, todayISO) {
  return maintenance
    .filter((row) => row.nextDueDate && row.nextDueDate <= todayISO)
    .sort((a, b) => String(a.nextDueDate).localeCompare(String(b.nextDueDate)))
}
