import { z } from 'zod';
import { eq, and, gte, lte, lt, inArray } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import {
  invoices,
  payments,
  expenses,
  customers,
  expenseCategories,
  businessMemory,
} from '@kanakku/db';
import {
  formatInr,
  calculateAgeingBucket,
  detectOverdueAnomalies,
  detectCategorySurges,
  type AnomalyInsight,
} from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';
import { computeMonthGst } from './gst-liability.js';

export const getBusinessBriefingSchema = {
  timeframe: z
    .enum(['today', 'weekly'])
    .default('today')
    .describe('Briefing timeframe window: "today" or "weekly"'),
};

export async function handleGetBusinessBriefing(
  args: z.infer<z.ZodObject<typeof getBusinessBriefingSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;
  const now = new Date();

  const windowDays = args.timeframe === 'weekly' ? 7 : 1;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // 1. Inflows in window (strictly bounded up to current time)
  const windowPayments = await db
    .select({ amountPaise: payments.amountPaise })
    .from(payments)
    .where(
      and(
        eq(payments.businessId, businessId),
        gte(payments.paymentDate, windowStart),
        lte(payments.paymentDate, now),
      ),
    );

  let cashInflowPaise = 0n;
  for (const p of windowPayments) {
    cashInflowPaise += p.amountPaise;
  }

  // 2. Overdue Receivables
  const openInvoices = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      totalPaise: invoices.totalPaise,
      paidAmountPaise: invoices.paidAmountPaise,
      dueDate: invoices.dueDate,
      customerName: customers.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.businessId, businessId),
        inArray(invoices.status, ['issued', 'partially_paid']),
      ),
    );

  let overdueReceivablesPaise = 0n;
  let topOverdueCustomer = '';
  let topOverdueAmount = 0n;
  let overdueInvoiceCount = 0;

  for (const inv of openInvoices) {
    const balance = inv.totalPaise - inv.paidAmountPaise;
    const { bucket } = calculateAgeingBucket(inv.dueDate, now);
    if (bucket !== 'current') {
      overdueReceivablesPaise += balance;
      overdueInvoiceCount++;
      if (balance > topOverdueAmount) {
        topOverdueAmount = balance;
        topOverdueCustomer = inv.customerName;
      }
    }
  }

  // 3. Realized Outflows in window (posted expenses bounded strictly within window up to now)
  const windowExpenses = await db
    .select({
      id: expenses.id,
      amountPaise: expenses.amountPaise,
      description: expenses.description,
      categoryId: expenses.categoryId,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        eq(expenses.status, 'posted'),
        gte(expenses.expenseDate, windowStart),
        lte(expenses.expenseDate, now),
      ),
    );

  // 4. Upcoming Bills & Obligations
  // Note: Kanakku records cash/bank-settled expenses upon payment. In the absence of an accounts payable / vendor bills module
  // with explicit due dates, we do not misrepresent posted expenses or unconfirmed drafts as upcoming bills due.
  const upcomingBillsPaise = 0n;

  // 5. GST Status for Current Month (Determined in Indian Standard Time / Asia/Kolkata)
  const istFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
  });
  const istParts = istFormatter.formatToParts(now);
  const currentMonth = parseInt(istParts.find((p) => p.type === 'month')?.value ?? '1', 10);
  const currentYear = parseInt(istParts.find((p) => p.type === 'year')?.value ?? '2026', 10);
  const gstData = await computeMonthGst(db, businessId, currentMonth, currentYear);

  // 6. Deterministic Anomaly & Change Insights (ADR-002)
  const anomalies: AnomalyInsight[] = [];

  // Overdue anomalies
  const overdueAnomalies = detectOverdueAnomalies(openInvoices, now);
  anomalies.push(...overdueAnomalies.slice(0, 3));

  // Category surges in window vs prior preceding window
  const priorWindowStart = new Date(windowStart.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const priorExpenses = await db
    .select({
      amountPaise: expenses.amountPaise,
      categoryId: expenses.categoryId,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        eq(expenses.status, 'posted'),
        gte(expenses.expenseDate, priorWindowStart),
        lt(expenses.expenseDate, windowStart),
      ),
    );

  const categories = await db
    .select({ id: expenseCategories.id, name: expenseCategories.name })
    .from(expenseCategories)
    .where(eq(expenseCategories.businessId, businessId));

  const categoryData = categories.map((c) => {
    const curTotal = windowExpenses
      .filter((e) => e.categoryId === c.id)
      .reduce((sum, e) => sum + e.amountPaise, 0n);
    const prevTotal = priorExpenses
      .filter((e) => e.categoryId === c.id)
      .reduce((sum, e) => sum + e.amountPaise, 0n);
    return {
      categoryId: c.id,
      categoryName: c.name,
      currentAmountPaise: curTotal,
      previousAmountPaise: prevTotal,
    };
  });

  const categorySurges = detectCategorySurges(categoryData);
  anomalies.push(...categorySurges.slice(0, 2));

  // 6. Action Items
  const actionItems: string[] = [];
  if (topOverdueCustomer && topOverdueAmount > 0n) {
    actionItems.push(
      `Send payment reminder to ${topOverdueCustomer} for ${formatInr(topOverdueAmount)} overdue.`,
    );
  }
  if (gstData.netPayableTotalPaise > 0n) {
    actionItems.push(
      `Prepare GST payment of ${formatInr(gstData.netPayableTotalPaise)} for ${currentMonth}/${currentYear}.`,
    );
  }
  if (openInvoices.length > 0 && actionItems.length === 0) {
    actionItems.push(`Review ${openInvoices.length} open customer invoices.`);
  }

  // 7. Compose Concise Voice Summary (Strictly <= 2 Sentences for Alexa+ TTS)
  const inflowFormatted = formatInr(cashInflowPaise);
  const overdueFormatted = formatInr(overdueReceivablesPaise);
  const voiceInflow =
    cashInflowPaise % 100n === 0n ? inflowFormatted.replace(/\.00$/, '') : inflowFormatted;
  const voiceOverdue =
    overdueReceivablesPaise % 100n === 0n
      ? overdueFormatted.replace(/\.00$/, '')
      : overdueFormatted;

  let voiceSummary = '';
  if (cashInflowPaise > 0n && overdueReceivablesPaise > 0n) {
    voiceSummary = `You collected ${voiceInflow} ${args.timeframe}, and you have ${voiceOverdue} in overdue receivables across ${overdueInvoiceCount} overdue invoice${overdueInvoiceCount === 1 ? '' : 's'}. Would you like me to draft a reminder for ${topOverdueCustomer || 'your top overdue invoice'}?`;
  } else if (overdueReceivablesPaise > 0n) {
    voiceSummary = `You have ${voiceOverdue} in overdue customer receivables across ${overdueInvoiceCount} overdue invoice${overdueInvoiceCount === 1 ? '' : 's'}. Would you like me to send collection reminders now?`;
  } else if (cashInflowPaise > 0n) {
    voiceSummary = `You collected ${voiceInflow} ${args.timeframe} with zero overdue receivables. Your cash flow is in healthy standing.`;
  } else {
    voiceSummary = `Your accounts are quiet today with zero overdue receivables and no cash movements recorded in this period.`;
  }

  const response = {
    timeframe: args.timeframe,
    as_of: now.toISOString().slice(0, 10),
    voice_summary: voiceSummary,
    cash_inflow: {
      paise: Number(cashInflowPaise),
      formatted: inflowFormatted,
    },
    overdue_receivables: {
      paise: Number(overdueReceivablesPaise),
      formatted: overdueFormatted,
      overdue_invoices_count: overdueInvoiceCount,
      open_invoices_count: openInvoices.length,
    },
    upcoming_bills: {
      paise: Number(upcomingBillsPaise),
      formatted: formatInr(upcomingBillsPaise),
      count: 0,
      note: 'No vendor bills due',
    },
    gst_status: {
      month: currentMonth,
      year: currentYear,
      output_tax_formatted: formatInr(gstData.outputTotalPaise),
      estimated_itc_formatted: formatInr(gstData.itcTotalPaise),
      net_payable_paise: Number(gstData.netPayableTotalPaise),
      net_payable_formatted: formatInr(gstData.netPayableTotalPaise),
      is_payable: gstData.netPayableTotalPaise > 0n,
    },
    top_overdue_debtor: topOverdueCustomer || null,
    action_items: actionItems,
    anomalies: anomalies.map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      title: a.title,
      description: a.description,
      references_count: a.underlyingReferences.length,
    })),
    ui_resource_uri: 'ui://cards/business-briefing',
  };

  // 8. Persist Briefing Checkpoint into businessMemory for reliable "since last briefing" baseline
  try {
    const briefingKey = tenant.userId ? `briefing:user:${tenant.userId}` : 'briefing:business';
    const existingCheckpoints = await db
      .select({ id: businessMemory.id })
      .from(businessMemory)
      .where(
        and(
          eq(businessMemory.businessId, businessId),
          eq(businessMemory.category, 'briefing_checkpoint'),
          eq(businessMemory.entityKey, briefingKey),
        ),
      )
      .limit(1);

    const firstCheckpoint = existingCheckpoints[0];
    if (firstCheckpoint) {
      await db
        .update(businessMemory)
        .set({
          memoryValue: { timestamp: now.toISOString() },
          updatedAt: now,
        })
        .where(eq(businessMemory.id, firstCheckpoint.id));
    } else {
      await db.insert(businessMemory).values({
        businessId,
        category: 'briefing_checkpoint',
        entityKey: briefingKey,
        memoryValue: { timestamp: now.toISOString() },
        source: 'get_business_briefing',
        updatedAt: now,
      });
    }
  } catch {
    // Non-fatal if checkpoint persistence fails
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}
