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

async function run() {
  console.log('🔐 تسجيل الدخول...')
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('✅ تم تسجيل الدخول.')

  // 1. Delete the 3 purchase invoices
  const piIds = [
    { id: '2lYxTlFnZX9R1qHR9E2o', num: 'PUR-218169', vendor: 'حنين' },
    { id: '8SVSTmr4OlmjDgqppsjq', num: 'PUR-851874', vendor: 'nbil' },
    { id: 'TmmulL5C7lSQI8N9ebSd', num: 'PUR-606450', vendor: 'فلة' }
  ]

  for (const pi of piIds) {
    await deleteDoc(doc(db, 'purchaseInvoices', pi.id))
    console.log(`✓ تم حذف فاتورة المشتريات: ${pi.num} (${pi.vendor})`)
  }

  // 2. Delete the associated purchase return
  await deleteDoc(doc(db, 'purchaseReturns', 'cuIFYAK8E8GFr2mtUpP3'))
  console.log(`✓ تم حذف مردود المشتريات التجريبي: CN-060169`)

  // 3. Delete their 4 accounting transactions
  const txIds = [
    '6aZgG4yyrdDH77OBSY2t', // PUR-218169
    'mLUnAkGR7jsKMrnN885l', // PUR-851874
    '179MvnkrF7QdgnJ4BnZi', // PUR-606450
    'ht3nq4L9TV5bdtXB4v39'  // CN-060169
  ]

  for (const txId of txIds) {
    await deleteDoc(doc(db, 'accountingTransactions', txId))
    console.log(`✓ تم حذف القيد المحاسبي التابع: ${txId}`)
  }

  console.log('\n🎉 تم حذف الفواتير ومردوداتها وقيودها بالكامل وبنجاح!')
}

run().catch(console.error)
