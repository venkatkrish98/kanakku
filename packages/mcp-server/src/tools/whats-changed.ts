import { z } from 'zod';
import { eq, and, gte, lte, inArray, desc } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import {
  invoices,
  payments,
  expenses,
  businessMemory,
  expenseCategories,
  customers,
} from '@kanakku/db';
import { formatInr, type AnomalyInsight, type UnderlyingReference } from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';

export const whatsChangedSinceSchema = {
  since_timestamp: z
    .string()
    .optional()
    .describe('ISO timestamp to measure change against (e.g. "2026-09-01T00:00:00Z")'),
  reference: z
    .enum(['last_briefing', 'last_week', 'last_month'])
    .optional()
    .describe('Predefined time baseline reference'),
};

export async function handleWhatsChangedSince(
  args: z.infer<z.ZodObject<typeof whatsChangedSinceSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;

  // 1. Resolve Baseline Timestamp
  let baseline: Date;
  if (args.since_timestamp) {
    baseline = new Date(args.since_timestamp);
  } else if (args.reference === 'last_week') {
    baseline = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  } else if (args.reference === 'last_month') {
    baseline = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  } else {
    // 'last_briefing' or default: fetch the persisted briefing checkpoint for this user or business
    const userBriefingKey = tenant.userId ? `briefing:user:${tenant.userId}` : 'briefing:business';
    const checkpoints = await db
      .select({ memoryValue: businessMemory.memoryValue, updatedAt: businessMemory.updatedAt })
      .from(businessMemory)
      .where(
        and(
          eq(businessMemory.businessId, businessId),
          eq(businessMemory.category, 'briefing_checkpoint'),
          inArray(businessMemory.entityKey, [userBriefingKey, 'briefing:business']),
        ),
      )
      .orderBy(desc(businessMemory.updatedAt))
      .limit(1);

    const firstCheckpoint = checkpoints[0];
    if (firstCheckpoint && firstCheckpoint.memoryValue) {
      const ts = (firstCheckpoint.memoryValue as { timestamp?: string }).timestamp;
      baseline = ts ? new Date(ts) : firstCheckpoint.updatedAt;
    } else {
      // Deterministic fallback: 24 hours ago
      baseline = new Date(Date.now() - 24 * 60 * 60 * 1000);
    }
  }

  const now = new Date();

  // 2. Fetch Invoices Created Since Baseline
  const newInvoices = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      totalPaise: invoices.totalPaise,
      cgstPaise: invoices.cgstPaise,
      sgstPaise: invoices.sgstPaise,
      igstPaise: invoices.igstPaise,
      customerName: customers.name,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.businessId, businessId),
        inArray(invoices.status, ['issued', 'partially_paid', 'paid']),
        gte(invoices.createdAt, baseline),
      ),
    );

  let newInvoicesTotalPaise = 0n;
  let newGstOutputPaise = 0n;
  for (const inv of newInvoices) {
    newInvoicesTotalPaise += inv.totalPaise;
    newGstOutputPaise += inv.cgstPaise + inv.sgstPaise + inv.igstPaise;
  }

  // 3. Fetch Payments Received Since Baseline
  const newPayments = await db
    .select({
      id: payments.id,
      amountPaise: payments.amountPaise,
      paymentMode: payments.paymentMode,
      referenceNumber: payments.referenceNumber,
      customerName: customers.name,
      paymentDate: payments.paymentDate,
    })
    .from(payments)
    .innerJoin(customers, eq(payments.customerId, customers.id))
    .where(and(eq(payments.businessId, businessId), gte(payments.createdAt, baseline)));

  let paymentsReceivedPaise = 0n;
  for (const pay of newPayments) {
    paymentsReceivedPaise += pay.amountPaise;
  }

  // 4. Fetch New Overdue Invoices (due date between baseline and now, unpaid)
  const newOverdues = await db
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
        gte(invoices.dueDate, baseline),
        lte(invoices.dueDate, now),
        inArray(invoices.status, ['issued', 'partially_paid']),
      ),
    );

  let newOverduesPaise = 0n;
  for (const od of newOverdues) {
    newOverduesPaise += od.totalPaise - od.paidAmountPaise;
  }

  // 5. Fetch Expenses Created Since Baseline
  const newExpenses = await db
    .select({
      id: expenses.id,
      amountPaise: expenses.amountPaise,
      description: expenses.description,
      vendorName: expenses.vendorName,
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.name,
      expenseDate: expenses.expenseDate,
    })
    .from(expenses)
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(
      and(
        eq(expenses.businessId, businessId),
        eq(expenses.status, 'posted'),
        gte(expenses.createdAt, baseline),
      ),
    );

  let expenseSurgesPaise = 0n;
  for (const exp of newExpenses) {
    expenseSurgesPaise += exp.amountPaise;
  }

  // 6. Generate Structured Factual Insights with Underlying References (ADR-002)
  const insights: AnomalyInsight[] = [];

  if (paymentsReceivedPaise > 0n) {
    const refs: UnderlyingReference[] = newPayments.map((p) => ({
      entityType: 'payment',
      entityId: p.id,
      referenceNumber: p.referenceNumber ?? p.customerName,
      amountPaise: Number(p.amountPaise),
      formattedAmount: formatInr(p.amountPaise),
      date: p.paymentDate.toISOString().slice(0, 10),
      note: `Received from ${p.customerName} via ${p.paymentMode}`,
    }));
    insights.push({
      id: 'insight-payments-received',
      type: 'revenue_shift',
      severity: 'info',
      title: `Received ${formatInr(paymentsReceivedPaise)} in customer collections`,
      description: `${newPayments.length} payment(s) received totaling ${formatInr(paymentsReceivedPaise)}.`,
      direction: 'increased',
      underlyingReferences: refs,
    });
  }

  if (newOverdues.length > 0) {
    const refs: UnderlyingReference[] = newOverdues.map((od) => {
      const bal = od.totalPaise - od.paidAmountPaise;
      return {
        entityType: 'invoice',
        entityId: od.id,
        referenceNumber: od.invoiceNumber,
        amountPaise: Number(bal),
        formattedAmount: formatInr(bal),
        date: od.dueDate.toISOString().slice(0, 10),
        note: `Due for ${od.customerName}`,
      };
    });
    insights.push({
      id: 'insight-new-overdues',
      type: 'new_overdue_invoice',
      severity: 'warning',
      title: `${newOverdues.length} invoice(s) became overdue`,
      description: `Newly overdue invoices totaling ${formatInr(newOverduesPaise)} require collection action.`,
      underlyingReferences: refs,
    });
  }

  if (newExpenses.length > 0) {
    const refs: UnderlyingReference[] = newExpenses.slice(0, 5).map((e) => ({
      entityType: 'expense',
      entityId: e.id,
      referenceNumber: e.description,
      amountPaise: Number(e.amountPaise),
      formattedAmount: formatInr(e.amountPaise),
      date: e.expenseDate.toISOString().slice(0, 10),
      note: e.categoryName ? `Category: ${e.categoryName}` : undefined,
    }));
    insights.push({
      id: 'insight-new-expenses',
      type: 'expense_surge',
      severity: expenseSurgesPaise >= 500000n ? 'warning' : 'info',
      title: `Logged ${formatInr(expenseSurgesPaise)} in new expenses`,
      description: `${newExpenses.length} expense transaction(s) recorded since last baseline.`,
      direction: 'increased',
      underlyingReferences: refs,
    });
  }

  // 7. Compose Natural Spoken Voice Summary (<= 2 Sentences for Alexa+ TTS)
  let voiceSummary = '';
  if (paymentsReceivedPaise > 0n && newOverdues.length > 0) {
    voiceSummary = `Since your last checkpoint, you collected ${formatInr(paymentsReceivedPaise)}, but ${newOverdues.length} invoice(s) became overdue totaling ${formatInr(newOverduesPaise)}.`;
  } else if (paymentsReceivedPaise > 0n) {
    voiceSummary = `Since your last checkpoint, you collected ${formatInr(paymentsReceivedPaise)} across ${newPayments.length} customer payment(s).`;
  } else if (newOverdues.length > 0) {
    voiceSummary = `You have ${newOverdues.length} newly overdue invoice(s) totaling ${formatInr(newOverduesPaise)} that need attention.`;
  } else if (newInvoices.length > 0) {
    voiceSummary = `You issued ${newInvoices.length} invoice(s) totaling ${formatInr(newInvoicesTotalPaise)} since your last checkpoint.`;
  } else if (newExpenses.length > 0) {
    voiceSummary = `You recorded ${newExpenses.length} new expense(s) totaling ${formatInr(expenseSurgesPaise)} since your last checkpoint.`;
  } else {
    voiceSummary =
      'There are no new financial movements or overdue status changes since your last checkpoint.';
  }

  const response = {
    baseline_timestamp: baseline.toISOString(),
    evaluation_timestamp: now.toISOString(),
    voice_summary: voiceSummary,
    new_invoices_count: newInvoices.length,
    new_invoices_total_paise: Number(newInvoicesTotalPaise),
    new_invoices_total_formatted: formatInr(newInvoicesTotalPaise),
    payments_received_count: newPayments.length,
    payments_received_paise: Number(paymentsReceivedPaise),
    payments_received_formatted: formatInr(paymentsReceivedPaise),
    new_overdues_count: newOverdues.length,
    new_overdues_paise: Number(newOverduesPaise),
    new_overdues_formatted: formatInr(newOverduesPaise),
    expense_surges_count: newExpenses.length,
    expense_surges_paise: Number(expenseSurgesPaise),
    expense_surges_formatted: formatInr(expenseSurgesPaise),
    gst_output_delta_paise: Number(newGstOutputPaise),
    gst_output_delta_formatted: formatInr(newGstOutputPaise),
    insights,
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
