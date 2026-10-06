/**
 * Deterministic Financial Insights, Comparison & Anomaly Detection Engine (ADR-002).
 * Strictly integer paise arithmetic. Generates factual, verifiable insights
 * with explicit underlying data references for Amazon Bedrock and UI rendering.
 */

import { formatInr, roundHalfUp } from '../money/index.js';
import { calculateAgeingBucket } from '../invoice/index.js';

export type InsightDirection = 'increased' | 'decreased' | 'unchanged';
export type InsightSeverity = 'info' | 'warning' | 'critical';

export interface FinancialDelta {
  currentPaise: bigint;
  previousPaise: bigint;
  deltaPaise: bigint;
  percentageChangeBps: number | null; // e.g. 1500 = +15.00%, -2500 = -25.00%, null if previous was zero
  direction: InsightDirection;
  formattedCurrent: string;
  formattedPrevious: string;
  formattedDelta: string;
  percentageChangeFormatted: string | null;
}

export interface SerializedFinancialDelta {
  currentPaise: number;
  previousPaise: number;
  deltaPaise: number;
  currentPaiseStr: string;
  previousPaiseStr: string;
  deltaPaiseStr: string;
  percentageChangeBps: number | null;
  direction: InsightDirection;
  formattedCurrent: string;
  formattedPrevious: string;
  formattedDelta: string;
  percentageChangeFormatted: string | null;
}

export function serializeFinancialDelta(delta: FinancialDelta): SerializedFinancialDelta {
  const toSafeNum = (val: bigint): number => {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (val > maxSafe) return Number.MAX_SAFE_INTEGER;
    if (val < -maxSafe) return -Number.MAX_SAFE_INTEGER;
    return Number(val);
  };

  return {
    ...delta,
    currentPaise: toSafeNum(delta.currentPaise),
    previousPaise: toSafeNum(delta.previousPaise),
    deltaPaise: toSafeNum(delta.deltaPaise),
    currentPaiseStr: delta.currentPaise.toString(),
    previousPaiseStr: delta.previousPaise.toString(),
    deltaPaiseStr: delta.deltaPaise.toString(),
  };
}

export interface UnderlyingReference {
  entityType: 'invoice' | 'expense' | 'payment' | 'category' | 'tax_period';
  entityId?: string;
  referenceNumber?: string;
  amountPaise: number;
  formattedAmount: string;
  date?: string;
  note?: string;
}

export interface AnomalyInsight {
  id: string;
  type:
    | 'revenue_shift'
    | 'expense_shift'
    | 'expense_surge'
    | 'gst_liability_shift'
    | 'delayed_payment'
    | 'new_overdue_invoice'
    | 'cashflow_deficit';
  severity: InsightSeverity;
  title: string;
  description: string;
  direction?: InsightDirection;
  delta?: FinancialDelta;
  underlyingReferences: UnderlyingReference[];
}

/**
 * Computes deterministic delta and percentage change in basis points (1 bp = 0.01%).
 * Uses rational half-up integer rounding to avoid floating point hallucinations.
 * Retains exact integer BigInt paise arithmetic to prevent precision loss.
 */
export function computeFinancialDelta(currentPaise: bigint, previousPaise: bigint): FinancialDelta {
  const deltaPaise = currentPaise - previousPaise;
  let direction: InsightDirection = 'unchanged';
  if (deltaPaise > 0n) {
    direction = 'increased';
  } else if (deltaPaise < 0n) {
    direction = 'decreased';
  }

  let percentageChangeBps: number | null = null;
  let percentageChangeFormatted: string | null = null;

  if (previousPaise !== 0n) {
    // basis points calculation: (delta * 10,000) / previous
    const bpsBigInt = roundHalfUp(deltaPaise * 10000n, previousPaise > 0n ? previousPaise : -previousPaise);
    percentageChangeBps = Number(bpsBigInt);

    const absBps = Math.abs(percentageChangeBps);
    const wholePct = Math.floor(absBps / 100);
    const remBps = absBps % 100;
    const sign = percentageChangeBps > 0 ? '+' : percentageChangeBps < 0 ? '-' : '';
    percentageChangeFormatted = `${sign}${wholePct}${remBps > 0 ? '.' + remBps.toString().padStart(2, '0') : ''}%`;
  }

  return {
    currentPaise,
    previousPaise,
    deltaPaise,
    percentageChangeBps,
    direction,
    formattedCurrent: formatInr(currentPaise),
    formattedPrevious: formatInr(previousPaise),
    formattedDelta: formatInr(deltaPaise > 0n ? deltaPaise : -deltaPaise),
    percentageChangeFormatted,
  };
}

export interface CategoryExpenseData {
  categoryId: string;
  categoryName: string;
  currentAmountPaise: bigint;
  previousAmountPaise: bigint;
  topExpenses?: Array<{
    id: string;
    description: string;
    amountPaise: bigint;
    date?: string;
  }>;
}

/**
 * Detects category-specific expense surges.
 * Flags categories that increased by more than thresholdBps (default: 20.00% / 2000 bps)
 * with a minimum nominal increase of at least minNominalPaise (default: ₹500 / 50,000 paise).
 */
export function detectCategorySurges(
  categories: CategoryExpenseData[],
  options?: { thresholdBps?: number; minNominalPaise?: bigint },
): AnomalyInsight[] {
  const thresholdBps = options?.thresholdBps ?? 2000; // 20%
  const minNominalPaise = options?.minNominalPaise ?? 50000n; // ₹500 min surge (50,000 paise)

  const insights: AnomalyInsight[] = [];

  for (const cat of categories) {
    const delta = computeFinancialDelta(cat.currentAmountPaise, cat.previousAmountPaise);

    // Check if category surged significantly
    const isNominalSurge = delta.deltaPaise >= minNominalPaise;
    const isPercentageSurge =
      delta.percentageChangeBps !== null && delta.percentageChangeBps >= thresholdBps;
    const isNewSurge = cat.previousAmountPaise === 0n && isNominalSurge;

    if ((isPercentageSurge && isNominalSurge) || isNewSurge) {
      const pctText = delta.percentageChangeFormatted ? ` (${delta.percentageChangeFormatted})` : '';
      const refs: UnderlyingReference[] = [
        {
          entityType: 'category',
          entityId: cat.categoryId,
          referenceNumber: cat.categoryName,
          amountPaise: Number(cat.currentAmountPaise),
          formattedAmount: formatInr(cat.currentAmountPaise),
          note: `Previous period: ${formatInr(cat.previousAmountPaise)}`,
        },
      ];

      if (cat.topExpenses) {
        for (const exp of cat.topExpenses.slice(0, 3)) {
          refs.push({
            entityType: 'expense',
            entityId: exp.id,
            referenceNumber: exp.description,
            amountPaise: Number(exp.amountPaise),
            formattedAmount: formatInr(exp.amountPaise),
            date: exp.date,
          });
        }
      }

      insights.push({
        id: `surge-${cat.categoryId}`,
        type: 'expense_surge',
        severity: delta.deltaPaise >= 500000 ? 'warning' : 'info',
        title: `${cat.categoryName} expense surge${pctText}`,
        description: `${cat.categoryName} expenses increased by ${delta.formattedDelta} to ${delta.formattedCurrent}${pctText}.`,
        direction: 'increased',
        delta,
        underlyingReferences: refs,
      });
    }
  }

  return insights;
}

export interface OverdueInvoiceData {
  id: string;
  invoiceNumber: string;
  customerName: string;
  totalPaise: bigint;
  paidAmountPaise: bigint;
  dueDate: Date;
}

/**
 * Detects overdue receivables anomalies and customer payment delays.
 */
export function detectOverdueAnomalies(
  openInvoices: OverdueInvoiceData[],
  asOfDate: Date = new Date(),
): AnomalyInsight[] {
  const insights: AnomalyInsight[] = [];

  for (const inv of openInvoices) {
    const balance = inv.totalPaise - inv.paidAmountPaise;
    if (balance <= 0n) continue;

    const { daysOverdue, bucket } = calculateAgeingBucket(inv.dueDate, asOfDate);

    if (bucket !== 'current') {
      const severity: InsightSeverity =
        daysOverdue > 60 || balance >= 10000000n
          ? 'critical'
          : daysOverdue > 30 || balance >= 2500000n
            ? 'warning'
            : 'info';

      insights.push({
        id: `overdue-${inv.id}`,
        type: 'new_overdue_invoice',
        severity,
        title: `Overdue invoice ${inv.invoiceNumber} (${daysOverdue} days)`,
        description: `Invoice ${inv.invoiceNumber} for ${inv.customerName} is ${daysOverdue} days overdue with an outstanding balance of ${formatInr(balance)}.`,
        underlyingReferences: [
          {
            entityType: 'invoice',
            entityId: inv.id,
            referenceNumber: inv.invoiceNumber,
            amountPaise: Number(balance),
            formattedAmount: formatInr(balance),
            date: inv.dueDate.toISOString().slice(0, 10),
            note: `${inv.customerName}, due date was ${inv.dueDate.toISOString().slice(0, 10)}`,
          },
        ],
      });
    }
  }

  // Sort critical first, then largest balance
  return insights.sort((a, b) => {
    const sevRank = { critical: 3, warning: 2, info: 1 };
    const diff = sevRank[b.severity] - sevRank[a.severity];
    if (diff !== 0) return diff;
    const aAmt = a.underlyingReferences[0]?.amountPaise ?? 0;
    const bAmt = b.underlyingReferences[0]?.amountPaise ?? 0;
    return bAmt - aAmt;
  });
}

/**
 * Evaluates month-over-month or period-over-period macro shifts.
 */
export function evaluateFinancialMacroInsights(input: {
  currentRevenuePaise: bigint;
  previousRevenuePaise: bigint;
  currentExpensesPaise: bigint;
  previousExpensesPaise: bigint;
  currentGstPayablePaise: bigint;
  previousGstPayablePaise: bigint;
}): AnomalyInsight[] {
  const insights: AnomalyInsight[] = [];

  // 1. Revenue Shift
  const revDelta = computeFinancialDelta(input.currentRevenuePaise, input.previousRevenuePaise);
  if (revDelta.deltaPaise !== 0n) {
    const pct = revDelta.percentageChangeFormatted ? ` (${revDelta.percentageChangeFormatted})` : '';
    insights.push({
      id: 'macro-revenue-shift',
      type: 'revenue_shift',
      severity: revDelta.direction === 'decreased' && revDelta.percentageChangeBps && revDelta.percentageChangeBps <= -1500 ? 'warning' : 'info',
      title: `Billed revenue ${revDelta.direction}${pct}`,
      description: `Revenue ${revDelta.direction} by ${revDelta.formattedDelta} from ${revDelta.formattedPrevious} to ${revDelta.formattedCurrent}${pct}.`,
      direction: revDelta.direction,
      delta: revDelta,
      underlyingReferences: [
        {
          entityType: 'tax_period',
          amountPaise: Number(input.currentRevenuePaise),
          formattedAmount: revDelta.formattedCurrent,
          note: `Previous period revenue: ${revDelta.formattedPrevious}`,
        },
      ],
    });
  }

  // 2. Expense Shift
  const expDelta = computeFinancialDelta(input.currentExpensesPaise, input.previousExpensesPaise);
  if (expDelta.deltaPaise !== 0n) {
    const pct = expDelta.percentageChangeFormatted ? ` (${expDelta.percentageChangeFormatted})` : '';
    insights.push({
      id: 'macro-expense-shift',
      type: 'expense_shift',
      severity: expDelta.direction === 'increased' && expDelta.percentageChangeBps && expDelta.percentageChangeBps >= 2000 ? 'warning' : 'info',
      title: `Total expenses ${expDelta.direction}${pct}`,
      description: `Expenses ${expDelta.direction} by ${expDelta.formattedDelta} from ${expDelta.formattedPrevious} to ${expDelta.formattedCurrent}${pct}.`,
      direction: expDelta.direction,
      delta: expDelta,
      underlyingReferences: [
        {
          entityType: 'tax_period',
          amountPaise: Number(input.currentExpensesPaise),
          formattedAmount: expDelta.formattedCurrent,
          note: `Previous period expenses: ${expDelta.formattedPrevious}`,
        },
      ],
    });
  }

  // 3. GST Liability Shift
  const gstDelta = computeFinancialDelta(input.currentGstPayablePaise, input.previousGstPayablePaise);
  if (gstDelta.deltaPaise !== 0n) {
    const pct = gstDelta.percentageChangeFormatted ? ` (${gstDelta.percentageChangeFormatted})` : '';
    insights.push({
      id: 'macro-gst-shift',
      type: 'gst_liability_shift',
      severity: gstDelta.direction === 'increased' ? 'info' : 'info',
      title: `Net GST payable ${gstDelta.direction}${pct}`,
      description: `Net GST liability ${gstDelta.direction} by ${gstDelta.formattedDelta} to ${gstDelta.formattedCurrent}${pct}.`,
      direction: gstDelta.direction,
      delta: gstDelta,
      underlyingReferences: [
        {
          entityType: 'tax_period',
          amountPaise: Number(input.currentGstPayablePaise),
          formattedAmount: gstDelta.formattedCurrent,
          note: `Previous period net GST: ${gstDelta.formattedPrevious}`,
        },
      ],
    });
  }

  return insights;
}
