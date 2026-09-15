// الأرقام تُعرض دائمًا بالأرقام اللاتينية (المتعارف عليها في الفواتير المصرية)
const NUMBER_LOCALE = 'en-GB'

export function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function round2(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100
}

export function formatMoney(value) {
  return new Intl.NumberFormat(NUMBER_LOCALE, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(round2(value))
}

export function formatNumber(value) {
  return new Intl.NumberFormat(NUMBER_LOCALE).format(toNumber(value))
}

export function todayISO() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

export function monthStartISO(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

export function formatDate(iso, locale = 'en-GB') {
  if (!iso) return '—'
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return String(iso)
  return new Intl.DateTimeFormat(locale === 'ar-EG' ? 'en-GB' : locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function monthKey(iso) {
  return String(iso ?? '').slice(0, 7)
}

/** آخر n شهر بصيغة YYYY-MM من الأقدم للأحدث */
export function lastMonths(count = 6) {
  const list = []
  const cursor = new Date()
  cursor.setDate(1)
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1)
    list.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`)
  }
  return list
}

export function isWithin(iso, from, to) {
  if (!iso) return false
  if (from && iso < from) return false
  if (to && iso > to) return false
  return true
}
