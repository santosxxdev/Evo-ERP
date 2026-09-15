const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) {
  initializeApp({ projectId: 'iyora-eg' });
}

const db = getFirestore();

const collections = [
  'invoices',
  'purchaseInvoices',
  'purchaseReturns',
  'supplierCreditNotes',
  'vendorAdvances',
  'vendorPayments',
  'accountingTransactions',
  'clients',
  'vendors',
  'jobCosts',
  'expenses',
  'accounts',
  'users'
];

async function check() {
  console.log('=== REAL FIRESTORE DATABASE (iyora-eg) STATUS ===');
  for (const colName of collections) {
    try {
      const snap = await db.collection(colName).get();
      console.log(`Collection "${colName}": ${snap.size} documents`);
      if (snap.size > 0 && snap.size <= 5) {
        snap.docs.forEach(doc => {
          const d = doc.data();
          console.log(`  - ID: ${doc.id} | Info: ${d.name || d.number || d.email || d.code || doc.id}`);
        });
      }
    } catch (err) {
      console.error(`Error reading ${colName}:`, err.message);
    }
  }
  process.exit(0);
}

check();
