import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KanakkuDatabase } from '@kanakku/db';

import { recordExpenseSchema, handleRecordExpense } from './record-expense.js';
import { createInvoiceSchema, handleCreateInvoice } from './create-invoice.js';
import { sendReminderSchema, handleSendPaymentReminder } from './send-reminder.js';
import { closeMonthSchema, handleCloseMonth } from './close-month.js';
import { confirmActionSchema, handleConfirmAction } from './confirm-action.js';
import { cancelActionSchema, handleCancelAction } from './cancel-action.js';
import {
  listOutstandingInvoicesSchema,
  handleListOutstandingInvoices,
} from './outstanding-invoices.js';
import { getGstLiabilitySchema, handleGetGstLiability } from './gst-liability.js';
import { cashflowSummarySchema, handleCashflowSummary } from './cashflow-summary.js';
import { whatsChangedSinceSchema, handleWhatsChangedSince } from './whats-changed.js';
import {
  getBusinessBriefingSchema,
  handleGetBusinessBriefing,
} from './business-briefing.js';
import {
  explainTransactionSchema,
  handleExplainTransaction,
} from './explain-transaction.js';
import { getAuditHistorySchema, handleGetAuditHistory } from './audit-history.js';

export function registerTools(server: McpServer, db: KanakkuDatabase) {
  // 1. record_expense (Draft with MCP Apps UI card)
  server.registerTool(
    'record_expense',
    {
      description:
        'Prepare an expense draft from voice or text without touching the books. Returns a 15-minute confirmation token.',
      inputSchema: recordExpenseSchema,
      _meta: {
        ui: {
          resourceUri: 'ui://cards/expense-draft',
        },
      },
    },
    async (args) => handleRecordExpense(args, db),
  );

  // 2. create_invoice (Draft with MCP Apps UI card)
  server.registerTool(
    'create_invoice',
    {
      description:
        'Prepare a sales invoice draft with deterministic GST calculations. Returns a 15-minute confirmation token.',
      inputSchema: createInvoiceSchema,
      _meta: {
        ui: {
          resourceUri: 'ui://cards/invoice-draft',
        },
      },
    },
    async (args) => handleCreateInvoice(args, db),
  );

  // 3. send_payment_reminder (Draft)
  server.tool(
    'send_payment_reminder',
    'Prepare an invoice collection reminder with exact message preview. Returns a 15-minute confirmation token. [DEMO SIMULATION: stores reminder with status sent_demo; live provider integration scheduled for AWS Builder phase].',
    sendReminderSchema,
    async (args) => handleSendPaymentReminder(args, db),
  );

  // 4. close_month (Agentic multi-step workflow with MCP Apps UI card)
  server.registerTool(
    'close_month',
    {
      description:
        'Execute a multi-step month-end close workflow (scan, categorise, reconcile, prepare_close).',
      inputSchema: closeMonthSchema,
      _meta: {
        ui: {
          resourceUri: 'ui://cards/month-end-summary',
        },
      },
    },
    async (args) => handleCloseMonth(args, db),
  );

  // 5. confirm_action (Universal executor, callable by model and app UI)
  server.registerTool(
    'confirm_action',
    {
      description:
        'Universal executor for all pending drafts. Atomically consumes confirmation token, posts double-entry ledger lines, records idempotency result, and appends serialized audit log.',
      inputSchema: confirmActionSchema,
      _meta: {
        ui: {
          visibility: ['model', 'app'],
        },
      },
    },
    async (args) => handleConfirmAction(args, db),
  );

  // 6. cancel_action (Universal cancel, callable by model and app UI)
  server.registerTool(
    'cancel_action',
    {
      description:
        'Explicitly abort a pending draft and mark confirmation token void without touching financial books.',
      inputSchema: cancelActionSchema,
      _meta: {
        ui: {
          visibility: ['model', 'app'],
        },
      },
    },
    async (args) => handleCancelAction(args, db),
  );

  // 7. list_outstanding_invoices (Deterministic read)
  server.tool(
    'list_outstanding_invoices',
    'Fetch outstanding receivables and aged debt buckets (current, 1-30, 31-60, 61-90, 90+ days) normalized to IST.',
    listOutstandingInvoicesSchema,
    async (args) => handleListOutstandingInvoices(args, db),
  );

  // 8. get_gst_liability (Deterministic read with MCP Apps UI card)
  server.registerTool(
    'get_gst_liability',
    {
      description:
        'Calculate deterministic GST liability for a period using Section 49 set-off order and estimated ITC.',
      inputSchema: getGstLiabilitySchema,
      _meta: {
        ui: {
          resourceUri: 'ui://cards/gst-liability',
        },
      },
    },
    async (args) => handleGetGstLiability(args, db),
  );

  // 9. cashflow_summary (Deterministic read)
  server.tool(
    'cashflow_summary',
    'Summarize realized cash movements (payments received vs posted expenses) across a date window.',
    cashflowSummarySchema,
    async (args) => handleCashflowSummary(args, db),
  );

  // 10. whats_changed_since (Delta intelligence)
  server.tool(
    'whats_changed_since',
    'Evaluate financial deltas (new invoices, payments, overdue items, expense surges) since a baseline timestamp.',
    whatsChangedSinceSchema,
    async (args) => handleWhatsChangedSince(args, db),
  );

  // 11. get_business_briefing (Executive snapshot with MCP Apps UI card)
  server.registerTool(
    'get_business_briefing',
    {
      description:
        'Generate an executive financial snapshot with a concise voice summary (<= 2 sentences) and rich card data.',
      inputSchema: getBusinessBriefingSchema,
      _meta: {
        ui: {
          resourceUri: 'ui://cards/business-briefing',
        },
      },
    },
    async (args) => handleGetBusinessBriefing(args, db),
  );

  // 12. explain_transaction (Double-entry explanation)
  server.tool(
    'explain_transaction',
    'Inspect a transaction to view balanced double-entry journal debits/credits, tax impact, and audit history. [Deterministic double-entry rules; Amazon Bedrock agentic natural-language synthesis scheduled for AWS Builder phase].',
    explainTransactionSchema,
    async (args) => handleExplainTransaction(args, db),
  );

  // 13. get_audit_history (Audit log query)
  server.tool(
    'get_audit_history',
    'Query serialized hash-chained audit log history and verify cryptographic chain integrity.',
    getAuditHistorySchema,
    async (args) => handleGetAuditHistory(args, db),
  );
}
