import { useEffect, useMemo, useState } from 'react'
import {
  addDoc,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from './firebase'

/* ------------------------------------------------------------------ */
/*  أسماء المجموعات                                                    */
/* ------------------------------------------------------------------ */

export const COL = {
  clients: 'clients',
  employees: 'employees',
  employeeEntries: 'employeeEntries',
  services: 'services',
  invoices: 'invoices',
  expenses: 'expenses',
  expenseCategories: 'expenseCategories',
  activityTypes: 'activityTypes',
  paymentMethods: 'paymentMethods',
  serviceCategories: 'serviceCategories',
  employeeTypes: 'employeeTypes',
  departments: 'departments',
  positions: 'positions',
  accounts: 'accounts',
  accountingTransactions: 'accountingTransactions',
  journalEntries: 'journalEntries',
  vouchers: 'journalEntries',
  jobCosts: 'jobCosts',
  salesPeriods: 'salesPeriods',
}

/* ------------------------------------------------------------------ */
/*  قراءة لحظية لأي مجموعة                                             */
/* ------------------------------------------------------------------ */

export function useCollection(path, sortField = 'createdAt', direction = 'desc', enabled = true) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(Boolean(enabled && path))
  const [error, setError] = useState(null)

  useEffect(() => {
    /* تعطيل الاستعلام لمن لا يملك صلاحية الوصول أصلًا أو في حال غياب مسار المجموّعة */
    if (!enabled || !path) {
      setRows([])
      setLoading(false)
      setError(null)
      return undefined
    }

    setLoading(true)
    let isMounted = true

    /* مؤقت حماية: إذا تأخر استجابة شبكة فايربيس لأكثر من 5 ثوانٍ يتم إنهاء التحميل تلقائياً لعدم تعليق الشاشة */
    const timer = setTimeout(() => {
      if (isMounted) {
        console.warn(`[useCollection] Safety timeout reached for collection "${path}". Forcing loading to false.`)
        setLoading(false)
      }
    }, 5000)

    let reference
    try {
      reference = sortField
        ? query(collection(db, path), orderBy(sortField, direction))
        : collection(db, path)
    } catch (err) {
      console.warn(`useCollection invalid path or query for "${path}":`, err)
      setError(err)
      setLoading(false)
      clearTimeout(timer)
      return undefined
    }

    const unsubscribe = onSnapshot(
      reference,
      (snapshot) => {
        clearTimeout(timer)
        if (isMounted) {
          setRows(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })))
          setLoading(false)
          setError(null)
        }
      },
      (snapshotError) => {
        clearTimeout(timer)
        console.error(`[useCollection] Snapshot error for "${path}":`, snapshotError)
        if (isMounted) {
          setError(snapshotError)
          setLoading(false)
        }
      },
    )

    return () => {
      isMounted = false
      clearTimeout(timer)
      unsubscribe()
    }
  }, [path, sortField, direction, enabled])

  return { rows, loading, error }
}

export function useSubCollection(parentPath, parentId, subPath, sortField = 'date') {
  const path = parentId ? `${parentPath}/${parentId}/${subPath}` : null
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(Boolean(path))

  useEffect(() => {
    if (!path) {
      setRows([])
      setLoading(false)
      return undefined
    }
    setLoading(true)
    let isMounted = true
    const timer = setTimeout(() => {
      if (isMounted) setLoading(false)
    }, 5000)

    const unsubscribe = onSnapshot(
      query(collection(db, path), orderBy(sortField, 'asc')),
      (snapshot) => {
        clearTimeout(timer)
        if (isMounted) {
          setRows(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })))
          setLoading(false)
        }
      },
      (err) => {
        clearTimeout(timer)
        console.error(`[useSubCollection] Error for "${path}":`, err)
        if (isMounted) setLoading(false)
      },
    )
    return () => {
      isMounted = false
      clearTimeout(timer)
      unsubscribe()
    }
  }, [path, sortField])

  return { rows, loading }
}

/** كل الدفعات عبر جميع الفواتير — يحتاجها دفتر اليومية */
export function useAllPayments() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let isMounted = true
    const timer = setTimeout(() => {
      if (isMounted) {
        console.warn('[useAllPayments] Safety timeout reached for payments collectionGroup. Forcing loading to false.')
        setLoading(false)
      }
    }, 5000)

    const unsubscribe = onSnapshot(
      collectionGroup(db, 'payments'),
      (snapshot) => {
        clearTimeout(timer)
        if (isMounted) {
          setRows(
            snapshot.docs.map((entry) => ({
              id: entry.id,
              invoiceId: entry.ref.parent.parent?.id ?? null,
              ...entry.data(),
            })),
          )
          setLoading(false)
          setError(null)
        }
      },
      (err) => {
        clearTimeout(timer)
        console.error('[useAllPayments] Snapshot error:', err)
        if (isMounted) {
          setError(err)
          setLoading(false)
        }
      },
    )
    return () => {
      isMounted = false
      clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  return { rows, loading, error }
}

/** خريطة id ← مستند، مفيدة لعرض الأسماء المرتبطة */
export function useLookup(rows) {
  return useMemo(() => {
    const map = new Map()
    for (const row of rows) map.set(row.id, row)
    return map
  }, [rows])
}

/* ------------------------------------------------------------------ */
/*  كتابة                                                              */
/* ------------------------------------------------------------------ */

export function createDoc(path, data) {
  return addDoc(collection(db, path), { ...data, createdAt: serverTimestamp() })
}

export function updateDocById(path, id, data) {
  return updateDoc(doc(db, path, id), { ...data, updatedAt: serverTimestamp() })
}

export async function deleteDocById(path, id) {
  // Protect accounting transactions from direct casual deletion
  if (path === COL.accountingTransactions) {
    throw new Error('Accounting Error: Accounting transactions are immutable and cannot be deleted directly.')
  }
  // Protect source documents with linked accounting transactions from deletion
  if (path !== 'settings') {
    const q = query(
      collection(db, COL.accountingTransactions),
      where('sourceType', '==', path),
      where('sourceId', '==', id)
    )
    const snap = await getDocs(q)
    if (!snap.empty) {
      throw new Error('Accounting Error: Cannot hard-delete document because it has accounting transactions associated with it. Reverse or cancel it instead.')
    }
  }
  return deleteDoc(doc(db, path, id))
}

export function docRef(path, id) {
  return doc(db, path, id)
}

/* ------------------------------------------------------------------ */
/*  الإعدادات العامة للشركة                                            */
/* ------------------------------------------------------------------ */

export const SETTINGS_PATH = 'settings'
export const SETTINGS_ID = 'company'

export const DEFAULT_SETTINGS = {
  companyName: 'iyora',
  closedPeriodBefore: '',
  taxEnabled: false,
  taxRate: 14,
  /* نسبتا ضريبة معرّفتان — الفاتورة/الأصل يختار أيّهما ينطبق (أو بدون).
     taxRate يبقى مرادفًا لـ taxRate1 للتوافق مع الفواتير القديمة. */
  taxRate1: 14,
  taxRate2: 0,
  taxLabel1: 'ضريبة القيمة المضافة',
  taxLabel2: 'ضريبة الخصم والإضافة',
  invoicePrefix: 'INV',
  /* تظهر في ترويسة/تذييل الفاتورة المطبوعة */
  logoUrl: '',
  websiteUrl: '',
  companyPhone: '',
  companyEmail: '',
  companyAddress: '',
  bankName: '',
  bankAccount: '',
  bankHolder: '',
  contractTerms: '',
}

export function useSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, SETTINGS_PATH, SETTINGS_ID),
      (snapshot) => {
        setSettings(snapshot.exists() ? { ...DEFAULT_SETTINGS, ...snapshot.data() } : DEFAULT_SETTINGS)
        setLoading(false)
      },
      () => setLoading(false),
    )
    return unsubscribe
  }, [])

  return { settings, loading }
}

export function saveSettings(data) {
  return setDoc(doc(db, SETTINGS_PATH, SETTINGS_ID), data, { merge: true })
}

/* ------------------------------------------------------------------ */
/*  ترقيم الفواتير التسلسلي — داخل معاملة حتى لا يتكرر رقم             */
/* ------------------------------------------------------------------ */

/** ترقيم تسلسلي عام لأي نوع مستند، داخل معاملة حتى لا يتكرر رقم */
export async function nextNumber(kind, prefix) {
  const year = new Date().getFullYear()
  const counterRef = doc(db, 'counters', `${kind}-${year}`)

  const sequence = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(counterRef)
    const current = snapshot.exists() ? Number(snapshot.data().seq ?? 0) : 0
    transaction.set(counterRef, { seq: current + 1, year }, { merge: true })
    return current + 1
  })

  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`
}

export async function nextInvoiceNumber(prefix = 'INV') {
  const year = new Date().getFullYear()
  const counterRef = doc(db, 'counters', `invoices-${year}`)

  const sequence = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(counterRef)
    const current = snapshot.exists() ? Number(snapshot.data().seq ?? 0) : 0
    const next = current + 1
    transaction.set(counterRef, { seq: next, year }, { merge: true })
    return next
  })

  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`
}

export async function nextEmployeeCode(prefix = 'EMP') {
  return nextNumber('employees', prefix)
}

/* ------------------------------------------------------------------ */
/*  تحديث أرصدة العميل — يعاد حسابها من فواتيره حتى تبقى صحيحة دائمًا  */
/* ------------------------------------------------------------------ */

export async function recalcClientTotals(clientId, invoices) {
  if (!clientId) return
  const own = invoices.filter((invoice) => invoice.clientId === clientId && !invoice.cancelled)
  const totalInvoiced = own.reduce((sum, invoice) => sum + Number(invoice.total ?? 0), 0)
  const totalPaid = own.reduce((sum, invoice) => sum + Number(invoice.paidAmount ?? 0), 0)

  await updateDoc(doc(db, COL.clients, clientId), {
    totalInvoiced,
    totalPaid,
    balance: totalInvoiced - totalPaid,
    invoicesCount: own.length,
    updatedAt: serverTimestamp(),
  }).catch(() => {
    /* العميل قد يكون محذوفًا — نتجاهل */
  })
}

/** مجموع دفعات فاتورة مقروءًا من المصدر — أدق من الجمع محليًا */
export async function sumPayments(invoiceId) {
  const snapshot = await getDocs(collection(db, `${COL.invoices}/${invoiceId}/payments`))
  return snapshot.docs.reduce((sum, entry) => sum + Number(entry.data().amount ?? 0), 0)
}

export async function getDocById(path, id) {
  const snapshot = await getDoc(doc(db, path, id))
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null
}
