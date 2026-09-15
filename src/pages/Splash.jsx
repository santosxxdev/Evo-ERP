import { useI18n } from '../i18n'
import logoImg from '../assets/logo.png'

const CLOUDINARY_LOGO = 'https://res.cloudinary.com/evolex/image/upload/v1789316433/IMG_3362_ula3ai.png'

export default function Splash() {
  const { t } = useI18n()

  return (
    <div data-theme="light" className="relative min-h-dvh overflow-hidden bg-ink-950 grid place-items-center">
      {/* توهّج خلفي */}
      <div className="pointer-events-none absolute -top-32 start-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-brand-600/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 end-0 h-96 w-96 rounded-full bg-brand-900/40 blur-3xl" />

      {/* شاشة البداية تحمل اسم Evolex — الشركة الصانعة للنظام */}
      <div className="relative flex flex-col items-center gap-6 px-6 text-center">
        <div
          className="relative flex h-32 w-32 md:h-36 md:w-36 items-center justify-center overflow-hidden rounded-[28px] border border-white/20 shadow-2xl shadow-brand-900/80 ring-1 ring-white/15 backdrop-blur-xl animate-[pop_.7s_cubic-bezier(.2,.9,.3,1.3)]"
        >
          <img
            src={logoImg}
            onError={(e) => {
              e.target.onerror = null
              e.target.src = CLOUDINARY_LOGO
            }}
            alt="Evolex Logo"
            className="h-full w-full object-cover"
          />
        </div>

        <div className="animate-[rise_.6s_.15s_both]">
          <h1
            className="text-5xl font-extrabold tracking-tight text-white"
            style={{ direction: 'ltr' }}
          >
            Evolex
          </h1>
          <p className="mt-2 text-sm font-medium text-slate-400">{t('splash.by')}</p>
        </div>

        <p className="text-[11px] font-semibold tracking-wide text-slate-500" dir="ltr">
          <span className="font-extrabold text-slate-400">evolex</span> · {t('app.tagline')}
        </p>

        <div className="mt-1 h-1 w-40 overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-1/3 rounded-full bg-brand-500 animate-[slide_1.1s_ease-in-out_infinite]" />
        </div>
      </div>

      <style>{`
        @keyframes pop { from { opacity:0; transform: scale(.6) } to { opacity:1; transform: scale(1) } }
        @keyframes rise { from { opacity:0; transform: translateY(14px) } to { opacity:1; transform: none } }
        @keyframes slide { 0% { transform: translateX(-120%) } 100% { transform: translateX(360%) } }
      `}</style>
    </div>
  )
}
