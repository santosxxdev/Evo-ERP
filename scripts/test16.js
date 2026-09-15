import { computeTotals } from '../src/lib/invoice.js';
import fs from 'fs';

function runTests() {
  const results = {
    serviceMasterLimits: [],
    minSellingPrice: [],
    lossMakingSales: [],
    discountVulnerabilities: [],
    taxInteraction: [],
    priceHistory: []
  };

  // 1. Minimum Selling Price & Negative Price Prevention
  // Service has no minPrice field in Services.jsx, no validation.
  results.minSellingPrice.push({
    test: 'Minimum Selling Price Validation',
    status: 'MISSING',
    reason: 'The service data model in Services.jsx has no field for minimum selling price. It only tracks name, price, unit, categoryId, and costing. Users can override the price to literally anything during invoice creation.'
  });

  results.serviceMasterLimits.push({
    test: 'Negative Price / Zero Price Prevention',
    status: 'FAIL',
    reason: 'Neither Services.jsx nor Invoices.jsx enforce > 0 constraints. A user can create a service with a price of -500, or manually enter -500 into an invoice line item.'
  });

  // 3. Loss Making Sales
  results.lossMakingSales.push({
    test: 'Selling Below Cost',
    status: 'FAIL',
    reason: 'Since there is no minimum price, a user can sell a service that costs 1,000 for 500 or 0. The invoice is accepted without any warnings or managerial approval workflow. Service profitability simply becomes negative.'
  });

  // 4. Discounts
  const inv1 = computeTotals({
    items: [{ price: 10000, qty: 1 }],
    discountMode: 'percent',
    discountValue: 150 // 150% discount
  });
  
  const inv2 = computeTotals({
    items: [{ price: 10000, qty: 1 }],
    discountMode: 'amount',
    discountValue: 15000 // 15,000 discount on 10,000 fee
  });

  results.discountVulnerabilities.push({
    test: 'Discount Caps',
    inv1_150_percent_discount: inv1.total,
    inv2_15000_amount_discount: inv2.total,
    reason: 'The `computeTotals` function mathematically caps the applied discount using Math.min(Math.max(rawDiscount, 0), fees). Therefore, 150% discount or an amount > subtotal just yields a 0 invoice total, preventing negative revenue from discounts. However, negative LINE PRICES are still allowed and bypass this.'
  });

  const inv3 = computeTotals({
    items: [{ price: -5000, qty: 1 }],
    discount: 0
  });

  results.discountVulnerabilities.push({
    test: 'Negative Line Item Bypass',
    inv3_negative_line: inv3.total, // -5000
    reason: 'While discounts are capped to prevent negative totals, a user can simply enter a negative price on a line item, which creates a negative total invoice (-5,000), reducing total AR and Revenue.'
  });

  // 10. Tax Interaction
  results.taxInteraction.push({
    test: 'Tax-Inclusive Pricing',
    status: 'MISSING',
    reason: 'The system only calculates tax ON TOP of the net amount (Tax-Exclusive). There is no toggle for Tax-Inclusive pricing where the entered price of 1,000 would back-calculate a base of 877.19 and tax of 122.81.'
  });

  // 12. Price History
  results.priceHistory.push({
    test: 'Price Versioning',
    status: 'MISSING',
    reason: 'Services do not maintain a price history or effective dates. When a service is added to a quotation or invoice, the UI copies the current price into the document. If the service master price changes later, the historical document remains intact (it snapshotted the value), but there is no way to audit what the "official" price was on the date of the old sale.'
  });

  fs.writeFileSync('test16_results.json', JSON.stringify(results, null, 2));
}

runTests();
