import { deleteApp, initializeApp } from 'firebase/app'
import { createUserWithEmailAndPassword, getAuth, signOut } from 'firebase/auth'
import { doc, onSnapshot, setDoc } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { db, firebaseConfig } from './firebase'

export const USERS_COL = 'users'

export const ROLES = ['admin', 'accountant', 'sales', 'viewer']

/**
 * الأقسام المسموحة لكل دور. الإخفاء في الواجهة للراحة فقط —
 * المنع الحقيقي في قواعد Firestore، لأن الواجهة يمكن تخطّيها.
 */
const SECTIONS = {
  admin: [
    '/', '/clients', '/employees', '/payroll', '/positions', '/departments', '/employee-migration', '/attendance', '/vendors', '/assets', '/quotations', '/campaigns', '/invoices',
    '/expenses', '/services', '/reports', '/accounting', '/vouchers', '/treasury', '/settings', '/users',
  ],
  accountant: [
    '/', '/clients', '/employees', '/payroll', '/positions', '/departments', '/employee-migration', '/attendance', '/vendors', '/assets', '/quotations', '/campaigns', '/invoices',
    '/expenses', '/services', '/reports', '/accounting', '/vouchers', '/treasury', '/settings',
  ],
  sales: ['/', '/clients', '/quotations', '/campaigns', '/invoices', '/services'],
  viewer: ['/', '/clients', '/invoices', '/reports'],
}

export function sectionsFor(role) {
  return SECTIONS[role] ?? []
}

export function canAccess(role, path) {
  return sectionsFor(role).includes(path)
}

/** المشاهد لا يعدّل شيئًا */
export function canEdit(role) {
  return role !== 'viewer'
}

/** الأرباح والتكاليف والمرتبات لا تظهر لموظف المبيعات */
export function canSeeMoneyInternals(role) {
  return role === 'admin' || role === 'accountant'
}

export function canManageUsers(role) {
  return role === 'admin'
}

/* ------------------------------------------------------------------ */

export function useUserProfile(uid) {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(Boolean(uid))

  useEffect(() => {
    if (!uid) {
      setProfile(null)
      setLoading(false)
      return undefined
    }
    setLoading(true)
    const unsubscribe = onSnapshot(
      doc(db, USERS_COL, uid),
      (snapshot) => {
        setProfile(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null)
        setLoading(false)
      },
      () => setLoading(false),
    )
    return unsubscribe
  }, [uid])

  return { profile, loading }
}

export function saveUserProfile(uid, data) {
  return setDoc(doc(db, USERS_COL, uid), data, { merge: true })
}

/**
 * إنشاء حساب دخول جديد من نسخة ثانية من تطبيق Firebase،
 * حتى لا تُبدَّل جلسة المدير الحالي أثناء الإنشاء.
 */
export async function createAuthUser(email, password) {
  const secondary = initializeApp(firebaseConfig, `secondary-${Date.now()}`)
  const secondaryAuth = getAuth(secondary)
  try {
    const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password)
    await signOut(secondaryAuth)
    return credential.user.uid
  } finally {
    await deleteApp(secondary)
  }
}
