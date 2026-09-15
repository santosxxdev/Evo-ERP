import { validateTransaction, requireRole, validatePeriod } from '../src/lib/accounting.js'

function testValidation() {
  let passed = 0
  let failed = 0

  function assertPass(name, tx) {
    try {
      validateTransaction(tx)
      passed++
      console.log(`PASS: ${name}`)
    } catch (e) {
      failed++
      console.error(`FAIL: ${name} (threw: ${e.message})`)
    }
  }

  function assertFail(name, tx) {
    try {
      validateTransaction(tx)
      failed++
      console.error(`FAIL: ${name} (did not throw)`)
    } catch (e) {
      passed++
      console.log(`PASS: ${name} (threw as expected: ${e.message})`)
    }
  }

  // A. Balanced journal succeeds
  assertPass('Balanced journal succeeds', {
    lines: [
      { accountId: '1', debit: 100, credit: 0 },
      { accountId: '2', debit: 0, credit: 100 }
    ]
  })

  // B. Unbalanced journal fails
  assertFail('Unbalanced journal fails', {
    lines: [
      { accountId: '1', debit: 100, credit: 0 },
      { accountId: '2', debit: 0, credit: 90 }
    ]
  })

  // C. Negative debit fails
  assertFail('Negative debit fails', {
    lines: [
      { accountId: '1', debit: -100, credit: 0 },
      { accountId: '2', debit: 0, credit: -100 }
    ]
  })

  // D. Negative credit fails
  assertFail('Negative credit fails', {
    lines: [
      { accountId: '1', debit: 100, credit: 0 },
      { accountId: '2', debit: 0, credit: -100 }
    ]
  })

  // E. Both debit and credit on same line fails
  assertFail('Both debit and credit on same line fails', {
    lines: [
      { accountId: '1', debit: 100, credit: 100 },
      { accountId: '2', debit: 0, credit: 0 }
    ]
  })

  // F. Missing account fails
  assertFail('Missing account fails', {
    lines: [
      { debit: 100, credit: 0 },
      { accountId: '2', debit: 0, credit: 100 }
    ]
  })

  // G. Missing required account role fails
  try {
    requireRole([], 'revenue', 'Invoice 101')
    console.error('FAIL: Missing role did not throw')
    failed++
  } catch (e) {
    passed++
    console.log('PASS: Missing role throws as expected')
  }

  // M. Closed period rejects posting
  try {
    validatePeriod('2026-01-01', { closedPeriodBefore: '2026-02-01' })
    console.error('FAIL: Closed period did not throw')
    failed++
  } catch (e) {
    passed++
    console.log('PASS: Closed period throws as expected')
  }

  // Period allows open dates
  try {
    validatePeriod('2026-03-01', { closedPeriodBefore: '2026-02-01' })
    passed++
    console.log('PASS: Open period succeeds')
  } catch (e) {
    failed++
    console.error('FAIL: Open period threw')
  }

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`)
}

testValidation()
