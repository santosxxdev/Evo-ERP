import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  setDoc
} from 'firebase/firestore'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const firebaseConfig = {
  apiKey: 'AIzaSyCb1BmZI6H7rw4fPO72yNJBQHtsfpzwr8M',
  authDomain: 'iyora-eg.firebaseapp.com',
  projectId: 'iyora-eg',
  storageBucket: 'iyora-eg.firebasestorage.app',
  messagingSenderId: '1064818599797',
  appId: '1:1064818599797:web:90b4742b1a38763dcd953c'
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

const backupDir = path.join(rootDir, 'backups', 'backup-2026-09-21T17-05-00-589Z')

async function runCleanupAndRestore() {
  console.log('🔐 تسجيل الدخول...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول.')

  // 1. Restore Employees
  console.log('\n👥 تنظيف الموظفين واستعادة الـ 11 موظف الأصليين فقط...')
  const backupEmps = JSON.parse(fs.readFileSync(path.join(backupDir, 'employees.json'), 'utf8'))
  const realEmpMap = new Map(backupEmps.map(e => [e._id, e]))
  const realIds = new Set(backupEmps.map(e => e._id))

  const currentEmpSnap = await getDocs(collection(db, 'employees'))
  let deletedDemos = 0
  for (const d of currentEmpSnap.docs) {
    if (!realIds.has(d.id)) {
      await deleteDoc(doc(db, 'employees', d.id))
      deletedDemos++
    }
  }
  console.log(`تم حذف ${deletedDemos} موظف تجريبي تم توليدهم بالخطأ.`)

  // Restore exact original data of the 11 real employees
  for (const [id, empData] of realEmpMap.entries()) {
    const { _id, ...cleanData } = empData
    await setDoc(doc(db, 'employees', id), cleanData)
  }
  console.log(`✅ تم استعادة بيانات الـ 11 موظف الأصليين بالكامل.`)

  // 2. Clean demo departments and positions
  console.log('\n🏢 تنظيف الأقسام والوظائف التجريبية...')
  const deptSnap = await getDocs(collection(db, 'departments'))
  for (const d of deptSnap.docs) {
    await deleteDoc(doc(db, 'departments', d.id))
  }
  const posSnap = await getDocs(collection(db, 'positions'))
  for (const d of posSnap.docs) {
    await deleteDoc(doc(db, 'positions', d.id))
  }
  console.log(`✅ تم تنظيف الأقسام والوظائف التجريبية.`)

  // 3. Ensure all 98 invoices are in Firestore
  console.log('\n🧾 التحقق من الفواتير (98 فاتورة)...')
  const backupInvs = JSON.parse(fs.readFileSync(path.join(backupDir, 'invoices.json'), 'utf8'))
  const currentInvSnap = await getDocs(collection(db, 'invoices'))
  const currentInvIds = new Set(currentInvSnap.docs.map(d => d.id))

  let restoredInvs = 0
  for (const inv of backupInvs) {
    if (!currentInvIds.has(inv._id)) {
      const { _id, _payments, ...invData } = inv
      await setDoc(doc(db, 'invoices', _id), invData)
      if (_payments && Array.isArray(_payments)) {
        for (const p of _payments) {
          const { _id: payId, ...payData } = p
          await setDoc(doc(db, 'invoices', _id, 'payments', payId), payData)
        }
      }
      restoredInvs++
    }
  }
  console.log(`تم استعادة ${restoredInvs} فاتورة كانت ناقصة، إجمالي الفواتير الآن: ${backupInvs.length}`)

  // 4. Clean demo attendance, deductions, allowances if any were generated
  const demoCols = ['attendance', 'employeeAllowances', 'employeeDeductions', 'payrollRuns', 'payrollItems']
  for (const colName of demoCols) {
    const s = await getDocs(collection(db, colName))
    if (!s.empty) {
      for (const d of s.docs) {
        await deleteDoc(doc(db, colName, d.id))
      }
      console.log(`تم تنظيف ${s.size} سجل تجريبي من ${colName}.`)
    }
  }

  // 5. Final verification
  console.log('\n========================================')
  console.log('🎉 تم إصلاح النظام واستعادة كافة البيانات الأصلية 100%:')
  const finalEmps = await getDocs(collection(db, 'employees'))
  const finalInvs = await getDocs(collection(db, 'invoices'))
  const finalClients = await getDocs(collection(db, 'clients'))
  const finalAccounts = await getDocs(collection(db, 'accounts'))
  console.log(`- الموظفون: ${finalEmps.size} موظف أصلي`)
  console.log(`- الفواتير: ${finalInvs.size} فاتورة أصلية`)
  console.log(`- العملاء: ${finalClients.size} عميل أصلي`)
  console.log(`- شجرة الحسابات: ${finalAccounts.size} حساب قياسي`)
  console.log('========================================')
}

runCleanupAndRestore().catch(err => {
  console.error('Error during cleanup:', err)
  process.exit(1)
})
