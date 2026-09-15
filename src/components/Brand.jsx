import { useI18n } from '../i18n'

/**
 * هوية iyora نصية بالكامل (بدون شعار مرسوم) — حرف أول داخل مربع متدرج + الاسم.
 */
export default function Brand({ size = 'md', tone = 'dark', showTagline = true }) {
  const { t } = useI18n()

  const mark = size === 'lg' ? 'w-14 h-14 text-2xl rounded-2xl' : 'w-10 h-10 text-lg rounded-xl'
  const name = size === 'lg' ? 'text-3xl' : 'text-xl'
  const nameTone = tone === 'dark' ? 'text-white' : 'text-slate-900'
  const taglineTone = tone === 'dark' ? 'text-slate-400' : 'text-slate-500'

  return (
    <div className="flex items-center gap-3">
      <div
        className={`${mark} grid place-items-center font-extrabold text-white shadow-lg shadow-brand-900/30
                    bg-gradient-to-br from-brand-400 via-brand-600 to-brand-800`}
        style={{ direction: 'ltr' }}
      >
        i
      </div>
      <div className="leading-tight" style={{ direction: 'ltr', textAlign: 'left' }}>
        <div className={`${name} ${nameTone} font-extrabold tracking-tight lowercase`}>
          {t('app.name')}
        </div>
        {showTagline && <div className={`text-[11px] ${taglineTone} font-medium`}>Media Accounting</div>}
      </div>
    </div>
  )
}
