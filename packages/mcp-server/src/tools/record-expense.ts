import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { expenseCategories, pendingConfirmations } from '@kanakku/db';
import { generateConfirmationToken, formatInr, calculateGstTax } from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';
import { assertPeriodOpen } from './confirm-action.js';

export const recordExpenseSchema = {
  amount_paise: z
    .number()
    .int()
    .positive()
    .describe('Expense amount in integer paise (e.g. 240000 for ₹2,400.00)'),
  description: z.string().min(1).describe('Description of the expense item or service'),
  payment_method: z
    .enum(['upi', 'bank_transfer', 'card', 'cash'])
    .describe('Payment method used for the expense'),
  date: z
    .string()
    .optional()
    .describe('Date of the expense in ISO format (defaults to current date)'),
  vendor_name: z.string().optional().describe('Name of the vendor/merchant'),
  vendor_gstin: z.string().optional().describe('15-character Indian GSTIN of vendor if registered'),
  vendor_state_code: z
    .string()
    .regex(/^\d{2}$/, 'State code must be 2 digits')
    .optional()
    .describe(
      '2-digit Indian GST state code of vendor (e.g. "33" for TN, "29" for KA). If omitted, extracted from vendor_gstin.',
    ),
  category_id: z.string().uuid().optional().describe('Optional UUID of the expense category'),
  is_itc_claimed: z
    .boolean()
    .optional()
    .describe(
      'Whether Input Tax Credit is legally claimable under GST law (false if blocked under Section 17(5))',
    ),
};

export async function handleRecordExpense(
  args: z.infer<z.ZodObject<typeof recordExpenseSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;

  // 1. Resolve Expense Category with strict tenant scoping
  let category: {
    id: string;
    name: string;
    glAccountId: string | null;
    defaultGstRateBps: number;
    isItcEligible: boolean;
  } | null = null;

  if (args.category_id) {
    const found = await db
      .select({
        id: expenseCategories.id,
        name: expenseCategories.name,
        glAccountId: expenseCategories.glAccountId,
        defaultGstRateBps: expenseCategories.defaultGstRateBps,
        isItcEligible: expenseCategories.isItcEligible,
      })
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.id, args.category_id),
          eq(expenseCategories.businessId, businessId),
        ),
      )
      .limit(1);

    if (!found[0]) {
      throw new Error(
        `CATEGORY_NOT_FOUND: Expense category "${args.category_id}" not found in your business`,
      );
    }
    category = found[0];
  } else {
    // Auto-suggest category from description or select default category
    const categories = await db
      .select({
        id: expenseCategories.id,
        name: expenseCategories.name,
        glAccountId: expenseCategories.glAccountId,
        defaultGstRateBps: expenseCategories.defaultGstRateBps,
        isItcEligible: expenseCategories.isItcEligible,
      })
      .from(expenseCategories)
      .where(eq(expenseCategories.businessId, businessId));

    const desc = args.description.toLowerCase();
    const matched = categories.find((c) => {
      const catName = c.name.toLowerCase();
      return (
        ((desc.includes('cloud') || desc.includes('aws') || desc.includes('server')) &&
          catName.includes('cloud')) ||
        ((desc.includes('print') ||
          desc.includes('paper') ||
          desc.includes('ink') ||
          desc.includes('supplies')) &&
          catName.includes('supplies')) ||
        ((desc.includes('travel') ||
          desc.includes('cab') ||
          desc.includes('flight') ||
          desc.includes('fuel')) &&
          catName.includes('travel'))
      );
    });

    category = matched ?? categories[0] ?? null;
  }

  // 2. Deterministic Tax Breakdown with Inter-State vs Intra-State Detection
  const totalPaise = BigInt(args.amount_paise);
  const gstRateBps = category?.defaultGstRateBps ?? 0;

  let taxablePaise = totalPaise;
  let cgstPaise = 0n;
  let sgstPaise = 0n;
  let igstPaise = 0n;

  // Determine vendor state
  let vendorStateCode = tenant.business.stateCode;
  if (args.vendor_state_code) {
    vendorStateCode = args.vendor_state_code;
  } else if (
    args.vendor_gstin &&
    args.vendor_gstin.length >= 2 &&
    /^\d{2}/.test(args.vendor_gstin)
  ) {
    vendorStateCode = args.vendor_gstin.slice(0, 2);
  }

  if (gstRateBps > 0 && args.vendor_gstin) {
    // Reverse-calculate taxable base from inclusive gross total
    const rateMultiplier = BigInt(10000 + gstRateBps);
    taxablePaise = (totalPaise * 10000n) / rateMultiplier;
    const gstBreakdown = calculateGstTax({
      taxableAmountPaise: taxablePaise,
      gstRateBps,
      sellerStateCode: vendorStateCode,
      placeOfSupplyStateCode: tenant.business.stateCode,
    });
    cgstPaise = gstBreakdown.cgstPaise;
    sgstPaise = gstBreakdown.sgstPaise;
    igstPaise = gstBreakdown.igstPaise;
  }

  // Statutory ITC Eligibility: Category statutory eligibility is authoritative.
  // Section 17(5) of the CGST Act specifies blocked credits (e.g. food/beverages, personal consumption).
  // A caller may voluntarily decline eligible ITC (is_itc_claimed: false),
  // but CANNOT override or claim ITC on an ineligible category without an audited review path.
  const categoryEligible = category?.isItcEligible ?? false;
  if (!categoryEligible && args.is_itc_claimed === true) {
    throw new Error(
      `ITC_NOT_ELIGIBLE: Input Tax Credit cannot be claimed for category "${category?.name ?? 'Uncategorized'}" because it is statutory blocked under Section 17(5) of the CGST Act.`,
    );
  }

  const isItcClaimed = categoryEligible ? args.is_itc_claimed !== false : false;

  const expenseDate = args.date ? new Date(args.date) : new Date();
  await assertPeriodOpen(db, businessId, expenseDate, 'expense');

  // 3. Prepare Draft Payload
  const payload = {
    action: 'record_expense',
    business_id: businessId,
    amount_paise: args.amount_paise,
    taxable_amount_paise: Number(taxablePaise),
    cgst_paise: Number(cgstPaise),
    sgst_paise: Number(sgstPaise),
    igst_paise: Number(igstPaise),
    gst_rate_bps: gstRateBps,
    is_itc_claimed: isItcClaimed,
    is_itc_eligible: categoryEligible,
    category_id: category?.id ?? null,
    category_name: category?.name ?? 'Uncategorized',
    gl_account_id: category?.glAccountId ?? null,
    description: args.description,
    payment_method: args.payment_method,
    vendor_name: args.vendor_name ?? null,
    vendor_gstin: args.vendor_gstin ?? null,
    vendor_state_code: vendorStateCode,
    expense_date: expenseDate.toISOString(),
  };

  // 4. Generate Confirmation Token and persist pending confirmation
  const token = generateConfirmationToken(payload);
  const formattedAmount = formatInr(totalPaise);
  const humanSummary = `Draft Expense: ${formattedAmount} for "${args.description}" via ${args.payment_method}${
    args.vendor_name ? ` to ${args.vendor_name}` : ''
  }. Category: ${category?.name ?? 'Uncategorized'}. Valid for 15 minutes.`;

  const [pendingRecord] = await db
    .insert(pendingConfirmations)
    .values({
      businessId,
      userId: tenant.userId,
      tokenHash: token.tokenHash,
      actionType: 'record_expense',
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
            description: args.description,
            vendor_name: args.vendor_name ?? null,
            suggested_category: category?.name ?? 'General Expense',
            category_name: category?.name ?? 'General Expense',
            payment_method: args.payment_method,
            expense_date: expenseDate.toISOString().slice(0, 10),
            confidence: 0.95,
            confirmation_token: token.tokenSecret,
            preview_summary: humanSummary,
            ui_resource_uri: `ui://cards/expense-draft/${token.tokenSecret}`,
            amount_paise: args.amount_paise,
            amount_formatted: formatInr(BigInt(args.amount_paise)),
            gst_breakdown: {
              taxable_amount_paise: Number(taxablePaise),
              cgst_paise: Number(cgstPaise),
              sgst_paise: Number(sgstPaise),
              igst_paise: Number(igstPaise),
              is_inter_state: vendorStateCode !== tenant.business.stateCode,
            },
            is_itc_claimed: isItcClaimed,
            is_itc_eligible: categoryEligible,
            itc_block_reason: categoryEligible ? null : 'Section 17(5) blocked credit',
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
