import { z } from 'zod';
import { eq, and, gte, lte, lt, desc } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { payments, expenses, customers } from '@kanakku/db';
import {
  formatInr,
  computeFinancialDelta,
  serializeFinancialDelta,
  type SerializedFinancialDelta,
} from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';

export const cashflowSummarySchema = {
  from_date: z.string().describe('Start date for cashflow summary in ISO format'),
  to_date: z.string().describe('End date for cashflow summary in ISO format'),
  comparison_period: z
    .boolean()
    .optional()
    .describe('Whether to calculate comparison metrics against preceding period'),
};

export async function handleCashflowSummary(
  args: z.infer<z.ZodObject<typeof cashflowSummarySchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;

  const fromDate = new Date(args.from_date);
  const toDate = new Date(args.to_date);

  // 1. Fetch Realized Inflows for Current Period (Payments received)
  const receivedPayments = await db
    .select({
      id: payments.id,
      amountPaise: payments.amountPaise,
      paymentDate: payments.paymentDate,
      paymentMode: payments.paymentMode,
      referenceNumber: payments.referenceNumber,
      customerName: customers.name,
    })
    .from(payments)
    .innerJoin(customers, eq(payments.customerId, customers.id))
    .where(
      and(
        eq(payments.businessId, businessId),
        gte(payments.paymentDate, fromDate),
        lte(payments.paymentDate, toDate),
      ),
    )
    .orderBy(desc(payments.amountPaise));

  let totalInflowPaise = 0n;
  for (const pay of receivedPayments) {
    totalInflowPaise += pay.amountPaise;
  }

  // 2. Fetch Realized Outflows for Current Period (Posted Expenses)
  const postedExpenses = await db
    .select({
      id: expenses.id,
      amountPaise: expenses.amountPaise,
      expenseDate: expenses.expenseDate,
      description: expenses.description,
      vendorName: expenses.vendorName,
      paymentMethod: expenses.paymentMethod,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        eq(expenses.status, 'posted'),
        gte(expenses.expenseDate, fromDate),
        lte(expenses.expenseDate, toDate),
      ),
    )
    .orderBy(desc(expenses.amountPaise));

  let totalOutflowPaise = 0n;
  for (const exp of postedExpenses) {
    totalOutflowPaise += exp.amountPaise;
  }

  const netCashflowPaise = totalInflowPaise - totalOutflowPaise;

  // 3. Extract Major Movements
  const majorMovements = [
    ...receivedPayments.slice(0, 5).map((p) => ({
      type: 'inflow' as const,
      amount_paise: Number(p.amountPaise),
      amount_formatted: formatInr(p.amountPaise),
      date: p.paymentDate.toISOString().slice(0, 10),
      party: p.customerName,
      channel: p.paymentMode,
      reference: p.referenceNumber ?? 'N/A',
    })),
    ...postedExpenses.slice(0, 5).map((e) => ({
      type: 'outflow' as const,
      amount_paise: Number(e.amountPaise),
      amount_formatted: formatInr(e.amountPaise),
      date: e.expenseDate.toISOString().slice(0, 10),
      party: e.vendorName ?? e.description,
      channel: e.paymentMethod,
      reference: e.description,
    })),
  ].sort((a, b) => b.amount_paise - a.amount_paise);

  // 4. Preceding Comparison Period (Deterministic ADR-002 calculation)
  let comparisonData: {
    preceding_period: { from: string; to: string };
    previous_inflow: { paise: number; formatted: string };
    previous_outflow: { paise: number; formatted: string };
    previous_net_cashflow: { paise: number; formatted: string };
    inflow_delta: SerializedFinancialDelta;
    outflow_delta: SerializedFinancialDelta;
    net_cashflow_delta: SerializedFinancialDelta;
    comparison_summary: string;
  } | null = null;

  if (args.comparison_period) {
    const durationMs = toDate.getTime() - fromDate.getTime();
    const prevToDate = new Date(fromDate.getTime());
    const prevFromDate = new Date(fromDate.getTime() - durationMs);

    // Query Preceding Inflows
    const prevPayments = await db
      .select({ amountPaise: payments.amountPaise })
      .from(payments)
      .where(
        and(
          eq(payments.businessId, businessId),
          gte(payments.paymentDate, prevFromDate),
          lt(payments.paymentDate, prevToDate),
        ),
      );

    let prevInflowPaise = 0n;
    for (const p of prevPayments) {
      prevInflowPaise += p.amountPaise;
    }

    // Query Preceding Outflows
    const prevExpenses = await db
      .select({ amountPaise: expenses.amountPaise })
      .from(expenses)
      .where(
        and(
          eq(expenses.businessId, businessId),
          eq(expenses.status, 'posted'),
          gte(expenses.expenseDate, prevFromDate),
          lt(expenses.expenseDate, prevToDate),
        ),
      );

    let prevOutflowPaise = 0n;
    for (const e of prevExpenses) {
      prevOutflowPaise += e.amountPaise;
    }

    const prevNetCashflowPaise = prevInflowPaise - prevOutflowPaise;

    const inflowDelta = computeFinancialDelta(totalInflowPaise, prevInflowPaise);
    const outflowDelta = computeFinancialDelta(totalOutflowPaise, prevOutflowPaise);
    const netCashflowDelta = computeFinancialDelta(netCashflowPaise, prevNetCashflowPaise);

    const netDirection = netCashflowDelta.direction;
    const netPct = netCashflowDelta.percentageChangeFormatted
      ? ` (${netCashflowDelta.percentageChangeFormatted})`
      : '';
    const comparisonSummary = `Net cashflow ${netDirection} by ${netCashflowDelta.formattedDelta} compared to preceding period${netPct}. Inflows were ${inflowDelta.formattedCurrent} vs ${inflowDelta.formattedPrevious}.`;

    comparisonData = {
      preceding_period: {
        from: prevFromDate.toISOString().slice(0, 10),
        to: prevToDate.toISOString().slice(0, 10),
      },
      previous_inflow: {
        paise: Number(prevInflowPaise),
        formatted: formatInr(prevInflowPaise),
      },
      previous_outflow: {
        paise: Number(prevOutflowPaise),
        formatted: formatInr(prevOutflowPaise),
      },
      previous_net_cashflow: {
        paise: Number(prevNetCashflowPaise),
        formatted: formatInr(prevNetCashflowPaise),
      },
      inflow_delta: serializeFinancialDelta(inflowDelta),
      outflow_delta: serializeFinancialDelta(outflowDelta),
      net_cashflow_delta: serializeFinancialDelta(netCashflowDelta),
      comparison_summary: comparisonSummary,
    };
  }

  const response = {
    period: {
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
    },
    inflow_paise: Number(totalInflowPaise),
    inflow_formatted: formatInr(totalInflowPaise),
    outflow_paise: Number(totalOutflowPaise),
    outflow_formatted: formatInr(totalOutflowPaise),
    net_cashflow_paise: Number(netCashflowPaise),
    net_cashflow_formatted: formatInr(netCashflowPaise),
    is_positive: netCashflowPaise >= 0n,
    inflows_count: receivedPayments.length,
    outflows_count: postedExpenses.length,
    major_movements: majorMovements,
    comparison: comparisonData,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}
