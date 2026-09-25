import fs from 'fs'

const dir = 'backups/backup-2026-09-23T07-38-25-145Z'
const at = JSON.parse(fs.readFileSync(dir + '/accountingTransactions.json', 'utf8'))
const invoices = JSON.parse(fs.readFileSync(dir + '/invoices.json', 'utf8'))
const invoiceMap = new Map(invoices.map(i => [i._id, i]))
const payments = []
invoices.forEach(i => {
  if (i._payments) i._payments.forEach(p => payments.push({ ...p, invoiceId: i._id, invoiceNumber: i.number, clientName: i.clientName }))
})
const paymentMap = new Map(payments.map(p => [p._id, p]))

const vouchers = JSON.parse(fs.readFileSync(dir + '/journalEntries.json', 'utf8'))
const voucherMap = new Map(vouchers.map(v => [v._id, v]))

const unlinkedEntries = []

at.forEach(tx => {
  let ref = tx.referenceNumber || ''
  let invoiceNumber = ''
  let clientName = ''
  let partyName = ''
  let description = tx.description || ''

  if (tx.sourceType === 'invoice') {
    const inv = invoiceMap.get(tx.sourceId)
    if (inv) {
      invoiceNumber = inv.number || ''
      clientName = inv.clientName || ''
      partyName = clientName
    }
  } else if (tx.sourceType === 'payment') {
    const p = paymentMap.get(tx.sourceId)
    const inv = p?.invoiceId ? invoiceMap.get(p.invoiceId) : null
    invoiceNumber = p?.invoiceNumber || inv?.number || ''
    clientName = p?.clientName || inv?.clientName || ''
    partyName = clientName
  } else if (tx.sourceType === 'voucher') {
    const v = voucherMap.get(tx.sourceId)
    if (v) {
      partyName = v.description || ''
      ref = v.number || ''
    }
  }

  // Check if completely unlinked (no client/party and no invoice ref)
  if (!partyName && !invoiceNumber && !ref) {
    unlinkedEntries.push({
      txId: tx._id,
      date: tx.transactionDate || tx.date,
      sourceType: tx.sourceType,
      sourceId: tx.sourceId,
      amount: tx.totalDebit,
      lines: tx.lines?.map(l => ({
        account: l.accountName || l.accountId,
        debit: l.debit,
        credit: l.credit
      }))
    })
  }
})

console.log('Total unlinked entries in accountingTransactions:', unlinkedEntries.length)
unlinkedEntries.forEach((u, i) => {
  console.log(`[${i+1}] ID: ${u.txId} | Date: ${u.date} | Type: ${u.sourceType} | Amount: ${u.amount} ج.م`)
  u.lines?.forEach(l => console.log(`      Acc: ${l.account} | Dr: ${l.debit} | Cr: ${l.credit}`))
})
