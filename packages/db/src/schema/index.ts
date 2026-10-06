import {
  pgTable,
  text,
  timestamp,
  bigint,
  integer,
  boolean,
  jsonb,
  uuid,
  numeric,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// -------------------------------------------------------------
// 1. Multi-Tenant Business Profile & Users
// -------------------------------------------------------------
export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  legalName: text('legal_name').notNull(),
  gstin: text('gstin').notNull().unique(),
  stateCode: text('state_code').notNull(), // e.g. "33" for Tamil Nadu
  pan: text('pan').notNull(),
  currency: text('currency').notNull().default('INR'),
  financialYearStartMonth: integer('financial_year_start_month').notNull().default(4), // April
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: text('role').notNull().default('owner'), // 'owner' | 'accountant'
    apiKeyHash: text('api_key_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_users_biz_id').on(table.businessId, table.id)],
);

// -------------------------------------------------------------
// 2. Customers & Addresses (Tenant Scoped)
// -------------------------------------------------------------
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    email: text('email'),
    phone: text('phone'),
    gstin: text('gstin'),
    stateCode: text('state_code').notNull(), // 2 digits
    isComposition: boolean('is_composition').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Composite unique constraint enabling tenant-scoped foreign keys
    unique('uq_customers_biz_id').on(table.businessId, table.id),
  ],
);

export const customerAddresses = pgTable('customer_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  line1: text('line1').notNull(),
  line2: text('line2'),
  city: text('city').notNull(),
  state: text('state').notNull(),
  stateCode: text('state_code').notNull(),
  pincode: text('pincode').notNull(),
  isBillingDefault: boolean('is_billing_default').notNull().default(true),
  isShippingDefault: boolean('is_shipping_default').notNull().default(true),
});

// -------------------------------------------------------------
// 3. Chart of Accounts & Expense Categories
// -------------------------------------------------------------
export const chartOfAccounts = pgTable(
  'chart_of_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    code: text('code').notNull(), // e.g. "1110", "4100"
    name: text('name').notNull(),
    type: text('type').notNull(), // 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_coa_biz_id').on(table.businessId, table.id)],
);

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    glAccountId: uuid('gl_account_id'),
    defaultGstRateBps: integer('default_gst_rate_bps').notNull().default(1800), // 18%
    isItcEligible: boolean('is_itc_eligible').notNull().default(true),
  },
  (table) => [
    unique('uq_expense_categories_biz_id').on(table.businessId, table.id),
    foreignKey({
      columns: [table.businessId, table.glAccountId],
      foreignColumns: [chartOfAccounts.businessId, chartOfAccounts.id],
    }),
  ],
);

// -------------------------------------------------------------
// 4. Expenses (All money in integer paise, with round-off support)
// -------------------------------------------------------------
export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id'),
    amountPaise: bigint('amount_paise', { mode: 'bigint' }).notNull(),
    taxableAmountPaise: bigint('taxable_amount_paise', { mode: 'bigint' }).notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    sgstPaise: bigint('sgst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    igstPaise: bigint('igst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    roundOffPaise: bigint('round_off_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    isItcClaimed: boolean('is_itc_claimed').notNull().default(false),
    paymentMethod: text('payment_method').notNull(), // 'upi' | 'bank_transfer' | 'card' | 'cash'
    expenseDate: timestamp('expense_date', { withTimezone: true }).notNull(),
    vendorName: text('vendor_name'),
    vendorGstin: text('vendor_gstin'),
    description: text('description').notNull(),
    receiptUrl: text('receipt_url'),
    status: text('status').notNull().default('posted'), // 'draft' | 'posted' | 'cancelled'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_expenses_biz_id').on(table.businessId, table.id),
    // Enforce tenant isolation between expenses and expense_categories; restrict deletion to preserve audit history
    foreignKey({
      columns: [table.businessId, table.categoryId],
      foreignColumns: [expenseCategories.businessId, expenseCategories.id],
    }).onDelete('restrict'),
  ],
);

// -------------------------------------------------------------
// 5. Invoices & Line Items (Strict Tenant Scoping)
// -------------------------------------------------------------
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    invoiceNumber: text('invoice_number').notNull(), // e.g. "KAN/2026-27/0042"
    financialYear: text('financial_year').notNull(), // e.g. "2026-27"
    issueDate: timestamp('issue_date', { withTimezone: true }).notNull(),
    dueDate: timestamp('due_date', { withTimezone: true }).notNull(),
    placeOfSupplyStateCode: text('place_of_supply_state_code').notNull(),
    isInterState: boolean('is_inter_state').notNull(),
    subtotalPaise: bigint('subtotal_paise', { mode: 'bigint' }).notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    sgstPaise: bigint('sgst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    igstPaise: bigint('igst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalPaise: bigint('total_paise', { mode: 'bigint' }).notNull(),
    paidAmountPaise: bigint('paid_amount_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    roundOffPaise: bigint('round_off_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    status: text('status').notNull().default('issued'), // 'draft' | 'issued' | 'partially_paid' | 'paid' | 'cancelled'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_invoices_biz_id').on(table.businessId, table.id),
    // Enforce tenant isolation: an invoice cannot reference a customer belonging to another business!
    foreignKey({
      columns: [table.businessId, table.customerId],
      foreignColumns: [customers.businessId, customers.id],
    }),
  ],
);

export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').notNull(),
    description: text('description').notNull(),
    hsnSacCode: text('hsn_sac_code'),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    unitPricePaise: bigint('unit_price_paise', { mode: 'bigint' }).notNull(),
    taxableAmountPaise: bigint('taxable_amount_paise', { mode: 'bigint' }).notNull(),
    gstRateBps: integer('gst_rate_bps').notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    sgstPaise: bigint('sgst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    igstPaise: bigint('igst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalPaise: bigint('total_paise', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    unique('uq_invoice_items_biz_id').on(table.businessId, table.id),
    foreignKey({
      columns: [table.businessId, table.invoiceId],
      foreignColumns: [invoices.businessId, invoices.id],
    }).onDelete('cascade'),
  ],
);

// -------------------------------------------------------------
// 6. Payments & Credit Notes (Tenant Scoped)
// -------------------------------------------------------------
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id'),
    customerId: uuid('customer_id').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'bigint' }).notNull(),
    paymentDate: timestamp('payment_date', { withTimezone: true }).notNull(),
    paymentMode: text('payment_mode').notNull(), // 'upi' | 'neft' | 'rtgs' | 'cheque'
    referenceNumber: text('reference_number'),
    status: text('status').notNull().default('recorded'), // 'recorded' | 'reconciled'
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_payments_biz_id').on(table.businessId, table.id),
    foreignKey({
      columns: [table.businessId, table.customerId],
      foreignColumns: [customers.businessId, customers.id],
    }),
    foreignKey({
      columns: [table.businessId, table.invoiceId],
      foreignColumns: [invoices.businessId, invoices.id],
    }),
  ],
);

export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    originalInvoiceId: uuid('original_invoice_id').notNull(),
    creditNoteNumber: text('credit_note_number').notNull(),
    reason: text('reason').notNull(),
    taxableAmountPaise: bigint('taxable_amount_paise', { mode: 'bigint' }).notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    sgstPaise: bigint('sgst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    igstPaise: bigint('igst_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalPaise: bigint('total_paise', { mode: 'bigint' }).notNull(),
    status: text('status').notNull().default('issued'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_credit_notes_biz_id').on(table.businessId, table.id),
    foreignKey({
      columns: [table.businessId, table.originalInvoiceId],
      foreignColumns: [invoices.businessId, invoices.id],
    }),
  ],
);

// -------------------------------------------------------------
// 7. Double-Entry General Ledger (Journals & Lines)
// -------------------------------------------------------------
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    entryNumber: text('entry_number').notNull(),
    entryDate: timestamp('entry_date', { withTimezone: true }).notNull(),
    sourceEntityType: text('source_entity_type').notNull(), // 'invoice' | 'expense' | 'payment' | 'credit_note'
    sourceEntityId: uuid('source_entity_id').notNull(),
    narration: text('narration').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_journal_entries_biz_id').on(table.businessId, table.id)],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    journalEntryId: uuid('journal_entry_id').notNull(),
    accountId: uuid('account_id').notNull(),
    debitPaise: bigint('debit_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditPaise: bigint('credit_paise', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    unique('uq_journal_lines_biz_id').on(table.businessId, table.id),
    foreignKey({
      columns: [table.businessId, table.journalEntryId],
      foreignColumns: [journalEntries.businessId, journalEntries.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.businessId, table.accountId],
      foreignColumns: [chartOfAccounts.businessId, chartOfAccounts.id],
    }),
  ],
);

// -------------------------------------------------------------
// 8. Payment Reminders (Tenant Scoped)
// -------------------------------------------------------------
export const paymentReminders = pgTable(
  'payment_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    channel: text('channel').notNull(), // 'whatsapp' | 'email'
    tone: text('tone').notNull(), // 'polite' | 'firm'
    recipientContact: text('recipient_contact').notNull(),
    messageBody: text('message_body').notNull(),
    status: text('status').notNull().default('draft'), // 'draft' | 'scheduled' | 'sent_demo' | 'failed'
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_payment_reminders_biz_id').on(table.businessId, table.id),
    foreignKey({
      columns: [table.businessId, table.customerId],
      foreignColumns: [customers.businessId, customers.id],
    }),
    foreignKey({
      columns: [table.businessId, table.invoiceId],
      foreignColumns: [invoices.businessId, invoices.id],
    }),
  ],
);

// -------------------------------------------------------------
// 9. Session Context & Durable Business Memory
// -------------------------------------------------------------
export const conversationSessions = pgTable('conversation_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  sessionKey: text('session_key').notNull().unique(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessionContext = pgTable('session_context', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => conversationSessions.id, { onDelete: 'cascade' }),
  lastCustomerId: uuid('last_customer_id').references(() => customers.id),
  lastInvoiceId: uuid('last_invoice_id').references(() => invoices.id),
  lastConfirmationTokenHash: text('last_confirmation_token_hash'),
  activeWorkflowName: text('active_workflow_name'),
  activeWorkflowState: jsonb('active_workflow_state'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const businessMemory = pgTable('business_memory', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  category: text('category').notNull(), // 'customer_preference' | 'categorization_override' | 'operational_policy'
  entityKey: text('entity_key').notNull(), // e.g. "customer:ravi-traders"
  memoryValue: jsonb('memory_value').notNull(),
  confidence: numeric('confidence').notNull().default('1.0'),
  source: text('source').notNull().default('confirmed_action'),
  isActive: boolean('is_active').notNull().default(true),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// -------------------------------------------------------------
// 10. Universal Confirmation & Idempotency Storage
// -------------------------------------------------------------
export const pendingConfirmations = pgTable(
  'pending_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(), // SHA-256 of confirmation secret (Raw secret never stored!)
    actionType: text('action_type').notNull(), // 'record_expense' | 'create_invoice' | 'send_payment_reminder' | 'close_month'
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    humanSummary: text('human_summary').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_pending_confirmations_biz_id').on(table.businessId, table.id),
    // Enforce tenant isolation on user
    foreignKey({
      columns: [table.businessId, table.userId],
      foreignColumns: [users.businessId, users.id],
    }),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    actionType: text('action_type').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status').notNull(), // 'pending' | 'completed' | 'failed'
    responsePayload: jsonb('response_payload'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_idempotency_biz_key').on(table.businessId, table.idempotencyKey)],
);

// -------------------------------------------------------------
// 11. Serialized Hash-Chained Audit Logs
// -------------------------------------------------------------
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    sequenceNumber: bigint('sequence_number', { mode: 'bigint' }).notNull(),
    requestId: text('request_id').notNull(),
    userId: uuid('user_id'),
    source: text('source').notNull(), // 'voice' | 'console_web' | 'mcp_client'
    toolName: text('tool_name').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    confirmationTokenHash: text('confirmation_token_hash'),
    payloadHash: text('payload_hash').notNull(),
    prevHash: text('prev_hash').notNull(), // SHA-256 of sequence N-1
    entryHash: text('entry_hash').notNull(), // SHA-256(prevHash:seq:isoTimestamp:action:entityId:payloadHash)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_audit_logs_biz_seq').on(table.businessId, table.sequenceNumber)],
);

// -------------------------------------------------------------
// 12. Month-End Reports
// -------------------------------------------------------------
export const monthEndReports = pgTable('month_end_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  month: integer('month').notNull(), // 1-12
  year: integer('year').notNull(),
  isClosed: boolean('is_closed').notNull().default(false),
  summaryJson: jsonb('summary_json').notNull(),
  narrationMarkdown: text('narration_markdown'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedByUserId: uuid('closed_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// -------------------------------------------------------------
// 13. Audit Anchor Outbox (Transactional Outbox for External CloudWatch Anchors)
// -------------------------------------------------------------
export const auditAnchorOutbox = pgTable(
  'audit_anchor_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    targetEntityType: text('target_entity_type').notNull(), // 'month_end_report'
    targetEntityId: uuid('target_entity_id').notNull(),
    auditSequenceNumber: bigint('audit_sequence_number', { mode: 'bigint' }).notNull(),
    headHash: text('head_hash').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'anchored' | 'failed'
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    idempotencyKey: text('idempotency_key'),
    sinkIdentifier: text('sink_identifier'),
    receiptPayload: jsonb('receipt_payload'),
    lastError: text('last_error'),
    anchoredAt: timestamp('anchored_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_audit_anchor_outbox_biz_entity').on(
      table.businessId,
      table.targetEntityType,
      table.targetEntityId,
    ),
  ],
);
