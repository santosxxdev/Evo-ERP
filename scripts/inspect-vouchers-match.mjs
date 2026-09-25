import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore'

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

async function inspect() {
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('Logged in.')

  // Check account ks2M5KHOcmJYoJppDCmN
  const accSnap = await getDoc(doc(db, 'accounts', 'ks2M5KHOcmJYoJppDCmN'))
  console.log('Account Details:', accSnap.data())

  // Check all journalEntries (vouchers) for 1500, 800, 500
  const jSnap = await getDocs(collection(db, 'journalEntries'))
  console.log(`\n=== MATCHING VOUCHERS in journalEntries ===`)
  jSnap.forEach(d => {
    const v = d.data()
    const str = JSON.stringify(v)
    if (str.includes('1500') || str.includes('800') || str.includes('رياض') || str.includes('2026-09-08') || str.includes('2026-09-09')) {
      console.log(`DocID: ${d.id} | Number: ${v.number} | Type: ${v.type} | Date: ${v.date} | Desc: ${v.description}`)
      console.log('  Lines:', JSON.stringify(v.lines))
    }
  })

  // Check accountingTransactions matching 2026-04-30 or 2026-09-03 or ks2M5KHOcmJYoJppDCmN
  const txSnap = await getDocs(collection(db, 'accountingTransactions'))
  console.log(`\n=== MATCHING TXs in accountingTransactions ===`)
  txSnap.forEach(d => {
    const t = d.data()
    const str = JSON.stringify(t)
    if (str.includes('ks2M5KHOcmJYoJppDCmN') && (t.transactionDate?.includes('2026-04-30') || t.transactionDate?.includes('2026-09-03') || t.transactionDate?.includes('2026-09-08') || t.transactionDate?.includes('2026-09-09'))) {
      console.log(`TX ID: ${d.id} | Date: ${t.transactionDate} | Type: ${t.sourceType} | SourceId: ${t.sourceId} | Ref: ${t.referenceNumber} | Desc: ${t.description}`)
      console.log('  Lines:', JSON.stringify(t.lines))
    }
  })
}

inspect().catch(console.error)
