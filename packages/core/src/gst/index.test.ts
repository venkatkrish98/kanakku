import { describe, it, expect } from 'vitest';
import {
  calculateGstTax,
  calculateInvoiceTaxes,
  computeGstSetOff,
  isValidGstin,
  extractStateCodeFromGstin,
} from './index.js';

describe('GST Engine - GSTIN Validation & State Code', () => {
  it('validates authentic Indian GSTIN formats', () => {
    // Tamil Nadu: 33AAAAA0000A1Z5
    expect(isValidGstin('33AAAAA0000A1Z5')).toBe(true);
    // Karnataka: 29ABCDE1234F2Z5
    expect(isValidGstin('29ABCDE1234F2Z5')).toBe(true);
    // Invalid formats
    expect(isValidGstin('INVALID_GSTIN')).toBe(false);
    expect(isValidGstin('33AAAAA0000A1Z')).toBe(false); // short
    expect(isValidGstin('33AAAAA0000A1Z59')).toBe(false); // long
  });

  it('extracts state code accurately', () => {
    expect(extractStateCodeFromGstin('33AAAAA0000A1Z5')).toBe('33');
    expect(extractStateCodeFromGstin('29ABCDE1234F2Z5')).toBe('29');
    expect(() => extractStateCodeFromGstin('INVALID')).toThrow('Invalid GSTIN');
  });
});

describe('GST Engine - Component-Primary Intra-State Tax Calculation', () => {
  it('calculates 18% intra-state tax with identical CGST and SGST', () => {
    const res = calculateGstTax({
      taxableAmountPaise: 100000n, // ₹1,000.00
      gstRateBps: 1800, // 18%
      sellerStateCode: '33', // Tamil Nadu
      placeOfSupplyStateCode: '33', // Tamil Nadu
    });

    expect(res.isInterState).toBe(false);
    // 9% CGST = ₹90.00 = 9000 paise
    expect(res.cgstPaise).toBe(9000n);
    // 9% SGST = ₹90.00 = 9000 paise
    expect(res.sgstPaise).toBe(9000n);
    expect(res.igstPaise).toBe(0n);
    // Total Tax = 18000 paise
    expect(res.totalTaxPaise).toBe(18000n);
    expect(res.totalAmountPaise).toBe(118000n);
    // Mathematical symmetry guarantee
    expect(res.cgstPaise).toBe(res.sgstPaise);
    expect(res.totalTaxPaise % 2n).toBe(0n);
  });

  it('handles odd-paise amounts without contradiction or split error', () => {
    // Case 1: 18% of 3 paise
    // 9% of 3 paise = 0.27 -> rounds to 0 paise
    const res3 = calculateGstTax({
      taxableAmountPaise: 3n,
      gstRateBps: 1800,
      sellerStateCode: '33',
      placeOfSupplyStateCode: '33',
    });
    expect(res3.cgstPaise).toBe(0n);
    expect(res3.sgstPaise).toBe(0n);
    expect(res3.totalTaxPaise).toBe(0n);
    expect(res3.totalAmountPaise).toBe(3n);

    // Case 2: 18% of 6 paise
    // 9% of 6 paise = 0.54 -> rounds to 1 paise
    const res6 = calculateGstTax({
      taxableAmountPaise: 6n,
      gstRateBps: 1800,
      sellerStateCode: '33',
      placeOfSupplyStateCode: '33',
    });
    expect(res6.cgstPaise).toBe(1n);
    expect(res6.sgstPaise).toBe(1n);
    expect(res6.totalTaxPaise).toBe(2n);
    expect(res6.totalAmountPaise).toBe(8n);
  });

  it('supports all standard Indian GST rate slabs (0%, 5%, 12%, 18%, 28%)', () => {
    const taxable = 100000n; // ₹1,000

    // 0%
    const r0 = calculateGstTax({
      taxableAmountPaise: taxable,
      gstRateBps: 0,
      sellerStateCode: '33',
      placeOfSupplyStateCode: '33',
    });
    expect(r0.totalTaxPaise).toBe(0n);

    // 5% (2.5% CGST + 2.5% SGST)
    const r5 = calculateGstTax({
      taxableAmountPaise: taxable,
      gstRateBps: 500,
      sellerStateCode: '33',
      placeOfSupplyStateCode: '33',
    });
    expect(r5.cgstPaise).toBe(2500n);
    expect(r5.sgstPaise).toBe(2500n);
    expect(r5.totalTaxPaise).toBe(5000n);

    // 12% (6% CGST + 6% SGST)
    const r12 = calculateGstTax({
      taxableAmountPaise: taxable,
      gstRateBps: 1200,
      sellerStateCode: '33',
      placeOfSupplyStateCode: '33',
    });
    expect(r12.cgstPaise).toBe(6000n);
    expect(r12.sgstPaise).toBe(6000n);
    expect(r12.totalTaxPaise).toBe(12000n);

    // 28% (14% CGST + 14% SGST)
    const r28 = calculateGstTax({
      taxableAmountPaise: taxable,
      gstRateBps: 2800,
      sellerStateCode: '33',
      placeOfSupplyStateCode: '33',
    });
    expect(r28.cgstPaise).toBe(14000n);
    expect(r28.sgstPaise).toBe(14000n);
    expect(r28.totalTaxPaise).toBe(28000n);
  });
});

describe('GST Engine - Inter-State Tax Calculation', () => {
  it('applies 100% of tax to IGST on inter-state supply', () => {
    const res = calculateGstTax({
      taxableAmountPaise: 100000n, // ₹1,000.00
      gstRateBps: 1800, // 18%
      sellerStateCode: '33', // Tamil Nadu
      placeOfSupplyStateCode: '29', // Karnataka
    });

    expect(res.isInterState).toBe(true);
    expect(res.cgstPaise).toBe(0n);
    expect(res.sgstPaise).toBe(0n);
    expect(res.igstPaise).toBe(18000n);
    expect(res.totalTaxPaise).toBe(18000n);
    expect(res.totalAmountPaise).toBe(118000n);
  });
});

describe('GST Engine - Multi-Line Invoice Calculation', () => {
  it('calculates mixed-rate lines and aggregates invoice totals accurately', () => {
    const invoice = calculateInvoiceTaxes({
      sellerStateCode: '33',
      placeOfSupplyStateCode: '33',
      lineItems: [
        {
          description: 'Consulting Service (18%)',
          quantity: 40n,
          unitPricePaise: 150000n, // ₹1,500/hr -> subtotal = ₹60,000 = 6000000 paise
          gstRateBps: 1800,
        },
        {
          description: 'Technical Documentation (12%)',
          quantity: 1n,
          unitPricePaise: 1000000n, // ₹10,000 = 1000000 paise
          gstRateBps: 1200,
        },
      ],
    });

    expect(invoice.isInterState).toBe(false);
    expect(invoice.subtotalPaise).toBe(7000000n); // ₹70,000
    // Line 1 tax: 18% of 60,000 = 10,800 (CGST 5,400 + SGST 5,400)
    // Line 2 tax: 12% of 10,000 = 1,200 (CGST 600 + SGST 600)
    // Total CGST: 5,400 + 600 = 6,000 = 600000 paise
    // Total SGST: 5,400 + 600 = 6,000 = 600000 paise
    expect(invoice.cgstPaise).toBe(600000n);
    expect(invoice.sgstPaise).toBe(600000n);
    expect(invoice.igstPaise).toBe(0n);
    expect(invoice.totalTaxPaise).toBe(1200000n);
    expect(invoice.grandTotalPaise).toBe(8200000n); // ₹82,000
  });

  it('supports Section 170 rupee round-off when enabled', () => {
    const invoice = calculateInvoiceTaxes({
      sellerStateCode: '33',
      placeOfSupplyStateCode: '33',
      enableRupeeRoundOff: true,
      lineItems: [
        {
          description: 'Odd Line Item',
          quantity: 1n,
          unitPricePaise: 240050n, // ₹2,400.50
          gstRateBps: 1800, // 18% = 432.09 (CGST 216.05 + SGST 216.05) -> Total = 2832.59
        },
      ],
    });

    // 240050 * 9% = 21604.5 -> rounds to 21605 paise (₹216.05)
    // CGST = 21605, SGST = 21605, Total Tax = 43210 paise
    // Unrounded grand total = 240050 + 43210 = 283260 paise (₹2,832.60)
    // Rounded to rupee (100 paise) = 283300 paise (₹2,833.00)
    // Round-off = +40 paise
    expect(invoice.grandTotalPaise % 100n).toBe(0n);
    expect(invoice.roundOffPaise).toBe(40n);
    expect(invoice.grandTotalPaise).toBe(283300n);
  });
});

describe('GST Engine - Section 49 Statutory Set-off Engine', () => {
  it('applies statutory set-off order correctly without cross set-off between CGST and SGST', () => {
    // Business owes: Output CGST = ₹10,000, Output SGST = ₹10,000, Output IGST = ₹5,000
    // Business has ITC: IGST ITC = ₹8,000, CGST ITC = ₹4,000, SGST ITC = ₹3,000
    const setOff = computeGstSetOff({
      outputTax: {
        cgstPaise: 1000000n, // ₹10,000
        sgstPaise: 1000000n, // ₹10,000
        igstPaise: 500000n, // ₹5,000
      },
      availableItc: {
        cgstPaise: 400000n, // ₹4,000
        sgstPaise: 300000n, // ₹3,000
        igstPaise: 800000n, // ₹8,000
      },
    });

    // Step 1: IGST ITC (8,000)
    // 1a: Against Output IGST (5,000) -> 0 Output IGST remains. Remaining IGST ITC = 3,000.
    expect(setOff.utilizedItc.igstAgainstIgstPaise).toBe(500000n);
    // 1b: Against Output CGST (10,000) -> utilizes 3,000. Remaining Output CGST = 7,000. Remaining IGST ITC = 0.
    expect(setOff.utilizedItc.igstAgainstCgstPaise).toBe(300000n);
    expect(setOff.utilizedItc.igstAgainstSgstPaise).toBe(0n);

    // Step 2: CGST ITC (4,000)
    // 2a: Against remaining Output CGST (7,000) -> utilizes 4,000. Remaining Output CGST = 3,000.
    expect(setOff.utilizedItc.cgstAgainstCgstPaise).toBe(400000n);

    // Step 3: SGST ITC (3,000)
    // 3a: Against Output SGST (10,000) -> utilizes 3,000. Remaining Output SGST = 7,000.
    expect(setOff.utilizedItc.sgstAgainstSgstPaise).toBe(300000n);

    // Net Cash Liability Payable:
    // IGST: ₹0
    // CGST: ₹3,000 = 300000 paise
    // SGST: ₹7,000 = 700000 paise
    // Total cash payable: ₹10,000 = 1000000 paise
    expect(setOff.netPayable.igstPaise).toBe(0n);
    expect(setOff.netPayable.cgstPaise).toBe(300000n);
    expect(setOff.netPayable.sgstPaise).toBe(700000n);
    expect(setOff.netPayable.totalCashPayablePaise).toBe(1000000n);

    // Closing ITC balances are zero
    expect(setOff.closingItcBalance.totalBalancePaise).toBe(0n);
  });
});
