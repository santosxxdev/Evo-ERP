const fs = require('fs');

// Fix accountingService.ts
let as = fs.readFileSync('src/accounting/accountingService.ts', 'utf8');
if (as.includes('// @ts-nocheck')) as = as.replace('// @ts-nocheck\n', '');
as = as.replace(/import \* as admin from 'firebase-admin';\n?/, "import * as admin from 'firebase-admin';\nimport { getFirestore, FieldValue, Timestamp, Transaction } from 'firebase-admin/firestore';\nimport { getApps, initializeApp } from 'firebase-admin/app';\n");
as = as.replace(/admin\.apps/g, "getApps()");
as = as.replace(/admin\.initializeApp/g, "initializeApp");
as = as.replace(/admin\.firestore\.Timestamp/g, 'Timestamp');
as = as.replace(/admin\.firestore\.FieldValue/g, 'FieldValue');
as = as.replace(/admin\.firestore\.Transaction/g, 'Transaction');
as = as.replace(/admin\.firestore\(\)/g, 'getFirestore()');
fs.writeFileSync('src/accounting/accountingService.ts', as);

// Fix index.ts
let idx = fs.readFileSync('src/index.ts', 'utf8');

// Use regex to remove ALL duplicated async function resolveAccount and their imports if they are messed up, and just reset it cleanly.
idx = idx.replace(/import \{ getFirestore, FieldValue, Timestamp, Transaction \} from 'firebase-admin\/firestore';\nimport \{ getApps, initializeApp \} from 'firebase-admin\/app';\n\nif \(\!getApps\(\)\.length\) \{\n  initializeApp\(\);\n\}\n\nconst db = getFirestore\(\);\n\nasync function resolveAccount\(accountNumber: string, t: Transaction\) \{\n    const acctSnap = await t\.get\(db\.collection\('accounts'\)\.where\('code', '==', accountNumber\)\.limit\(1\)\);\n    if \(acctSnap\.empty\) return null;\n    return \{ id: acctSnap\.docs\[0\]\.id, \.\.\.acctSnap\.docs\[0\]\.data\(\) \} as any;\n\}\n\nasync function resolveAccount\(accountNumber: string, t: Transaction\) \{\n    const acctSnap = await t\.get\(getFirestore\(\)\.collection\('accounts'\)\.where\('code', '==', accountNumber\)\.limit\(1\)\);\n    if \(acctSnap\.empty\) return null;\n    return \{ id: acctSnap\.docs\[0\]\.id, \.\.\.acctSnap\.docs\[0\]\.data\(\) \};\n\}/g, "const db = getFirestore();\n\nasync function resolveAccount(accountNumber: string, t: Transaction): Promise<any> {\n    const acctSnap = await t.get(db.collection('accounts').where('code', '==', accountNumber).limit(1));\n    if (acctSnap.empty) return null;\n    return { id: acctSnap.docs[0].id, ...acctSnap.docs[0].data() };\n}");

// Apply same regex as before
idx = idx.replace(/import \* as admin from 'firebase-admin';/, "import * as admin from 'firebase-admin';\nimport { getFirestore, FieldValue, Timestamp, Transaction } from 'firebase-admin/firestore';\nimport { getApps, initializeApp } from 'firebase-admin/app';");
idx = idx.replace(/admin\.firestore\.Timestamp/g, 'Timestamp');
idx = idx.replace(/admin\.firestore\.FieldValue/g, 'FieldValue');
idx = idx.replace(/admin\.firestore\.Transaction/g, 'Transaction');
idx = idx.replace(/admin\.firestore\(\)/g, 'getFirestore()');

// Fix invoiceRef scoping
idx = idx.replace(/await db\.runTransaction\(async \(t: Transaction\) => \{/g, 'let invoiceRef: any;\n    await db.runTransaction(async (t: Transaction) => {');
idx = idx.replace(/let invoiceRef: any;\n    let invoiceRef: any;\n    await db\.runTransaction/g, 'let invoiceRef: any;\n    await db.runTransaction');
idx = idx.replace(/invoiceRef = db\.collection\('invoices'\)\.doc/g, 'const DUMMY_REF = db.collection(\'invoices\').doc');
idx = idx.replace(/const invoiceRef = /g, 'invoiceRef = ');
idx = idx.replace(/const DUMMY_REF = /g, 'invoiceRef = ');

idx = idx.replace(/return \{ success: true \};/g, 'return { success: true, invoiceId: invoiceRef ? invoiceRef.id : undefined };');

fs.writeFileSync('src/index.ts', idx);
