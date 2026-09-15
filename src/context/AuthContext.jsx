import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { auth } from '../lib/firebase'
import { useUserProfile } from '../lib/roles'

/**
 * الدخول يتم باسم مستخدم بسيط (admin) وليس بإيميل.
 * نحوّل الاسم إلى إيميل داخلي قبل إرساله إلى Firebase Auth،
 * فتبقى تجربة الدخول بسيطة مع الاحتفاظ بمصادقة حقيقية وقواعد أمان تعمل.
 */
const INTERNAL_DOMAIN = 'iyora.app'

export function usernameToEmail(username) {
  const value = String(username ?? '').trim()
  if (!value) return ''
  return value.includes('@') ? value.toLowerCase() : `${value.toLowerCase()}@${INTERNAL_DOMAIN}`
}

export function emailToUsername(email) {
  const value = String(email ?? '')
  return value.endsWith(`@${INTERNAL_DOMAIN}`) ? value.slice(0, -1 * (INTERNAL_DOMAIN.length + 1)) : value
}

const ERROR_KEYS = {
  'auth/invalid-credential': 'login.err.invalid',
  'auth/invalid-login-credentials': 'login.err.invalid',
  'auth/wrong-password': 'login.err.invalid',
  'auth/user-not-found': 'login.err.invalid',
  'auth/invalid-email': 'login.err.invalid',
  'auth/user-disabled': 'login.err.disabled',
  'auth/too-many-requests': 'login.err.toomany',
  'auth/network-request-failed': 'login.err.network',
  'auth/operation-not-allowed': 'login.err.config',
  'auth/configuration-not-found': 'login.err.config',
}

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
      setReady(true)
    })
    return unsubscribe
  }, [])

  const { profile, loading: profileLoading } = useUserProfile(user?.uid)

  const value = useMemo(
    () => ({
      user,
      ready,
      profile,
      profileLoading,
      /* بلا ملف مستخدم = لا صلاحيات، إلا أثناء التهيئة الأولى قبل إنشاء أول مدير */
      role: profile?.role ?? null,
      active: profile ? profile.active !== false : null,
      username: user ? emailToUsername(user.email) : null,

      async login(username, password) {
        const email = usernameToEmail(username)
        if (!email || !password) {
          return { ok: false, errorKey: 'login.err.empty' }
        }
        try {
          await setPersistence(auth, browserLocalPersistence)
          await signInWithEmailAndPassword(auth, email, password)
          return { ok: true }
        } catch (error) {
          return { ok: false, errorKey: ERROR_KEYS[error?.code] ?? 'login.err.generic' }
        }
      },

      logout() {
        return signOut(auth)
      },
    }),
    [user, ready, profile, profileLoading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}
