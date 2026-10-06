import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { customers, pendingConfirmations } from '@kanakku/db';
import {
  generateConfirmationToken,
  formatInr,
  calculateInvoiceTaxes,
  getFinancialYear,
} from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';
import { assertPeriodOpen } from './confirm-action.js';

export const createInvoiceSchema = {
  customer_id: z.string().uuid().optional().describe('UUID of the customer'),
  customer_name: z
    .string()
    .optional()
    .describe('Customer name (used if customer_id is not provided)'),
  line_items: z
    .array(
      z.object({
        description: z.string().min(1).describe('Line item description'),
        quantity: z.number().int().positive().default(1).describe('Quantity'),
        unit_price_paise: z
          .number()
          .int()
          .nonnegative()
          .describe('Unit price in integer paise'),
        gst_rate_bps: z
          .number()
          .int()
          .default(1800)
          .describe('GST rate in basis points (e.g. 1800 for 18%)'),
        hsn_sac_code: z.string().optional().describe('HSN or SAC code'),
      }),
    )
    .min(1)
    .describe('Invoice line items'),
  place_of_supply_state_code: z
    .string()
    .length(2)
    .describe('2-digit Indian State Code for place of supply (e.g. "33" for Tamil Nadu)'),
  due_date: z.string().describe('Payment due date in ISO format'),
  issue_date: z
    .string()
    .optional()
    .describe('Invoice issue date in ISO format (defaults to current date)'),
};

export async function handleCreateInvoice(
  args: z.infer<z.ZodObject<typeof createInvoiceSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;

  // 1. Resolve Customer with strict tenant scoping
  let customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    gstin: string | null;
    stateCode: string;
  } | null = null;

  if (args.customer_id) {
    const found = await db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        gstin: customers.gstin,
        stateCode: customers.stateCode,
      })
      .from(customers)
      .where(and(eq(customers.id, args.customer_id), eq(customers.businessId, businessId)))
      .limit(1);

    if (!found[0]) {
      throw new Error(`CUSTOMER_NOT_FOUND: Customer with ID "${args.customer_id}" not found in your business`);
    }
    customer = found[0];
  } else if (args.customer_name) {
    const searchName = args.customer_name.trim();
    const found = await db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        gstin: customers.gstin,
        stateCode: customers.stateCode,
      })
      .from(customers)
      .where(
        and(
          eq(customers.businessId, businessId),
          sql`LOWER(${customers.name}) = LOWER(${searchName})`,
        ),
      )
      .limit(1);

    if (!found[0]) {
      throw new Error(`CUSTOMER_NOT_FOUND: Customer "${args.customer_name}" not found in your business`);
    }
    customer = found[0];
  } else {
    throw new Error('INVALID_INPUT: Either customer_id or customer_name must be provided');
  }

  // 2. Compute Deterministic Invoice Totals and Tax Breakdown
  const issueDate = args.issue_date ? new Date(args.issue_date) : new Date();
  await assertPeriodOpen(db, businessId, issueDate, 'invoice');
  const dueDate = new Date(args.due_date);
  const financialYear = getFinancialYear(issueDate);

  const taxSummary = calculateInvoiceTaxes({
    sellerStateCode: tenant.business.stateCode,
    placeOfSupplyStateCode: args.place_of_supply_state_code,
    lineItems: args.line_items.map((item) => ({
      description: item.description,
      quantity: BigInt(item.quantity),
      unitPricePaise: BigInt(item.unit_price_paise),
      gstRateBps: item.gst_rate_bps,
      hsnSacCode: item.hsn_sac_code,
    })),
    enableRupeeRoundOff: false,
  });

  const processedItems = taxSummary.lineItems.map((item) => ({
    description: item.description,
    hsn_sac_code: item.hsnSacCode ?? null,
    quantity: Number(item.quantity),
    unit_price_paise: Number(item.unitPricePaise),
    taxable_amount_paise: Number(item.taxableAmountPaise),
    gst_rate_bps: item.gstRateBps,
    cgst_paise: Number(item.cgstPaise),
    sgst_paise: Number(item.sgstPaise),
    igst_paise: Number(item.igstPaise),
    total_paise: Number(item.totalAmountPaise),
  }));

  // 3. Prepare Draft Payload
  const payload = {
    action: 'create_invoice',
    business_id: businessId,
    customer_id: customer.id,
    customer_name: customer.name,
    financial_year: financialYear,
    issue_date: issueDate.toISOString(),
    due_date: dueDate.toISOString(),
    place_of_supply_state_code: args.place_of_supply_state_code,
    is_inter_state: taxSummary.isInterState,
    subtotal_paise: Number(taxSummary.subtotalPaise),
    cgst_paise: Number(taxSummary.cgstPaise),
    sgst_paise: Number(taxSummary.sgstPaise),
    igst_paise: Number(taxSummary.igstPaise),
    round_off_paise: Number(taxSummary.roundOffPaise),
    total_paise: Number(taxSummary.grandTotalPaise),
    line_items: processedItems,
  };

  // 4. Generate Confirmation Token and persist pending confirmation
  const token = generateConfirmationToken(payload);
  const formattedTotal = formatInr(taxSummary.grandTotalPaise);
  const humanSummary = `Draft Invoice: ${formattedTotal} for ${customer.name} (${processedItems.length} item${
    processedItems.length > 1 ? 's' : ''
  }). Due ${dueDate.toISOString().slice(0, 10)}. Valid for 15 minutes.`;

  const [pendingRecord] = await db
    .insert(pendingConfirmations)
    .values({
      businessId,
      userId: tenant.userId,
      tokenHash: token.tokenHash,
      actionType: 'create_invoice',
      payload,
      payloadHash: token.payloadHash,
      humanSummary,
      expiresAt: token.expiresAt,
    })
    .returning();

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            draft_id: pendingRecord?.id,
            invoice_number: 'INV-DRAFT',
            customer_name: customer.name,
            issue_date: issueDate.toISOString().slice(0, 10),
            due_date: dueDate.toISOString().slice(0, 10),
            place_of_supply: args.place_of_supply_state_code ?? tenant.business.stateCode,
            subtotal_paise: Number(taxSummary.subtotalPaise),
            gst_breakdown: {
              cgst_paise: Number(taxSummary.cgstPaise),
              sgst_paise: Number(taxSummary.sgstPaise),
              igst_paise: Number(taxSummary.igstPaise),
            },
            line_items: processedItems,
            total_paise: Number(taxSummary.grandTotalPaise),
            total_formatted: formattedTotal,
            confirmation_token: token.tokenSecret,
            preview_summary: humanSummary,
            ui_resource_uri: `ui://cards/invoice-draft/${token.tokenSecret}`,
            expires_at: token.expiresAt.toISOString(),
            status: 'pending_confirmation',
          },
          null,
          2,
        ),
      },
    ],
  };
}
