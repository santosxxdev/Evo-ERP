import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const backupDir = path.join(rootDir, 'backups', 'backup-2026-09-21T17-05-00-589Z')

const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.json') && !f.startsWith('_'))

console.log('--- INSPECTING BACKUP FILES FOR isDelete / DELETED STATUS ---')
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8'))
  if (!Array.isArray(data)) continue

  let hasDeletedFlag = 0
  const deletedExamples = []
  data.forEach((item, index) => {
    if (
      item.isDelete ||
      item.isDeleted ||
      item.deleted === true ||
      item.status === 'deleted' ||
      item.archived === true
    ) {
      hasDeletedFlag++
      if (deletedExamples.length < 5) {
        deletedExamples.push({
          id: item._id || index,
          isDelete: item.isDelete,
          isDeleted: item.isDeleted,
          deleted: item.deleted,
          status: item.status,
          archived: item.archived
        })
      }
    }
  })

  console.log(`File: ${file.padEnd(28)} | Total docs: ${data.length.toString().padEnd(4)} | Marked deleted/archived: ${hasDeletedFlag}`)
  if (deletedExamples.length > 0) {
    console.log('   Examples:', JSON.stringify(deletedExamples))
  }
}

// Deep inspect Invoices
console.log('\n--- DEEP INSPECT OF INVOICES ---')
const invoices = JSON.parse(fs.readFileSync(path.join(backupDir, 'invoices.json'), 'utf8'))
console.log(`Total Invoices: ${invoices.length}`)

const numbers = []
const numberMap = new Map()
const missingFields = []
let invoicesWithDeletedFlag = 0

invoices.forEach((inv, i) => {
  const num = inv.number || inv.invoiceNumber
  if (!num) {
    missingFields.push({ id: inv._id, issue: 'No number field' })
  } else {
    numbers.push(num)
    if (numberMap.has(num)) {
      numberMap.get(num).push(inv._id)
    } else {
      numberMap.set(num, [inv._id])
    }
  }

  if (inv.isDelete || inv.isDeleted || inv.deleted || inv.status === 'deleted') {
    invoicesWithDeletedFlag++
  }
})

console.log(`Invoices marked deleted: ${invoicesWithDeletedFlag}`)

// Duplicates
const duplicates = []
for (const [num, ids] of numberMap.entries()) {
  if (ids.length > 1) duplicates.push({ num, ids })
}
console.log(`Duplicate invoice numbers: ${duplicates.length}`)
if (duplicates.length > 0) {
  console.log('Duplicates:', duplicates)
}

// Sequence analysis
console.log('\n--- INVOICE NUMBER SEQUENCE ANALYSIS ---')
console.log('Sample invoice numbers:', numbers.slice(0, 10))

// Extract numeric parts if format is e.g. INV-001 or numeric
const parsedNumbers = numbers.map(n => {
  const match = String(n).match(/\d+/)
  return match ? parseInt(match[0], 10) : null
}).filter(n => n !== null).sort((a, b) => a - b)

if (parsedNumbers.length > 0) {
  const minNum = parsedNumbers[0]
  const maxNum = parsedNumbers[parsedNumbers.length - 1]
  console.log(`Numeric range: Min=${minNum}, Max=${maxNum}, Count=${parsedNumbers.length}`)

  // Find gaps in sequence
  const numSet = new Set(parsedNumbers)
  const gaps = []
  for (let i = minNum; i <= maxNum; i++) {
    if (!numSet.has(i)) {
      gaps.push(i)
    }
  }
  console.log(`Missing invoice sequence numbers (gaps between ${minNum} and ${maxNum}):`, gaps.length > 0 ? gaps : 'NONE (Complete sequence)')
}

// Check journalEntries sequence
console.log('\n--- JOURNAL ENTRIES SEQUENCE ANALYSIS ---')
const je = JSON.parse(fs.readFileSync(path.join(backupDir, 'journalEntries.json'), 'utf8'))
const jeNumbers = je.map(j => j.number || j._id)
console.log(`Total Journal Entries: ${je.length}`)
console.log('Sample JE numbers:', jeNumbers.slice(0, 5))
