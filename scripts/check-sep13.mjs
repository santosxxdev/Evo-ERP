import fs from 'fs'
import path from 'path'

const dir = 'backups/backup-2026-09-23T07-38-25-145Z'
const at = JSON.parse(fs.readFileSync(dir + '/accountingTransactions.json', 'utf8'))

const tx13 = at.filter(t => {
  if (!t.createdAt?.seconds) return false
  return new Date(t.createdAt.seconds * 1000).toISOString().startsWith('2026-09-13')
}).sort((a,b) => a.createdAt.seconds - b.createdAt.seconds)

console.log('Total transactions on 2026-09-13:', tx13.length)
tx13.forEach((t, i) => {
  const time = new Date(t.createdAt.seconds * 1000).toISOString().substring(11, 19)
  console.log(`[${i+1}] Time: ${time} | ID: ${t._id} | SourceType: ${t.sourceType} | SourceId: ${t.sourceId} | Key: ${t.idempotencyKey} | Debit: ${t.totalDebit}`)
  if (t.lines) {
    t.lines.forEach(l => {
      console.log(`     -> Acc: ${l.accountName || l.accountId} | Dr: ${l.debit} | Cr: ${l.credit} | Sub: ${l.subLedgerType || ''} ${l.subLedgerName || l.subLedgerId || ''}`)
    })
  }
})
