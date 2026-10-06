import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { invoices, customers } from '@kanakku/db';
import {
  calculateAgeingBucket,
  formatInr,
  type AgeingBucket,
} from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';

export const listOutstandingInvoicesSchema = {
  as_of_date: z
    .string()
    .optional()
    .describe('Reference date for ageing calculation in ISO format (defaults to current date)'),
  customer_id: z.string().uuid().optional().describe('Optional filter by customer UUID'),
};

export async function handleListOutstandingInvoices(
  args: z.infer<z.ZodObject<typeof listOutstandingInvoicesSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;

  // 1. Verify customer if filter provided
  if (args.customer_id) {
    const cust = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, args.customer_id), eq(customers.businessId, businessId)))
      .limit(1);

    if (!cust[0]) {
      throw new Error(`CUSTOMER_NOT_FOUND: Customer with ID "${args.customer_id}" not found in your business`);
    }
  }

  const asOfDate = args.as_of_date ? new Date(args.as_of_date) : new Date();

  // 2. Query open invoices joined with customers
  const queryConditions = [
    eq(invoices.businessId, businessId),
    inArray(invoices.status, ['issued', 'partially_paid']),
  ];

  if (args.customer_id) {
    queryConditions.push(eq(invoices.customerId, args.customer_id));
  }

  const openInvoices = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerId: invoices.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      totalPaise: invoices.totalPaise,
      paidAmountPaise: invoices.paidAmountPaise,
      status: invoices.status,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(...queryConditions));

  let totalOutstandingPaise = 0n;
  let overdueTotalPaise = 0n;

  const bucketTotals: Record<AgeingBucket, bigint> = {
    current: 0n,
    '1_30': 0n,
    '31_60': 0n,
    '61_90': 0n,
    '90_plus': 0n,
  };

  const invoiceItems = openInvoices.map((inv) => {
    const balancePaise = inv.totalPaise - inv.paidAmountPaise;
    totalOutstandingPaise += balancePaise;

    const { daysOverdue, bucket } = calculateAgeingBucket(inv.dueDate, asOfDate);

    bucketTotals[bucket] += balancePaise;
    if (bucket !== 'current') {
      overdueTotalPaise += balancePaise;
    }

    return {
      id: inv.id,
      invoice_number: inv.invoiceNumber,
      customer_id: inv.customerId,
      customer_name: inv.customerName,
      customer_contact: inv.customerPhone ?? inv.customerEmail ?? 'N/A',
      issue_date: inv.issueDate.toISOString().slice(0, 10),
      due_date: inv.dueDate.toISOString().slice(0, 10),
      total_paise: Number(inv.totalPaise),
      paid_paise: Number(inv.paidAmountPaise),
      balance_paise: Number(balancePaise),
      balance_formatted: formatInr(balancePaise),
      days_overdue: daysOverdue,
      ageing_bucket: bucket,
      is_overdue: bucket !== 'current',
    };
  });

  const response = {
    as_of_date: asOfDate.toISOString().slice(0, 10),
    total_outstanding_paise: Number(totalOutstandingPaise),
    total_outstanding_formatted: formatInr(totalOutstandingPaise),
    overdue_total_paise: Number(overdueTotalPaise),
    overdue_total_formatted: formatInr(overdueTotalPaise),
    ageing_buckets: {
      current_paise: Number(bucketTotals.current),
      current_formatted: formatInr(bucketTotals.current),
      '1_30_days_paise': Number(bucketTotals['1_30']),
      '1_30_days_formatted': formatInr(bucketTotals['1_30']),
      '31_60_days_paise': Number(bucketTotals['31_60']),
      '31_60_days_formatted': formatInr(bucketTotals['31_60']),
      '61_90_days_paise': Number(bucketTotals['61_90']),
      '61_90_days_formatted': formatInr(bucketTotals['61_90']),
      '90_plus_days_paise': Number(bucketTotals['90_plus']),
      '90_plus_days_formatted': formatInr(bucketTotals['90_plus']),
    },
    invoices_count: invoiceItems.length,
    invoices_list: invoiceItems,
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
