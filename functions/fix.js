const fs = require('fs');

function fixFile(file) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace('// @ts-nocheck\n', '');
    content = content.replace(/import \* as admin from 'firebase-admin';/g, "import * as admin from 'firebase-admin';\nimport { getFirestore, FieldValue, Timestamp, Transaction } from 'firebase-admin/firestore';");
    content = content.replace(/admin\.firestore\.Transaction/g, 'Transaction');
    content = content.replace(/admin\.firestore\.Timestamp/g, 'Timestamp');
    content = content.replace(/admin\.firestore\.FieldValue/g, 'FieldValue');
    content = content.replace(/admin\.firestore\(\)/g, 'getFirestore()');
    
    // Add missing resolveAccount to index.ts if not exists
    if (file === 'src/index.ts' && !content.includes('async function resolveAccount(')) {
        const h = `
async function resolveAccount(accountNumber: string, t: Transaction) {
    const acctSnap = await t.get(getFirestore().collection('accounts').where('code', '==', accountNumber).limit(1));
    if (acctSnap.empty) return null;
    return { id: acctSnap.docs[0].id, ...acctSnap.docs[0].data() };
}
`;
        content = content.replace('const db = getFirestore();', 'const db = getFirestore();\n' + h);
    }
    
    // Fix implicit any
    content = content.replace(/\(t\) =>/g, '(t: Transaction) =>');
    content = content.replace(/\(request\)/g, '(request: any)');
    
    fs.writeFileSync(file, content);
}

fixFile('src/accounting/accountingService.ts');
fixFile('src/index.ts');
