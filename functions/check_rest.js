const apiKey = 'AIzaSyCb1BmZI6H7rw4fPO72yNJBQHtsfpzwr8M'
const projectId = 'iyora-eg'

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
]

async function checkRest() {
  console.log('=== CHECKING FIRESTORE VIA REST API ===')
  for (const colName of collections) {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${colName}?key=${apiKey}`
    try {
      const res = await fetch(url)
      const data = await res.json()
      if (data.error) {
        console.log(`Collection "${colName}": REST Response -> ${data.error.message} (${data.error.status})`)
      } else if (data.documents) {
        console.log(`Collection "${colName}": ${data.documents.length} documents found`)
      } else {
        console.log(`Collection "${colName}": 0 documents (empty or non-existent)`)
      }
    } catch (err) {
      console.error(`Error checking ${colName}:`, err.message)
    }
  }
}

checkRest()
