import { z } from 'zod';
import { eq, and, sql, inArray } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { customers, invoices, pendingConfirmations, businessMemory } from '@kanakku/db';
import { generateConfirmationToken, formatInr } from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';

export const sendReminderSchema = {
  customer_id: z.string().uuid().optional().describe('UUID of the customer'),
  customer_name: z.string().optional().describe('Customer name (used if customer_id not provided)'),
  invoice_id: z.string().uuid().optional().describe('Optional specific invoice UUID'),
  tone: z
    .enum(['polite', 'firm'])
    .optional()
    .describe(
      'Tone of the collection message: "polite" or "firm" (defaults to business memory preference or "polite")',
    ),
  channel: z
    .enum(['whatsapp', 'email'])
    .optional()
    .describe(
      'Communication channel: "whatsapp" or "email" (defaults to business memory preference or "whatsapp")',
    ),
};

export async function handleSendPaymentReminder(
  args: z.infer<z.ZodObject<typeof sendReminderSchema>>,
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
    contactName: string | null;
  } | null = null;

  if (args.customer_id) {
    const found = await db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        contactName: customers.contactName,
      })
      .from(customers)
      .where(and(eq(customers.id, args.customer_id), eq(customers.businessId, businessId)))
      .limit(1);

    if (!found[0]) {
      throw new Error(
        `CUSTOMER_NOT_FOUND: Customer with ID "${args.customer_id}" not found in your business`,
      );
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
        contactName: customers.contactName,
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
      throw new Error(
        `CUSTOMER_NOT_FOUND: Customer "${args.customer_name}" not found in your business`,
      );
    }
    customer = found[0];
  } else {
    throw new Error('INVALID_INPUT: Either customer_id or customer_name must be provided');
  }

  // 2. Resolve Invoices and Amount Due
  let targetInvoiceId: string | null = null;
  let targetInvoiceNumber: string = '';
  let amountDuePaise = 0n;

  if (args.invoice_id) {
    const foundInvoice = await db
      .select({
        id: invoices.id,
        customerId: invoices.customerId,
        invoiceNumber: invoices.invoiceNumber,
        totalPaise: invoices.totalPaise,
        paidAmountPaise: invoices.paidAmountPaise,
        dueDate: invoices.dueDate,
        status: invoices.status,
      })
      .from(invoices)
      .where(and(eq(invoices.id, args.invoice_id), eq(invoices.businessId, businessId)))
      .limit(1);

    const inv = foundInvoice[0];
    if (!inv) {
      throw new Error(
        `INVOICE_NOT_FOUND: Invoice with ID "${args.invoice_id}" not found in your business`,
      );
    }
    if (inv.customerId !== customer.id) {
      throw new Error(
        'INVOICE_CUSTOMER_MISMATCH: Invoice does not belong to the specified customer',
      );
    }

    targetInvoiceId = inv.id;
    targetInvoiceNumber = inv.invoiceNumber;
    amountDuePaise = inv.totalPaise - inv.paidAmountPaise;
  } else {
    // Find all outstanding invoices for this customer
    const openInvoices = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        totalPaise: invoices.totalPaise,
        paidAmountPaise: invoices.paidAmountPaise,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.businessId, businessId),
          eq(invoices.customerId, customer.id),
          inArray(invoices.status, ['issued', 'partially_paid']),
        ),
      );

    if (openInvoices.length === 0) {
      throw new Error(
        `NO_OUTSTANDING_INVOICES: Customer "${customer.name}" has no outstanding invoices`,
      );
    }

    targetInvoiceId = openInvoices[0]!.id;
    targetInvoiceNumber = openInvoices[0]!.invoiceNumber;
    for (const inv of openInvoices) {
      amountDuePaise += inv.totalPaise - inv.paidAmountPaise;
    }
  }

  if (amountDuePaise <= 0n) {
    throw new Error('NO_AMOUNT_DUE: The specified invoice or customer has a zero balance due');
  }

  // 3. Resolve tone and channel preferences using durable cross-session business memory
  let selectedTone = args.tone;
  let selectedChannel = args.channel;

  const memoryRows = await db
    .select({
      memoryValue: businessMemory.memoryValue,
    })
    .from(businessMemory)
    .where(
      and(
        eq(businessMemory.businessId, businessId),
        eq(businessMemory.category, 'customer_preference'),
        eq(businessMemory.entityKey, `customer:${customer.id}`),
        eq(businessMemory.isActive, true),
      ),
    )
    .limit(1);

  const preference = memoryRows[0]?.memoryValue as Record<string, unknown> | undefined;
  if (!selectedTone) {
    selectedTone = (preference?.['preferred_tone'] as 'polite' | 'firm') ?? 'polite';
  }
  if (!selectedChannel) {
    selectedChannel = (preference?.['preferred_channel'] as 'whatsapp' | 'email') ?? 'whatsapp';
  }

  // 4. Compose Tone-Appropriate Message Preview
  const formattedAmount = formatInr(amountDuePaise);
  const contact =
    selectedChannel === 'whatsapp' ? (customer.phone ?? 'N/A') : (customer.email ?? 'N/A');
  const recipientName = customer.contactName ?? customer.name;

  let messagePreview = '';
  if (selectedTone === 'polite') {
    messagePreview = `Dear ${recipientName}, greetings from ${tenant.business.name}. This is a gentle reminder regarding invoice ${targetInvoiceNumber} for ${formattedAmount}. Kindly arrange payment via UPI/bank transfer at your earliest convenience. Thank you for your partnership!`;
  } else {
    messagePreview = `Dear ${recipientName}, this is an urgent reminder from ${tenant.business.name}. Invoice ${targetInvoiceNumber} for ${formattedAmount} is currently overdue. Please process this payment immediately to keep your account in good standing.`;
  }

  // 5. Prepare Draft Payload
  const payload = {
    action: 'send_payment_reminder',
    business_id: businessId,
    customer_id: customer.id,
    customer_name: customer.name,
    recipient_name: recipientName,
    recipient_contact: contact,
    invoice_id: targetInvoiceId,
    invoice_number: targetInvoiceNumber,
    amount_due_paise: Number(amountDuePaise),
    tone: selectedTone,
    channel: selectedChannel,
    message_body: messagePreview,
  };

  // 6. Generate Confirmation Token and persist pending confirmation
  const token = generateConfirmationToken(payload);
  const humanSummary = `Draft Payment Reminder: ${selectedTone} ${selectedChannel} message to ${recipientName} (${contact}) for ${formattedAmount} on invoice ${targetInvoiceNumber}. Valid for 15 minutes.`;

  const [pendingRecord] = await db
    .insert(pendingConfirmations)
    .values({
      businessId,
      userId: tenant.userId,
      tokenHash: token.tokenHash,
      actionType: 'send_payment_reminder',
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
            recipient_name: recipientName,
            contact,
            amount_due_paise: Number(amountDuePaise),
            amount_due_formatted: formattedAmount,
            channel: selectedChannel,
            tone: selectedTone,
            message_preview: messagePreview,
            confirmation_token: token.tokenSecret,
            preview_summary: humanSummary,
            expires_at: token.expiresAt.toISOString(),
            status: 'pending_confirmation',
            delivery_mode:
              'simulated (records sent_demo on confirm; live messaging integration scheduled for later phase)',
            integration_status: 'demo_simulation',
          },
          null,
          2,
        ),
      },
    ],
  };
}
