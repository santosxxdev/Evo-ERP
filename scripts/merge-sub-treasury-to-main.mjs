import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, doc, getDoc, updateDoc, deleteDoc, setDoc, collection, getDocs } from 'firebase/firestore'

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

const MAIN_TREASURY_ID = '1SbzikQIrwhRNebLQItx'
const MAIN_TREASURY_CODE = '1-01-01-01-01-001'
const MAIN_TREASURY_NAME = 'الخزينة الرئيسية'

const SUB_TREASURY_ID = 'uhLaFvWPnMtKiIHZPr9Z'
const SUB_TREASURY_CODE = '1-01-01-01-01-002'

async function executeMerge() {
  console.log('1. تسجيل الدخول بحساب المدير...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول بنجاح.\n')

  console.log('2. فحص وتحديث المعاملات المحاسبية...')
  const txIds = ['7E2NAI85Ep5UU0RaKz3u', 'CLHHOQ5hi0Lg4f2qcjrd', 'VPpjHVLJwGxwonMjrl6H']
  
  for (const id of txIds) {
    const txRef = doc(db, 'accountingTransactions', id)
    const snap = await getDoc(txRef)
    if (!snap.exists()) {
      console.warn(`⚠️ المعاملة ${id} غير موجودة!`)
      continue
    }

    const data = snap.data()
    let updated = false
    const newLines = (data.lines || []).map(line => {
      if (line.accountId === SUB_TREASURY_ID || line.accountCode === SUB_TREASURY_CODE) {
        updated = true
        const updatedLine = { ...line, accountId: MAIN_TREASURY_ID }
        if (line.accountCode) updatedLine.accountCode = MAIN_TREASURY_CODE
        if (line.accountName) updatedLine.accountName = MAIN_TREASURY_NAME
        return updatedLine
      }
      return line
    })

    if (updated) {
      const updatedData = { ...data, lines: newLines }
      await deleteDoc(txRef)
      await setDoc(txRef, updatedData)
      console.log(`✅ تم تحديث المعاملة [${id}] ونقل خط الصندوق الفرعي إلى الخزينة الرئيسية.`)
    } else {
      console.log(`ℹ️ المعاملة [${id}] تم تحديثها مسبقاً أو لا تحتوي على الصندوق الفرعي.`)
    }
  }

  console.log('\n3. حذف حساب الصندوق الفرعي من شجرة الحسابات (accounts)...')
  const subAcctRef = doc(db, 'accounts', SUB_TREASURY_ID)
  const subAcctSnap = await getDoc(subAcctRef)
  if (subAcctSnap.exists()) {
    await deleteDoc(subAcctRef)
    console.log(`✅ تم حذف حساب الصندوق الفرعي (${SUB_TREASURY_ID}) نهائياً من كولكشن accounts.`)
  } else {
    console.log(`ℹ️ الحساب غير موجود بالفعل أو تم حذفه مسبقاً.`)
  }

  // Also check if any other account has code '1-01-01-01-01-002'
  const accountsSnap = await getDocs(collection(db, 'accounts'))
  for (const d of accountsSnap.docs) {
    if (d.data().code === SUB_TREASURY_CODE && d.id !== SUB_TREASURY_ID) {
      await deleteDoc(d.ref)
      console.log(`✅ تم حذف حساب مكرر يحمل نفس الكود: ${d.id}`)
    }
  }

  console.log('\n4. التحقق النهائي من خلو النظام من الصندوق الفرعي...')
  const verifyTxSnap = await getDocs(collection(db, 'accountingTransactions'))
  let remainingTxCount = 0
  verifyTxSnap.forEach(d => {
    const lines = d.data().lines || []
    if (lines.some(l => l.accountId === SUB_TREASURY_ID || l.accountCode === SUB_TREASURY_CODE)) {
      remainingTxCount++
    }
  })
  console.log(`- الحركات المتبقية برقم الصندوق الفرعي: ${remainingTxCount} (المطلوب: 0)`)

  const verifyAcctSnap = await getDocs(collection(db, 'accounts'))
  let remainingAcctCount = 0
  verifyAcctSnap.forEach(d => {
    if (d.id === SUB_TREASURY_ID || d.data().code === SUB_TREASURY_CODE) {
      remainingAcctCount++
    }
  })
  console.log(`- حسابات الصندوق الفرعي المتبقية في دليل الحسابات: ${remainingAcctCount} (المطلوب: 0)`)

  if (remainingTxCount === 0 && remainingAcctCount === 0) {
    console.log('\n🎉 عملية الدمج والحذف اكتملت بنجاح وبنسبة 100% وبدون أي مشاكل!')
  } else {
    console.warn('\n⚠️ هناك بنود متبقية، يرجى مراجعتها.')
  }
}

executeMerge().catch(err => {
  console.error('❌ خطأ أثناء التنفيذ:', err)
  process.exit(1)
})
