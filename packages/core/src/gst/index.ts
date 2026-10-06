/**
 * Deterministic Indian GST (Goods and Services Tax) Engine.
 * Adheres to Kanakku's Component-Primary Integer Rounding Policy.
 * Floating point numbers are strictly forbidden.
 */

import { roundHalfUp } from '../money/index.js';

export const GST_RATES_BPS = {
  NIL: 0,
  FIVE: 500,
  TWELVE: 1200,
  EIGHTEEN: 1800,
  TWENTY_EIGHT: 2800,
} as const;

export type GstRateBps = (typeof GST_RATES_BPS)[keyof typeof GST_RATES_BPS];

export const VALID_GST_RATES: readonly number[] = [0, 500, 1200, 1800, 2800];

export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export function isValidGstin(gstin: string): boolean {
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

export function extractStateCodeFromGstin(gstin: string): string {
  if (!isValidGstin(gstin)) {
    throw new Error(`Invalid GSTIN format: ${gstin}`);
  }
  return gstin.trim().slice(0, 2);
}

export interface GstTaxBreakdown {
  isInterState: boolean;
  taxableAmountPaise: bigint;
  gstRateBps: number;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalTaxPaise: bigint;
  totalAmountPaise: bigint;
}

/**
 * Calculates GST for a single taxable amount using Kanakku's Component-Primary Integer Rounding.
 * On intra-state supplies, CGST and SGST are computed symmetrically at half rate, guaranteeing:
 * cgst_paise === sgst_paise and totalTaxPaise === 2 * cgst_paise (always an even integer).
 */
export function calculateGstTax(params: {
  taxableAmountPaise: bigint;
  gstRateBps: number;
  sellerStateCode: string;
  placeOfSupplyStateCode: string;
}): GstTaxBreakdown {
  const { taxableAmountPaise, gstRateBps, sellerStateCode, placeOfSupplyStateCode } = params;

  if (taxableAmountPaise < 0n) {
    throw new Error('Taxable amount cannot be negative');
  }

  if (!VALID_GST_RATES.includes(gstRateBps)) {
    throw new Error(`Invalid GST rate in basis points: ${gstRateBps}`);
  }

  const isInterState = sellerStateCode.trim() !== placeOfSupplyStateCode.trim();

  if (gstRateBps === 0) {
    return {
      isInterState,
      taxableAmountPaise,
      gstRateBps: 0,
      cgstPaise: 0n,
      sgstPaise: 0n,
      igstPaise: 0n,
      totalTaxPaise: 0n,
      totalAmountPaise: taxableAmountPaise,
    };
  }

  if (isInterState) {
    // Inter-State Supply: IGST applies at the full rate
    const igstPaise = roundHalfUp(taxableAmountPaise * BigInt(gstRateBps), 10000n);
    return {
      isInterState: true,
      taxableAmountPaise,
      gstRateBps,
      cgstPaise: 0n,
      sgstPaise: 0n,
      igstPaise,
      totalTaxPaise: igstPaise,
      totalAmountPaise: taxableAmountPaise + igstPaise,
    };
  } else {
    // Intra-State Supply: CGST + SGST at half the rate
    const halfRateBps = BigInt(gstRateBps / 2);
    const componentPaise = roundHalfUp(taxableAmountPaise * halfRateBps, 10000n);

    // Guaranteed equal and even total sum
    const cgstPaise = componentPaise;
    const sgstPaise = componentPaise;
    const totalTaxPaise = cgstPaise + sgstPaise;

    return {
      isInterState: false,
      taxableAmountPaise,
      gstRateBps,
      cgstPaise,
      sgstPaise,
      igstPaise: 0n,
      totalTaxPaise,
      totalAmountPaise: taxableAmountPaise + totalTaxPaise,
    };
  }
}

export interface LineItemInput {
  quantity: bigint;
  unitPricePaise: bigint;
  gstRateBps: number;
  description: string;
  hsnSacCode?: string;
}

export interface LineItemResult extends GstTaxBreakdown {
  quantity: bigint;
  unitPricePaise: bigint;
  description: string;
  hsnSacCode?: string;
}

export interface InvoiceTaxSummary {
  isInterState: boolean;
  subtotalPaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalTaxPaise: bigint;
  grandTotalPaise: bigint;
  roundOffPaise: bigint;
  lineItems: LineItemResult[];
}

/**
 * Calculates tax for an entire invoice with multiple line items.
 * Supports optional invoice-level round-off to nearest rupee (100 paise) per Section 170.
 */
export function calculateInvoiceTaxes(params: {
  sellerStateCode: string;
  placeOfSupplyStateCode: string;
  lineItems: LineItemInput[];
  enableRupeeRoundOff?: boolean;
}): InvoiceTaxSummary {
  const {
    sellerStateCode,
    placeOfSupplyStateCode,
    lineItems,
    enableRupeeRoundOff = false,
  } = params;

  if (lineItems.length === 0) {
    throw new Error('Invoice must have at least one line item');
  }

  const isInterState = sellerStateCode.trim() !== placeOfSupplyStateCode.trim();

  let subtotalPaise = 0n;
  let totalCgstPaise = 0n;
  let totalSgstPaise = 0n;
  let totalIgstPaise = 0n;

  const processedLines: LineItemResult[] = [];

  for (const item of lineItems) {
    if (item.quantity <= 0n) {
      throw new Error(`Quantity must be positive for item: ${item.description}`);
    }
    if (item.unitPricePaise < 0n) {
      throw new Error(`Unit price cannot be negative for item: ${item.description}`);
    }

    const taxableAmountPaise = item.quantity * item.unitPricePaise;
    const tax = calculateGstTax({
      taxableAmountPaise,
      gstRateBps: item.gstRateBps,
      sellerStateCode,
      placeOfSupplyStateCode,
    });

    subtotalPaise += taxableAmountPaise;
    totalCgstPaise += tax.cgstPaise;
    totalSgstPaise += tax.sgstPaise;
    totalIgstPaise += tax.igstPaise;

    processedLines.push({
      ...tax,
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise,
      description: item.description,
      hsnSacCode: item.hsnSacCode,
    });
  }

  const totalTaxPaise = totalCgstPaise + totalSgstPaise + totalIgstPaise;
  const unroundedGrandTotalPaise = subtotalPaise + totalTaxPaise;

  let roundOffPaise = 0n;
  let grandTotalPaise = unroundedGrandTotalPaise;

  if (enableRupeeRoundOff) {
    // Round to nearest 100 paise (₹1.00)
    const roundedToRupee = roundHalfUp(unroundedGrandTotalPaise, 100n) * 100n;
    roundOffPaise = roundedToRupee - unroundedGrandTotalPaise;
    grandTotalPaise = roundedToRupee;
  }

  return {
    isInterState,
    subtotalPaise,
    cgstPaise: totalCgstPaise,
    sgstPaise: totalSgstPaise,
    igstPaise: totalIgstPaise,
    totalTaxPaise,
    grandTotalPaise,
    roundOffPaise,
    lineItems: processedLines,
  };
}

/**
 * Section 49 Statutory Set-off Engine.
 * Computes net cash tax liability by applying Input Tax Credit (ITC) in statutory order:
 * 1. IGST Credit set off against: Output IGST -> Output CGST -> Output SGST
 * 2. CGST Credit set off against: Output CGST -> Output IGST (Never SGST)
 * 3. SGST Credit set off against: Output SGST -> Output IGST (Never CGST)
 */
export interface GstSetOffInput {
  outputTax: {
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
  };
  availableItc: {
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
  };
}

export interface GstSetOffResult {
  outputTax: {
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    totalPaise: bigint;
  };
  utilizedItc: {
    igstAgainstIgstPaise: bigint;
    igstAgainstCgstPaise: bigint;
    igstAgainstSgstPaise: bigint;
    cgstAgainstCgstPaise: bigint;
    cgstAgainstIgstPaise: bigint;
    sgstAgainstSgstPaise: bigint;
    sgstAgainstIgstPaise: bigint;
    totalUtilizedPaise: bigint;
  };
  netPayable: {
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    totalCashPayablePaise: bigint;
  };
  closingItcBalance: {
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    totalBalancePaise: bigint;
  };
}

export function computeGstSetOff(input: GstSetOffInput): GstSetOffResult {
  let remainingOutputIgst = input.outputTax.igstPaise;
  let remainingOutputCgst = input.outputTax.cgstPaise;
  let remainingOutputSgst = input.outputTax.sgstPaise;

  let remainingItcIgst = input.availableItc.igstPaise;
  let remainingItcCgst = input.availableItc.cgstPaise;
  let remainingItcSgst = input.availableItc.sgstPaise;

  // Step 1: Utilize IGST Credit
  // 1a. Against Output IGST
  const igstAgainstIgst =
    remainingOutputIgst < remainingItcIgst ? remainingOutputIgst : remainingItcIgst;
  remainingOutputIgst -= igstAgainstIgst;
  remainingItcIgst -= igstAgainstIgst;

  // 1b. Against Output CGST
  const igstAgainstCgst =
    remainingOutputCgst < remainingItcIgst ? remainingOutputCgst : remainingItcIgst;
  remainingOutputCgst -= igstAgainstCgst;
  remainingItcIgst -= igstAgainstCgst;

  // 1c. Against Output SGST
  const igstAgainstSgst =
    remainingOutputSgst < remainingItcIgst ? remainingOutputSgst : remainingItcIgst;
  remainingOutputSgst -= igstAgainstSgst;
  remainingItcIgst -= igstAgainstSgst;

  // Step 2: Utilize CGST Credit
  // 2a. Against Output CGST
  const cgstAgainstCgst =
    remainingOutputCgst < remainingItcCgst ? remainingOutputCgst : remainingItcCgst;
  remainingOutputCgst -= cgstAgainstCgst;
  remainingItcCgst -= cgstAgainstCgst;

  // 2b. Against Output IGST
  const cgstAgainstIgst =
    remainingOutputIgst < remainingItcCgst ? remainingOutputIgst : remainingItcCgst;
  remainingOutputIgst -= cgstAgainstIgst;
  remainingItcCgst -= cgstAgainstIgst;

  // Step 3: Utilize SGST Credit
  // 3a. Against Output SGST
  const sgstAgainstSgst =
    remainingOutputSgst < remainingItcSgst ? remainingOutputSgst : remainingItcSgst;
  remainingOutputSgst -= sgstAgainstSgst;
  remainingItcSgst -= sgstAgainstSgst;

  // 3b. Against Output IGST
  const sgstAgainstIgst =
    remainingOutputIgst < remainingItcSgst ? remainingOutputIgst : remainingItcSgst;
  remainingOutputIgst -= sgstAgainstIgst;
  remainingItcSgst -= sgstAgainstIgst;

  const totalUtilized =
    igstAgainstIgst +
    igstAgainstCgst +
    igstAgainstSgst +
    cgstAgainstCgst +
    cgstAgainstIgst +
    sgstAgainstSgst +
    sgstAgainstIgst;

  const totalCashPayable = remainingOutputCgst + remainingOutputSgst + remainingOutputIgst;
  const totalClosingItc = remainingItcCgst + remainingItcSgst + remainingItcIgst;

  return {
    outputTax: {
      cgstPaise: input.outputTax.cgstPaise,
      sgstPaise: input.outputTax.sgstPaise,
      igstPaise: input.outputTax.igstPaise,
      totalPaise: input.outputTax.cgstPaise + input.outputTax.sgstPaise + input.outputTax.igstPaise,
    },
    utilizedItc: {
      igstAgainstIgstPaise: igstAgainstIgst,
      igstAgainstCgstPaise: igstAgainstCgst,
      igstAgainstSgstPaise: igstAgainstSgst,
      cgstAgainstCgstPaise: cgstAgainstCgst,
      cgstAgainstIgstPaise: cgstAgainstIgst,
      sgstAgainstSgstPaise: sgstAgainstSgst,
      sgstAgainstIgstPaise: sgstAgainstIgst,
      totalUtilizedPaise: totalUtilized,
    },
    netPayable: {
      cgstPaise: remainingOutputCgst,
      sgstPaise: remainingOutputSgst,
      igstPaise: remainingOutputIgst,
      totalCashPayablePaise: totalCashPayable,
    },
    closingItcBalance: {
      cgstPaise: remainingItcCgst,
      sgstPaise: remainingItcSgst,
      igstPaise: remainingItcIgst,
      totalBalancePaise: totalClosingItc,
    },
  };
}
