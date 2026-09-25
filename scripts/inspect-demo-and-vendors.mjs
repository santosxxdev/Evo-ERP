import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore'
import fs from 'fs'

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
  console.log('Logged in to Firestore.')

  // 1. VENDORS
  console.log('\n=== 1. VENDORS in Live DB ===')
  const vSnap = await getDocs(collection(db, 'vendors'))
  console.log(`Vendors count: ${vSnap.size}`)
  vSnap.forEach(d => {
    console.log(`- Vendor [ID: ${d.id}]:`, JSON.stringify(d.data()))
  })

  // Compare with backup vendors.json
  const backupVendors = JSON.parse(fs.readFileSync('backups/backup-2026-09-21T17-05-00-589Z/vendors.json', 'utf8'))
  console.log(`\nVendors in Backup: count = ${backupVendors.length}`)
  backupVendors.forEach(v => console.log('  Backup vendor:', v.id, v.data?.name || v.name))

  // 2. PURCHASE INVOICES
  console.log('\n=== 2. PURCHASE INVOICES in Live DB ===')
  const piSnap = await getDocs(collection(db, 'purchaseInvoices'))
  console.log(`PurchaseInvoices count: ${piSnap.size}`)
  piSnap.forEach(d => {
    console.log(`- PurchaseInvoice [ID: ${d.id}]:`, JSON.stringify(d.data()))
  })

  // 3. VENDOR PAYMENTS
  console.log('\n=== 3. VENDOR PAYMENTS in Live DB ===')
  const vpSnap = await getDocs(collection(db, 'vendorPayments'))
  console.log(`VendorPayments count: ${vpSnap.size}`)
  vpSnap.forEach(d => {
    console.log(`- VendorPayment [ID: ${d.id}]:`, JSON.stringify(d.data()))
  })

  // 4. JOB COSTS (Vendor / Freelancer / Model costs)
  console.log('\n=== 4. JOB COSTS in Live DB ===')
  const jcSnap = await getDocs(collection(db, 'jobCosts'))
  console.log(`JobCosts count: ${jcSnap.size}`)
  let totalJc = 0
  jcSnap.forEach(d => {
    const c = d.data()
    totalJc += Number(c.amount || 0)
    console.log(`- JobCost [ID: ${d.id}]: Amount=${c.amount}, Date=${c.date}, Type=${c.type}, Paid=${c.paid}, Vendor=${c.vendorName || c.vendorId}, Emp=${c.employeeName || c.employeeId}, Notes=${c.description || c.notes || ''}`)
  })
  console.log(`Total JobCosts: ${totalJc}`)

  // 5. CLIENTS: Check for dummy / test names
  console.log('\n=== 5. CHECKING CLIENTS FOR TEST/DEMO NAMES ===')
  const clSnap = await getDocs(collection(db, 'clients'))
  console.log(`Total Clients: ${clSnap.size}`)
  const testClients = []
  clSnap.forEach(d => {
    const c = d.data()
    const name = c.name || ''
    if (name.includes('تجريب') || name.includes('test') || name.includes('demo') || name.includes('بطيخة') || name.includes('سلطع') || name.includes('هاوس بروست')) {
      testClients.push({ id: d.id, name, ...c })
    }
  })
  console.log(`Suspicious / Test-like Clients found: ${testClients.length}:`)
  testClients.forEach(c => console.log(`  - Client [${c.id}]: ${c.name} | Phone: ${c.phone} | Created: ${c.createdAt}`))

  // 6. INVOICES: Check for suspicious / test invoices
  console.log('\n=== 6. CHECKING INVOICES FOR TEST/DEMO DATA ===')
  const invSnap = await getDocs(collection(db, 'invoices'))
  const testInvoices = []
  invSnap.forEach(d => {
    const inv = d.data()
    const cName = inv.clientName || ''
    if (cName.includes('تجريب') || cName.includes('test') || cName.includes('demo') || cName.includes('بطيخة') || cName.includes('سلطع') || inv.number === 'INV-TEST' || (inv.date && inv.date < '2026-06-01')) {
      testInvoices.push({ id: d.id, number: inv.number, clientName: cName, date: inv.date, total: inv.total, paid: inv.paidAmount })
    }
  })
  console.log(`Suspicious / Test Invoices found: ${testInvoices.length}:`)
  testInvoices.forEach(i => console.log('  - Invoice:', JSON.stringify(i)))

  // 7. EXPENSES: Check expenses
  console.log('\n=== 7. CHECKING EXPENSES ===')
  const expSnap = await getDocs(collection(db, 'expenses'))
  console.log(`Expenses in Live DB: ${expSnap.size}`)

  const backupExp = JSON.parse(fs.readFileSync('backups/backup-2026-09-21T17-05-00-589Z/expenses.json', 'utf8') || '[]')
  console.log(`Expenses in Backup: ${backupExp.length}`)
  if (backupExp.length > 0) {
    console.log('Sample backup expense:', JSON.stringify(backupExp.slice(0, 3)))
  }
}

inspect().catch(console.error)
