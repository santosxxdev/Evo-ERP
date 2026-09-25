import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, collection, getDocs, collectionGroup } from 'firebase/firestore'

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
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('Logged in.')

  console.log('\n--- 1. SEARCHING vouchers COLLECTION ---')
  const vSnap = await getDocs(collection(db, 'vouchers'))
  vSnap.forEach(d => {
    console.log('Voucher ID:', d.id, JSON.stringify(d.data()))
  })

  console.log('\n--- 2. SEARCHING journal COLLECTION ---')
  const jSnap = await getDocs(collection(db, 'journal'))
  jSnap.forEach(d => {
    console.log('Journal ID:', d.id, JSON.stringify(d.data()))
  })

  console.log('\n--- 3. SEARCHING accountingTransactions ---')
  const txSnap = await getDocs(collection(db, 'accountingTransactions'))
  txSnap.forEach(d => {
    const data = d.data()
    const str = JSON.stringify(data)
    if (str.includes('1500') || str.includes('رياض') || str.includes('2026-04-30') || str.includes('2026-09-08') || str.includes('2026-09-09') || (data.lines && data.lines.some(l => l.debit === 5000 || l.credit === 5000 || l.debit === 1500 || l.credit === 1500))) {
      console.log('TX ID:', d.id, 'Date:', data.transactionDate, 'Source:', data.sourceType, 'Ref:', data.referenceNumber, 'Desc:', data.description)
      console.log('Lines:', JSON.stringify(data.lines))
    }
  })

  console.log('\n--- 4. SEARCHING expenses ---')
  const expSnap = await getDocs(collection(db, 'expenses'))
  expSnap.forEach(d => {
    const data = d.data()
    if (data.amount === 1500 || data.amount === 800 || data.amount === 500 || (data.notes && data.notes.includes('رياض')) || (data.recipient && data.recipient.includes('رياض'))) {
      console.log('Expense ID:', d.id, JSON.stringify(data))
    }
  })

  console.log('\n--- 5. SEARCHING payments ---')
  const pSnap = await getDocs(collectionGroup(db, 'payments'))
  pSnap.forEach(d => {
    const data = d.data()
    if (data.amount === 5000 || data.amount === 500 || data.date === '2026-04-30' || data.date === '2026-09-03') {
      console.log('Payment ID:', d.id, 'Invoice:', d.ref.parent.parent?.id, JSON.stringify(data))
    }
  })
}

run().catch(console.error)
