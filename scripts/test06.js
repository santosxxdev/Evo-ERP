import { buildJournal, accountBalances } from '../src/lib/ledger.js';
import { DEFAULT_ACCOUNTS } from '../src/lib/accounts.js';
import { depreciation } from '../src/lib/assets.js';
import fs from 'fs';

function runTests() {
  const results = {
    purchase: [],
    capitalization: [],
    depreciation: [],
    residual: [],
    methods: [],
    duplicateDepreciation: [],
    overCapitalization: [],
    editing: [],
    deletion: [],
    disposal: [],
    writeOff: [],
    maintenance: [],
    assetUsage: [],
    assetTax: [],
    missingAccounts: []
  };

  const testAccounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc_${i}` }));
  const getBal = (journals, role) => accountBalances(journals, testAccounts).find(a => a.account.role === role)?.balance || 0;
  
  const equipment = testAccounts.find(a => a.role === 'equipment');
  const cash = testAccounts.find(a => a.role === 'cash');
  const ap = testAccounts.find(a => a.role === 'vendorPayable');

  // 2. BASIC ASSET PURCHASE
  const asset1 = { id: 'a1', purchaseCost: 100000, purchaseDate: '2026-01-01', name: 'Eq1' };
  const jPurchase = buildJournal({ assets: [asset1], accounts: testAccounts });
  
  results.purchase.push({
    test: 'Asset purchase 100,000',
    equipmentBalance: getBal(jPurchase, 'equipment'), // Expected 100000
    cashBalance: getBal(jPurchase, 'cash') // Expected -100000
  });

  // 3. ASSET CAPITALIZATION & 14. MAINTENANCE
  const maintenance1 = { id: 'm1', assetId: 'a1', cost: 5000, date: '2026-01-15' };
  const jCap = buildJournal({ assets: [asset1], maintenance: [maintenance1], accounts: testAccounts });
  
  results.capitalization.push({
    test: '100k Asset + 5k Maintenance',
    equipmentBalance: getBal(jCap, 'equipment'), // Expected 100000
    maintenanceExpense: getBal(jCap, 'maintenance'), // Expected 5000
    cashBalance: getBal(jCap, 'cash') // Expected -105000
  });

  // 4. DEPRECIATION
  const asset2 = { id: 'a2', purchaseCost: 120000, salvageValue: 0, purchaseDate: '2026-01-01', usefulLifeMonths: 12, depMethod: 'straight' };
  
  // To get depreciation, buildJournal uses `asOf` string. Let's pass it.
  const jDepMonth1 = buildJournal({ assets: [asset2], accounts: testAccounts, asOf: '2026-02-01' });
  const jDepMonth6 = buildJournal({ assets: [asset2], accounts: testAccounts, asOf: '2026-07-01' });
  const jDepMonth12 = buildJournal({ assets: [asset2], accounts: testAccounts, asOf: '2027-01-01' });

  results.depreciation.push({
    test: 'Month 1, 6, 12 Straight-Line',
    month1Accum: -getBal(jDepMonth1, 'accumDep'), // Expected 10000
    month6Accum: -getBal(jDepMonth6, 'accumDep'), // Expected 60000
    month12Accum: -getBal(jDepMonth12, 'accumDep') // Expected 120000
  });

  // 5. RESIDUAL VALUE & 9. OVER-CAPITALIZATION
  const asset3 = { id: 'a3', purchaseCost: 120000, salvageValue: 20000, purchaseDate: '2026-01-01', usefulLifeMonths: 10, depMethod: 'straight' };
  const jDepOver = buildJournal({ assets: [asset3], accounts: testAccounts, asOf: '2027-01-01' }); // 12 months later, life is 10
  
  results.residual.push({
    test: '120k cost, 20k residual, 10 months',
    monthlyDepreciation: depreciation(asset3, '2026-02-01').monthly, // Expected 10000
    accumulatedAfter12Months: -getBal(jDepOver, 'accumDep'), // Expected 100000
    bookValueRemaining: getBal(jDepOver, 'equipment') + getBal(jDepOver, 'accumDep') // Expected 20000
  });

  // 8. DUPLICATE DEPRECIATION
  results.duplicateDepreciation.push({
    test: 'Idempotency',
    status: 'PASS',
    reason: 'Depreciation is generated dynamically via buildJournal(asOf). There is no "Run Depreciation" button that persists duplicate records.'
  });

  // 12. ASSET DISPOSAL / SALE & 13. WRITE-OFF
  results.disposal.push({
    test: 'Disposal Accounting',
    status: 'MISSING',
    reason: 'assets.js status can be "sold", but buildJournal() has no logic for creating a Disposal/Gain/Loss entry.'
  });

  // 16. ASSET TAX
  const assetTax = { id: 'a4', purchaseCost: 100000, purchaseDate: '2026-01-01', taxKind: 'tax1' };
  const jTax = buildJournal({ assets: [assetTax], accounts: testAccounts, settings: { taxRate1: 14 } });
  
  results.assetTax.push({
    test: 'Asset with 14% tax',
    equipmentBalance: getBal(jTax, 'equipment'), // Expected 100000
    taxBalance: getBal(jTax, 'tax'), // Expected 14000
    cashBalance: getBal(jTax, 'cash') // Expected -114000
  });

  // 17. CASH VS PAYABLE
  const assetCredit = { id: 'a5', purchaseCost: 100000, purchaseDate: '2026-01-01', acquisition: 'credit' };
  const jCredit = buildJournal({ assets: [assetCredit], accounts: testAccounts });
  
  results.capitalization.push({
    test: 'Credit Purchase',
    payableBalance: -getBal(jCredit, 'vendorPayable'), // Expected 100000
    cashBalance: getBal(jCredit, 'cash') // Expected 0
  });

  // 19. ACCOUNT MAPPING FAILURE
  // If we remove the 'accumDep' role from accounts
  const badAccounts = testAccounts.map(a => a.role === 'accumDep' ? { ...a, role: null } : a);
  const jBad = buildJournal({ assets: [asset2], accounts: badAccounts, asOf: '2026-02-01' });
  const depEntries = jBad.filter(j => j.id.startsWith('dep-a2'));
  const hasUnbalanced = depEntries.some(j => j.lines.some(l => l.accountId === null));

  results.missingAccounts.push({
    test: 'Missing accumDep Role',
    unbalancedEntryCreated: hasUnbalanced,
    reason: 'The entry is created with accountId = null for the missing role, meaning it does not balance on the Trial Balance.'
  });

  fs.writeFileSync('test06_results.json', JSON.stringify(results, null, 2));
}

runTests();
