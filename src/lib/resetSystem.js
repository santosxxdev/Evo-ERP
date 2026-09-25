import {
  addDoc,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore'
import { db } from './firebase'
import { DEFAULT_ACCOUNTS, DEFAULT_PAYMENT_METHODS } from './accounts'
import { DEFAULT_SETTINGS, SETTINGS_ID, SETTINGS_PATH } from './db'

export async function resetSystemData(keepUserId) {
  const collectionsToClear = [
    'invoices',
    'purchaseInvoices',
    'purchaseReturns',
    'supplierCreditNotes',
    'vendorAdvances',
    'vendorPayments',
    'vendorAdvanceApplications',
    'accountingTransactions',
    'journalEntries',
    'clients',
    'employees',
    'employeeEntries',
    'employeeDeductions',
    'employeeAllowances',
    'attendance',
    'attendanceSettings',
    'payroll',
    'payrollRuns',
    'payrollItems',
    'vendors',
    'supplierPayables',
    'assets',
    'assetUsage',
    'assetLocations',
    'assetCategories',
    'jobCosts',
    'expenses',
    'expenseCategories',
    'services',
    'serviceCategories',
    'quotations',
    'retainers',
    'campaigns',
    'maintenance',
    'activityTypes',
    'paymentMethods',
    'vendorSpecialties',
    'departments',
    'positions',
    'employeeTypes',
    'counters',
  ]

  // 1. Delete all payments & subcollection groups
  try {
    const paymentsSnap = await getDocs(collectionGroup(db, 'payments'))
    for (const payDoc of paymentsSnap.docs) {
      await deleteDoc(payDoc.ref)
    }
  } catch (err) {
    console.warn('Error clearing payments collectionGroup:', err)
  }

  try {
    const appsSnap = await getDocs(collectionGroup(db, 'applications'))
    for (const appDoc of appsSnap.docs) {
      await deleteDoc(appDoc.ref)
    }
  } catch (err) {
    console.warn('Error clearing applications collectionGroup:', err)
  }

  // 2. Clear main collections
  for (const colName of collectionsToClear) {
    try {
      const snap = await getDocs(collection(db, colName))
      for (const d of snap.docs) {
        await deleteDoc(d.ref)
      }
    } catch (err) {
      console.warn(`Error clearing collection ${colName}:`, err)
    }
  }

  // 3. Clear users except keepUserId (or keep the first user if keepUserId is not specified)
  try {
    const usersSnap = await getDocs(collection(db, 'users'))
    if (!usersSnap.empty) {
      const targetKeepId = keepUserId || usersSnap.docs[0].id
      for (const uDoc of usersSnap.docs) {
        if (uDoc.id !== targetKeepId) {
          await deleteDoc(uDoc.ref)
        }
      }
    }
  } catch (err) {
    console.warn('Error clearing users collection:', err)
  }

  // 4. Re-populate DEFAULT_ACCOUNTS and DEFAULT_PAYMENT_METHODS
  try {
    const accountsSnap = await getDocs(collection(db, 'accounts'))
    for (const accDoc of accountsSnap.docs) {
      await deleteDoc(accDoc.ref)
    }
    const accountDocMap = new Map()
    for (const acc of DEFAULT_ACCOUNTS) {
      const ref = await addDoc(collection(db, 'accounts'), {
        code: acc.code,
        name: acc.name,
        nameEn: acc.nameEn || '',
        type: acc.type,
        isGroup: Boolean(acc.isGroup),
        role: acc.role ?? null,
        parentCode: acc.parent ?? null,
        archived: false,
        createdAt: serverTimestamp(),
      })
      accountDocMap.set(acc.code, ref.id)
    }

    const pmSnap = await getDocs(collection(db, 'paymentMethods'))
    for (const pmDoc of pmSnap.docs) {
      await deleteDoc(pmDoc.ref)
    }
    for (const pm of DEFAULT_PAYMENT_METHODS) {
      await addDoc(collection(db, 'paymentMethods'), {
        name: pm.name,
        type: pm.type,
        accountId: accountDocMap.get(pm.accountCode) || null,
        accountNumber: '',
        accountHolder: '',
        archived: false,
        active: true,
        createdAt: serverTimestamp(),
      })
    }
  } catch (err) {
    console.warn('Error resetting accounts & paymentMethods:', err)
  }

  // 5. Reset company settings
  try {
    await setDoc(doc(db, SETTINGS_PATH, SETTINGS_ID), {
      ...DEFAULT_SETTINGS,
      updatedAt: serverTimestamp(),
    })
  } catch (err) {
    console.warn('Error resetting settings:', err)
  }
}
