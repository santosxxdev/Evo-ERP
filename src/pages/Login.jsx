import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useI18n } from '../i18n'
import { IconGlobe } from '../components/Icons'
import { PoweredBy } from '../components/ui'

export default function Login() {
  const { t, toggleLang } = useI18n()
  const { login } = useAuth()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errorKey, setErrorKey] = useState(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setErrorKey(null)

    const result = await login(username, password)
    if (result.ok) {
      navigate('/', { replace: true })
    } else {
      setErrorKey(result.errorKey)
      setBusy(false)
    }
  }

  return (
    <div data-theme="light" className="relative min-h-dvh overflow-hidden bg-ink-950 px-4 py-10 grid place-items-center">
      <div className="pointer-events-none absolute -top-40 start-1/4 h-96 w-96 rounded-full bg-brand-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 end-1/4 h-96 w-96 rounded-full bg-brand-800/30 blur-3xl" />

      <button
        type="button"
        onClick={toggleLang}
        className="absolute top-5 end-5 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5
                   px-3 py-2 text-xs font-semibold text-slate-200 backdrop-blur transition hover:bg-white/10"
      >
        <IconGlobe className="h-4 w-4" />
        {t('top.lang')}
      </button>

      <div className="relative w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <div
            className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 via-brand-600 to-brand-800
                       text-3xl font-extrabold text-white shadow-xl shadow-brand-900/40"
            style={{ direction: 'ltr' }}
          >
            i
          </div>
          <div>
            <h1
              className="text-3xl font-extrabold lowercase tracking-tight text-white"
              style={{ direction: 'ltr' }}
            >
              iyora
            </h1>
            <p className="mt-1 text-xs font-medium text-slate-400">{t('app.tagline')}</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl backdrop-blur-xl sm:p-7"
        >
          <h2 className="text-lg font-bold text-white">{t('login.title')}</h2>
          <p className="mt-1 mb-6 text-sm text-slate-400">{t('login.subtitle')}</p>

          <label className="mb-1.5 block text-sm font-semibold text-slate-300" htmlFor="username">
            {t('login.username')}
          </label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck="false"
            dir="ltr"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={t('login.username.ph')}
            className="mb-4 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white
                       outline-none transition placeholder:text-slate-500
                       focus:border-brand-400 focus:bg-white/10 focus:ring-4 focus:ring-brand-500/20"
          />

          <label className="mb-1.5 block text-sm font-semibold text-slate-300" htmlFor="password">
            {t('login.password')}
          </label>
          {/* الحقل وزر الإظهار داخل سياق LTR موحّد حتى لا يتصادما في الوضع العربي */}
          <div className="relative mb-5" dir="ltr">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              dir="ltr"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('login.password.ph')}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 pe-16 text-sm text-white
                         outline-none transition placeholder:text-slate-500
                         focus:border-brand-400 focus:bg-white/10 focus:ring-4 focus:ring-brand-500/20"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute inset-y-0 end-3 my-auto h-7 rounded-lg px-2 text-[11px] font-semibold
                         text-slate-400 transition hover:text-white"
            >
              {showPassword ? t('login.hide') : t('login.show')}
            </button>
          </div>

          {errorKey && (
            <div className="mb-5 rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-200">
              {t(errorKey)}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-brand-600 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-brand-900/40
                       transition hover:bg-brand-500 active:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? t('login.loading') : t('login.submit')}
          </button>
        </form>

        <div className="mt-6 flex justify-center">
          <PoweredBy />
        </div>
      </div>
    </div>
  )
}
