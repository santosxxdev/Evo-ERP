import { useI18n } from '../i18n'
import { useSettings } from '../lib/db'
import { formatDate, todayISO } from '../lib/format'

export default function ReportPrintHeader({ title, subtitle = '', from = '', to = '', extra = null }) {
  const { t, locale } = useI18n()
  const { settings } = useSettings()

  return (
    <div className="mb-6 border-b-2 border-slate-900 pb-4 text-slate-900">
      <div className="flex items-start justify-between gap-4">
        {/* معلومات الشركة واللوجو */}
        <div className="flex items-center gap-3">
          {settings.logoUrl ? (
            <img src={settings.logoUrl} alt={settings.companyName} className="h-12 w-auto max-w-[140px] object-contain" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 font-extrabold text-white">
              {(settings.companyName || 'iyora').slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-xl font-black text-slate-900">{settings.companyName || 'iyora'}</h1>
            {settings.companyAddress && <p className="text-xs text-slate-500">{settings.companyAddress}</p>}
            {(settings.companyPhone || settings.companyEmail) && (
              <p className="text-xs text-slate-500">
                {[settings.companyPhone, settings.companyEmail].filter(Boolean).join(' • ')}
              </p>
            )}
          </div>
        </div>

        {/* عنوان التقرير والتاريخ */}
        <div className="text-end">
          <h2 className="text-lg font-extrabold text-brand-600">{title}</h2>
          {subtitle && <p className="text-xs font-semibold text-slate-600">{subtitle}</p>}
          <p className="num mt-1 text-xs font-semibold text-slate-500">
            {from || to ? (
              <>
                {from ? `${t('common.from')}: ${formatDate(from, locale)} ` : ''}
                {to ? `${t('common.to')}: ${formatDate(to, locale)}` : ''}
              </>
            ) : (
              `${t('acct.allTime')} (${formatDate(todayISO(), locale)})`
            )}
          </p>
        </div>
      </div>

      {extra && <div className="mt-3 text-xs">{extra}</div>}
    </div>
  )
}
