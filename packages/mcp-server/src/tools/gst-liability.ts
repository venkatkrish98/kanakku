import { z } from 'zod';
import { eq, and, gte, lt, ne } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { invoices, expenses } from '@kanakku/db';
import { computeGstSetOff, formatInr } from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';

export const getGstLiabilitySchema = {
  month: z.number().int().min(1).max(12).describe('Month number (1-12)'),
  year: z.number().int().min(2020).max(2040).describe('Fiscal calendar year (e.g. 2026)'),
};

const CA_DISCLAIMER =
  'Chartered Accountant & Tax Professional Notice: Kanakku provides automated decision-support calculations and internal bookkeeping estimates under the CGST Act, 2017. All figures, including Input Tax Credit, are managerial estimates and do not constitute statutory tax filing. Returns must be verified by a licensed CA prior to GSTN portal submission.';

export async function handleGetGstLiability(
  args: z.infer<z.ZodObject<typeof getGstLiabilitySchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;
  const { month, year } = args;

  const currentLiability = await computeMonthGst(db, businessId, month, year);

  // Compute previous month for MoM comparison
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevLiability = await computeMonthGst(db, businessId, prevMonth, prevYear);

  const momDeltaPaise = currentLiability.netPayableTotalPaise - prevLiability.netPayableTotalPaise;

  const response = {
    period: `${year}-${month.toString().padStart(2, '0')}`,
    month,
    year,
    output_tax: {
      cgst_paise: Number(currentLiability.outputCgstPaise),
      cgst_formatted: formatInr(currentLiability.outputCgstPaise),
      sgst_paise: Number(currentLiability.outputSgstPaise),
      sgst_formatted: formatInr(currentLiability.outputSgstPaise),
      igst_paise: Number(currentLiability.outputIgstPaise),
      igst_formatted: formatInr(currentLiability.outputIgstPaise),
      total_paise: Number(currentLiability.outputTotalPaise),
      total_formatted: formatInr(currentLiability.outputTotalPaise),
    },
    estimated_itc: {
      cgst_paise: Number(currentLiability.itcCgstPaise),
      cgst_formatted: formatInr(currentLiability.itcCgstPaise),
      sgst_paise: Number(currentLiability.itcSgstPaise),
      sgst_formatted: formatInr(currentLiability.itcSgstPaise),
      igst_paise: Number(currentLiability.itcIgstPaise),
      igst_formatted: formatInr(currentLiability.itcIgstPaise),
      total_paise: Number(currentLiability.itcTotalPaise),
      total_formatted: formatInr(currentLiability.itcTotalPaise),
    },
    net_payable: {
      cgst_paise: Number(currentLiability.netPayableCgstPaise),
      cgst_formatted: formatInr(currentLiability.netPayableCgstPaise),
      sgst_paise: Number(currentLiability.netPayableSgstPaise),
      sgst_formatted: formatInr(currentLiability.netPayableSgstPaise),
      igst_paise: Number(currentLiability.netPayableIgstPaise),
      igst_formatted: formatInr(currentLiability.netPayableIgstPaise),
      total_paise: Number(currentLiability.netPayableTotalPaise),
      total_formatted: formatInr(currentLiability.netPayableTotalPaise),
    },
    remaining_itc: {
      total_paise: Number(currentLiability.remainingItcTotalPaise),
      total_formatted: formatInr(currentLiability.remainingItcTotalPaise),
    },
    mom_delta: {
      net_payable_delta_paise: Number(momDeltaPaise),
      net_payable_delta_formatted: formatInr(momDeltaPaise),
      trend: momDeltaPaise > 0n ? 'increased' : momDeltaPaise < 0n ? 'decreased' : 'stable',
    },
    statutory_disclaimer: CA_DISCLAIMER,
    ui_resource_uri: 'ui://cards/gst-liability',
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

export async function computeMonthGst(
  db: KanakkuDatabase,
  businessId: string,
  month: number,
  year: number,
) {
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0));

  const monthInvoices = await db
    .select({
      cgstPaise: invoices.cgstPaise,
      sgstPaise: invoices.sgstPaise,
      igstPaise: invoices.igstPaise,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.businessId, businessId),
        gte(invoices.issueDate, startDate),
        lt(invoices.issueDate, endDate),
        ne(invoices.status, 'cancelled'),
      ),
    );

  let outputCgst = 0n;
  let outputSgst = 0n;
  let outputIgst = 0n;

  for (const inv of monthInvoices) {
    outputCgst += inv.cgstPaise;
    outputSgst += inv.sgstPaise;
    outputIgst += inv.igstPaise;
  }

  const monthExpenses = await db
    .select({
      cgstPaise: expenses.cgstPaise,
      sgstPaise: expenses.sgstPaise,
      igstPaise: expenses.igstPaise,
      isItcClaimed: expenses.isItcClaimed,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        gte(expenses.expenseDate, startDate),
        lt(expenses.expenseDate, endDate),
        ne(expenses.status, 'cancelled'),
      ),
    );

  let itcCgst = 0n;
  let itcSgst = 0n;
  let itcIgst = 0n;

  for (const exp of monthExpenses) {
    if (exp.isItcClaimed) {
      itcCgst += exp.cgstPaise;
      itcSgst += exp.sgstPaise;
      itcIgst += exp.igstPaise;
    }
  }

  const setOff = computeGstSetOff({
    outputTax: {
      cgstPaise: outputCgst,
      sgstPaise: outputSgst,
      igstPaise: outputIgst,
    },
    availableItc: {
      cgstPaise: itcCgst,
      sgstPaise: itcSgst,
      igstPaise: itcIgst,
    },
  });

  return {
    outputCgstPaise: outputCgst,
    outputSgstPaise: outputSgst,
    outputIgstPaise: outputIgst,
    outputTotalPaise: outputCgst + outputSgst + outputIgst,
    itcCgstPaise: itcCgst,
    itcSgstPaise: itcSgst,
    itcIgstPaise: itcIgst,
    itcTotalPaise: itcCgst + itcSgst + itcIgst,
    netPayableCgstPaise: setOff.netPayable.cgstPaise,
    netPayableSgstPaise: setOff.netPayable.sgstPaise,
    netPayableIgstPaise: setOff.netPayable.igstPaise,
    netPayableTotalPaise: setOff.netPayable.totalCashPayablePaise,
    remainingItcTotalPaise: setOff.closingItcBalance.totalBalancePaise,
  };
}
