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

async function audit() {
  await signInWithEmailAndPassword(auth, 'admin@iyora.app', 'admin123456')
  console.log('--- AUTHENTICATED SUCCESSFULLY ---')

  // 1. INVOICES
  const invSnap = await getDocs(collection(db, 'invoices'))
  const invoices = []
  invSnap.forEach(d => invoices.push({ id: d.id, ...d.data() }))
  console.log(`\n=== 1. INVOICES (Total: ${invoices.length}) ===`)
  let totalInvAmount = 0
  let totalInvPaid = 0
  let totalInvRemaining = 0
  invoices.forEach(inv => {
    const total = Number(inv.total || 0)
    const paid = Number(inv.paidAmount || 0)
    const rem = Number(inv.remainingAmount ?? (total - paid))
    totalInvAmount += total
    totalInvPaid += paid
    totalInvRemaining += rem
  })
  console.log(`Summary Invoices: Count=${invoices.length} | Total=${totalInvAmount} | Paid=${totalInvPaid} | Remaining=${totalInvRemaining}`)

  // 2. PAYMENTS
  const paySnap = await getDocs(collectionGroup(db, 'payments'))
  const payments = []
  paySnap.forEach(d => payments.push({ id: d.id, parentInvoiceId: d.ref.parent.parent?.id, ...d.data() }))
  console.log(`\n=== 2. PAYMENTS (Total: ${payments.length}) ===`)
  let totalPayments = 0
  payments.forEach(p => {
    totalPayments += Number(p.amount || 0)
  })
  console.log(`Summary Payments: Count=${payments.length} | Total Amount=${totalPayments}`)

  // 3. EXPENSES
  const expSnap = await getDocs(collection(db, 'expenses'))
  const expenses = []
  expSnap.forEach(d => expenses.push({ id: d.id, ...d.data() }))
  console.log(`\n=== 3. EXPENSES (Total: ${expenses.length}) ===`)
  let totalExpenses = 0
  expenses.forEach(e => {
    const amt = Number(e.amount || 0)
    totalExpenses += amt
    console.log(`- Expense #${e.id}: Date=${e.date}, Amount=${amt}, Cat=${e.categoryName || e.categoryId}, Desc=${e.description || e.notes || ''}, Recipient=${e.recipient || ''}, AccId=${e.accountId}`)
  })
  console.log(`Summary Expenses: Count=${expenses.length} | Total Amount=${totalExpenses}`)

  // 4. JOURNAL ENTRIES / VOUCHERS
  const jSnap = await getDocs(collection(db, 'journalEntries'))
  console.log(`\n=== 4. JOURNAL ENTRIES / VOUCHERS (Total: ${jSnap.size}) ===`)
  let totalVoucherDebit = 0
  let totalVoucherCredit = 0
  jSnap.forEach(d => {
    const v = d.data()
    console.log(`- Voucher #${v.number || d.id}: Type=${v.type}, Date=${v.date}, Desc=${v.description || ''}`)
    if (v.lines) {
      v.lines.forEach(l => {
        totalVoucherDebit += Number(l.debit || 0)
        totalVoucherCredit += Number(l.credit || 0)
        console.log(`    Line: AccId=${l.accountId} | Code=${l.code} | Dr=${l.debit || 0} | Cr=${l.credit || 0} | Sub=${l.subLedgerType}:${l.subLedgerName || l.subLedgerId}`)
      })
    }
  })
  console.log(`Summary Vouchers: Count=${jSnap.size} | Total Dr=${totalVoucherDebit} | Total Cr=${totalVoucherCredit}`)

  // 5. ACCOUNTING TRANSACTIONS
  const txSnap = await getDocs(collection(db, 'accountingTransactions'))
  console.log(`\n=== 5. ACCOUNTING TRANSACTIONS (Total: ${txSnap.size}) ===`)
  let totalTxDr = 0
  let totalTxCr = 0
  const txBySource = {}
  txSnap.forEach(d => {
    const t = d.data()
    txBySource[t.sourceType] = (txBySource[t.sourceType] || 0) + 1
    if (t.lines) {
      t.lines.forEach(l => {
        totalTxDr += Number(l.debit || 0)
        totalTxCr += Number(l.credit || 0)
      })
    }
    console.log(`- TX ID: ${d.id} | Date: ${t.transactionDate} | Type: ${t.sourceType} | SourceId: ${t.sourceId} | Ref: ${t.referenceNumber} | Lines: ${t.lines?.length || 0}`)
  })
  console.log(`Summary Transactions: Count=${txSnap.size} | BySource:`, JSON.stringify(txBySource), `| Total Dr=${totalTxDr} | Total Cr=${totalTxCr}`)

  // 6. EMPLOYEE ENTRIES (Salaries, advances, deductions)
  const eeSnap = await getDocs(collection(db, 'employeeEntries'))
  console.log(`\n=== 6. EMPLOYEE ENTRIES (Total: ${eeSnap.size}) ===`)
  eeSnap.forEach(d => {
    const ee = d.data()
    console.log(`- Emp Entry #${d.id}: Type=${ee.type}, Emp=${ee.employeeName || ee.employeeId}, Amount=${ee.amount}, Date=${ee.date}, Notes=${ee.notes || ee.description}`)
  })

  // 7. JOB COSTS
  const jcSnap = await getDocs(collection(db, 'jobCosts'))
  console.log(`\n=== 7. JOB COSTS (Total: ${jcSnap.size}) ===`)
  jcSnap.forEach(d => {
    const c = d.data()
    console.log(`- JobCost #${d.id}: Type=${c.type}, Amount=${c.amount}, Paid=${c.paid}, Vendor=${c.vendorName || c.vendorId}, Emp=${c.employeeName || c.employeeId}`)
  })

  // 8. ACCOUNTS (Chart of accounts)
  const accSnap = await getDocs(collection(db, 'accounts'))
  console.log(`\n=== 8. ACCOUNTS (Total: ${accSnap.size}) ===`)
  accSnap.forEach(d => {
    const acc = d.data()
    console.log(`- ${acc.code} [ID: ${d.id}]: ${acc.name} | Role=${acc.role || 'none'} | isGroup=${acc.isGroup} | Parent=${acc.parentCode}`)
  })

  // 9. PAYMENT METHODS
  const pmSnap = await getDocs(collection(db, 'paymentMethods'))
  console.log(`\n=== 9. PAYMENT METHODS (Total: ${pmSnap.size}) ===`)
  pmSnap.forEach(d => {
    const pm = d.data()
    console.log(`- Method: ${pm.name} | Type=${pm.type} | AccId=${pm.accountId} | AccCode=${pm.accountCode}`)
  })
}

audit().catch(console.error)
