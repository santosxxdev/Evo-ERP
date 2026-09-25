import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, collectionGroup, getDocs, limit, query } from 'firebase/firestore'

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

async function testPayments() {
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('Authenticated.')

  const snap = await getDocs(query(collectionGroup(db, 'payments'), limit(5)))
  console.log(`Found ${snap.size} payments:`)
  snap.forEach(d => {
    console.log('Doc ID:', d.id)
    console.log('Parent invoice ID:', d.ref.parent.parent?.id)
    console.log('Data:', JSON.stringify(d.data()))
  })
}

testPayments().catch(console.error)
