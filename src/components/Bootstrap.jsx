import { useState } from 'react'
import { useI18n } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { emailToUsername } from '../context/AuthContext'
import { saveUserProfile } from '../lib/roles'
import { todayISO } from '../lib/format'
import { Button, Field, Input } from './ui'

/**
 * أول تشغيل: المستخدم مسجَّل دخول في Firebase Auth لكن ملف صلاحياته
 * غير موجود. يسجّل نفسه كمدير هنا مرة واحدة، فتبدأ الأدوار في العمل.
 */
export default function Bootstrap() {
  const { t } = useI18n()
  const { user, username, logout } = useAuth()

  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  async function claim() {
    if (!name.trim()) return
    setBusy(true)
    setError(false)
    try {
      await saveUserProfile(user.uid, {
        username: username ?? emailToUsername(user.email),
        email: user.email,
        name: name.trim(),
        role: 'admin',
        active: true,
        createdAt: todayISO(),
      })
    } catch {
      setError(true)
    }
    setBusy(false)
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-100 px-4 py-10">
      <div className="card w-full max-w-md p-7">
        <h1 className="text-lg font-bold text-slate-900">{t('bootstrap.title')}</h1>
        <p className="mt-1.5 mb-6 text-sm leading-relaxed text-slate-500">{t('bootstrap.body')}</p>

        <Field label={t('bootstrap.yourName')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>

        <p className="mt-3 text-xs text-slate-400">
          {t('login.username')}: <span className="num font-bold text-slate-600">{username}</span>
        </p>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {t('bootstrap.error')}
          </div>
        )}

        <div className="mt-6 flex gap-2">
          <Button onClick={claim} disabled={busy || !name.trim()} className="flex-1">
            {busy ? t('common.saving') : t('bootstrap.claim')}
          </Button>
          <Button variant="ghost" onClick={logout}>
            {t('top.logout')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** حساب موقوف أو بلا صلاحية */
export function NoAccess() {
  const { t } = useI18n()
  const { logout, username } = useAuth()

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-100 px-4">
      <div className="card w-full max-w-md p-7 text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-red-50 text-red-600">
          <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="9" />
            <path d="M8 12h8" strokeLinecap="round" />
          </svg>
        </div>
        <h1 className="text-lg font-bold text-slate-900">{t('noaccess.title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">{t('noaccess.body')}</p>
        <p className="num mt-3 text-xs font-bold text-slate-400">{username}</p>
        <Button variant="ghost" onClick={logout} className="mt-6">
          {t('top.logout')}
        </Button>
      </div>
    </div>
  )
}
