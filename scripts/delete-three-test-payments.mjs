import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { deleteDoc, doc, getFirestore } from 'firebase/firestore'

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

const TARGET_IDS = [
  'daoF8czEZQfqBsaMYtl2', // 5,000
  'VLiORWyIyAINi1VPt4X3', // 2,500
  'HFLkgARsTVKOPLXGTbEy'  // 10,000
]

async function runDelete() {
  console.log('🔐 تسجيل الدخول بحساب المدير...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول بنجاح.')

  console.log('\n🗑️ جاري حذف العمليات الثلاث غير المرتبطة من جدول الحركات المحاسبية...')
  for (const id of TARGET_IDS) {
    await deleteDoc(doc(db, 'accountingTransactions', id))
    console.log(`  ✓ تم حذف الحركة: ${id}`)
  }

  console.log('\n🎉 تم حذف العمليات الثلاث بنجاح وتحديث دفتر الأستاذ للخزينة الرئيسية!')
}

runDelete().catch(console.error)
