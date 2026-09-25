import fs from 'fs'

const dir = 'backups/backup-2026-09-23T07-38-25-145Z'
const at = JSON.parse(fs.readFileSync(dir + '/accountingTransactions.json', 'utf8'))
const invs = new Set(JSON.parse(fs.readFileSync(dir + '/invoices.json', 'utf8')).map(i => i._id))
const pays = new Set()
JSON.parse(fs.readFileSync(dir + '/invoices.json', 'utf8')).forEach(i => {
  if (i._payments) i._payments.forEach(p => pays.add(p._id))
})
const jes = new Set(JSON.parse(fs.readFileSync(dir + '/journalEntries.json', 'utf8')).map(j => j._id))

const orphans = at.filter(t => {
  if (t.sourceType === 'invoice') return !invs.has(t.sourceId)
  if (t.sourceType === 'payment') return !pays.has(t.sourceId)
  if (t.sourceType === 'voucher') return !jes.has(t.sourceId)
  return false
})

console.log('Total Orphans across whole system:', orphans.length)

const treasuryOrphans = orphans.filter(t => t.lines?.some(l => l.accountId === '1SbzikQIrwhRNebLQItx'))
console.log('Orphans affecting Main Treasury (الخزينة الرئيسية):', treasuryOrphans.length)

treasuryOrphans.forEach((t, i) => {
  const line = t.lines.find(l => l.accountId === '1SbzikQIrwhRNebLQItx')
  console.log(`[${i+1}] ID: ${t._id} | Date: ${t.transactionDate || t.date} | Type: ${t.sourceType} | Dr: ${line.debit} | Cr: ${line.credit} | SourceId: ${t.sourceId}`)
})
