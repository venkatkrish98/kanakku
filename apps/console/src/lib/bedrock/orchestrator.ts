/**
 * Bedrock Converse & Deterministic Voice Orchestrator
 * Interprets user voice transcripts and orchestrates MCP tool calls.
 * Implements ADR-002 (Separation of Deterministic Domain from LLM Reasoning)
 * and ADR-003 (Two-Phase Write Lifecycle with Confirmation Tokens).
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { McpHttpClient, type McpToolCallResult } from '../mcp-client/client';
import { getDatabase, businessMemory } from '@kanakku/db';
import { eq, and } from 'drizzle-orm';
import {
  assertAuthorizedForLedgerWrite,
  isConfirmationIntent,
  isCancellationIntent,
  CONTRADICTORY_OR_CONDITIONAL_REGEX,
  CANCELLATION_CONTRADICTORY_OR_CONDITIONAL_REGEX,
  DO_NOT_CANCEL_REGEX,
} from '../auth/authorization';

export interface VoiceTurnRequest {
  transcript: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  pendingToken?: string | null;
  businessId?: string;
  userId?: string;
  userRole?: string;
  client?: McpHttpClient;
}

export type DraftType = 'expense' | 'invoice' | 'reminder' | 'month_close';

export interface VoiceTurnResponse {
  spokenResponse: string;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: McpToolCallResult;
  }>;
  cardResourceUri?: string;
  confirmationToken?: string;
  draftType?: DraftType;
  actionRequired?: 'confirm' | 'clarify' | 'none';
  draftSummary?: Record<string, unknown>;
}

/**
 * Strict server-side tool allowlist for autonomous Bedrock execution.
 * Crucial Security Gate: Bedrock is NEVER allowed to invoke confirm_action or cancel_action!
 * Financial writes must strictly require human approval via the two-phase workflow.
 */
export const ALLOWED_BEDROCK_TOOLS = new Set([
  'record_expense',
  'create_invoice',
  'send_payment_reminder',
  'close_month',
  'list_outstanding_invoices',
  'get_gst_liability',
  'cashflow_summary',
  'whats_changed_since',
  'get_business_briefing',
  'explain_transaction',
  'get_audit_history',
]);

const SYSTEM_PROMPT = `You are Kanakku Voice Assistant, an AI financial copilot for Indian SMB owners and accountants.
CRITICAL FINANCIAL DOMAIN RULES (ADR-002 & ADR-003):
1. NEVER calculate GST, tax splitting (CGST/SGST/IGST), or double-entry ledgers yourself. ALWAYS call the corresponding MCP tool.
2. For financial writes (record_expense, create_invoice, send_payment_reminder), call the tool to generate a DRAFT and confirmation_token. Never claim a write is permanently committed until confirm_action is called.
3. You are FORBIDDEN from executing confirm_action or cancel_action directly. Only the human user can confirm drafts.
4. Keep spoken replies concise, clear, and natural (1 to 2 sentences max) suitable for Indian English text-to-speech.
5. Format currency figures in Indian numbering style (e.g. ₹2,400 or ₹50,000) in text responses.
6. If the user does not specify an amount for an expense or invoice, ask them for the amount. Never invent or assume amounts.`;

export class VoiceOrchestrator {
  private bedrockClient: BedrockRuntimeClient | null = null;
  private modelId: string;

  constructor() {
    this.modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';

    // Initialize Bedrock using AWS SDK default credential provider chain (IAM roles, App Runner, ECS, etc.)
    if (process.env.DISABLE_BEDROCK !== 'true') {
      try {
        this.bedrockClient = new BedrockRuntimeClient({ region });
      } catch (err) {
        console.warn('Bedrock client initialization skipped:', err);
        this.bedrockClient = null;
      }
    }
  }

  /**
   * Processes a voice turn from the user:
   * 1. Evaluates fast-path human confirmation/cancellation turns
   * 2. Incorporates durable cross-session business memory
   * 3. Evaluates intent via Bedrock Converse (or deterministic fallback)
   * 4. Enforces validation and security bounds
   */
  async processTurn(req: VoiceTurnRequest): Promise<VoiceTurnResponse> {
    const transcript = req.transcript.trim();
    const client = req.client || new McpHttpClient();

    // 1. Fast-path: Explicit human confirmation / cancellation of pending drafts
    if (req.pendingToken) {
      const lower = transcript.toLowerCase();

      // Check for unambiguous affirmative confirmation intent
      if (isConfirmationIntent(transcript)) {
        // Enforce shared server-side authorization check before executing ledger write
        assertAuthorizedForLedgerWrite(req.userRole);

        try {
          const result = await client.confirmAction(req.pendingToken);
          const meta = result._meta as Record<string, unknown> | undefined;
          const summary =
            result.content?.[0]?.text ||
            'Action successfully confirmed and recorded to the ledger.';
          return {
            spokenResponse:
              'Done! Your transaction is confirmed and posted to the double-entry books.',
            toolCalls: [
              { name: 'confirm_action', args: { confirmation_token: req.pendingToken }, result },
            ],
            actionRequired: 'none',
            draftSummary: { status: 'executed', message: summary, meta },
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            spokenResponse: `Could not confirm transaction: ${msg}`,
            toolCalls: [],
            actionRequired: 'none',
          };
        }
      }

      // Check for unambiguous cancellation intent
      if (isCancellationIntent(transcript)) {
        try {
          const result = await client.cancelAction(req.pendingToken, 'Cancelled via voice');
          return {
            spokenResponse:
              'Cancelled. The draft has been discarded and no changes were made to your books.',
            toolCalls: [
              { name: 'cancel_action', args: { confirmation_token: req.pendingToken }, result },
            ],
            actionRequired: 'none',
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            spokenResponse: `Could not cancel transaction: ${msg}`,
            toolCalls: [],
            actionRequired: 'none',
          };
        }
      }

      // If the user expressed contradictory, conditional, or hesitation intent (e.g. "Yes, but don't post it yet", "No, don't cancel yet")
      if (
        CONTRADICTORY_OR_CONDITIONAL_REGEX.test(lower) ||
        CANCELLATION_CONTRADICTORY_OR_CONDITIONAL_REGEX.test(lower) ||
        DO_NOT_CANCEL_REGEX.test(lower)
      ) {
        return {
          spokenResponse:
            'Understood. I will not post the transaction. Keeping the draft on hold without any changes. You can say "confirm" when ready to post, or "cancel" to discard.',
          toolCalls: [],
          confirmationToken: req.pendingToken,
          actionRequired: 'confirm',
        };
      }
    }

    // 2. Fetch Durable Tenant Business Memory (if businessId is provided)
    const activeMemories = await this.getBusinessMemories(req.businessId);

    // 3. Attempt Bedrock Converse if client is available
    if (this.bedrockClient) {
      try {
        const bedrockResult = await this.executeBedrockConverse(req, client, activeMemories);
        if (bedrockResult) {
          return bedrockResult;
        }
      } catch (err) {
        console.warn(
          'Bedrock Converse error or unconfigured credentials, falling back to deterministic intent engine:',
          err,
        );
      }
    }

    // 4. Deterministic Intent Engine (100% offline & local testable, strictly adhering to ADR-002)
    return this.executeDeterministicIntent(
      transcript,
      client,
      activeMemories,
      req.conversationHistory,
      req,
    );
  }

  /**
   * Retrieves durable tenant business memory from PostgreSQL
   */
  private async getBusinessMemories(businessId?: string): Promise<Record<string, unknown>> {
    if (!businessId) return {};

    try {
      const db = getDatabase();
      const records = await db
        .select()
        .from(businessMemory)
        .where(and(eq(businessMemory.businessId, businessId), eq(businessMemory.isActive, true)));

      const memoryMap: Record<string, unknown> = {};
      for (const rec of records) {
        memoryMap[rec.entityKey] = rec.memoryValue;
      }
      return memoryMap;
    } catch {
      // In offline / test setups without live database connection, continue gracefully
      return {};
    }
  }

  /**
   * Deterministic Natural Language Intent Engine
   * Accurately maps voice queries to Kanakku's 13 MCP tools.
   */
  private async executeDeterministicIntent(
    transcript: string,
    client: McpHttpClient,
    businessMemories: Record<string, unknown> = {},
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    _req?: VoiceTurnRequest,
  ): Promise<VoiceTurnResponse> {
    const text = transcript.toLowerCase();

    // 0. Month Close Clarification Intent (General Expense Approval)
    // Checked before general expense logging to avoid "expense" keyword collision
    if (
      text.includes('general expense') ||
      text.includes('general operational') ||
      text.includes('allow general') ||
      text.includes('approve general') ||
      text.includes('treat as general') ||
      text.includes('classify as general') ||
      text.includes('put as general')
    ) {
      // Role Gate: Reclassifying expenses and updating accounting journals requires owner or accountant
      assertAuthorizedForLedgerWrite(_req?.userRole);

      const { month, year } = this.extractMonthYear(transcript, conversationHistory);
      const toolCalls: Array<{
        name: string;
        args: Record<string, unknown>;
        result: McpToolCallResult;
      }> = [];

      // Step 2: Categorise with allow_general_expense
      const catArgs = { month, year, step: 'categorise', payload: { allow_general_expense: true } };
      const catResult = await client.callTool('close_month', catArgs);
      toolCalls.push({ name: 'close_month', args: catArgs, result: catResult });

      // Step 3: Reconcile with allow_general_expense
      const recArgs = { month, year, step: 'reconcile', payload: { allow_general_expense: true } };
      const recResult = await client.callTool('close_month', recArgs);
      toolCalls.push({ name: 'close_month', args: recArgs, result: recResult });

      let recParsed: Record<string, unknown> = {};
      try {
        recParsed = JSON.parse(recResult.content?.[0]?.text || '{}');
      } catch {
        recParsed = {};
      }

      if (recParsed['ledger_balanced'] === false) {
        return {
          spokenResponse: `Expenses marked as general operational expenses, but ledger reconciliation failed for ${month}/${year}. Please review the ledger entries before closing.`,
          toolCalls,
          actionRequired: 'none',
        };
      }

      // Step 4: Prepare close
      const prepArgs = {
        month,
        year,
        step: 'prepare_close',
        payload: { allow_general_expense: true },
      };
      const prepResult = await client.callTool('close_month', prepArgs);
      toolCalls.push({ name: 'close_month', args: prepArgs, result: prepResult });

      let prepParsed: Record<string, unknown> = {};
      try {
        prepParsed = JSON.parse(prepResult.content?.[0]?.text || '{}');
      } catch {
        prepParsed = {};
      }

      const token =
        (prepResult._meta?.confirmation_token as string) ||
        (prepParsed['confirmation_token'] as string) ||
        undefined;
      const resourceUri =
        (prepResult._meta?.['ui/resourceUri'] as string) ||
        (prepParsed['ui_resource_uri'] as string) ||
        `ui://cards/month-end-summary/${month}/${year}`;

      return {
        spokenResponse: `Approved general operational expenses. Reconciliation verified and books balanced for ${month}/${year}. Would you like to confirm and lock the books?`,
        toolCalls,
        cardResourceUri: resourceUri,
        confirmationToken: token,
        draftType: 'month_close',
        actionRequired: token ? 'confirm' : 'none',
        draftSummary: {
          type: 'month_close',
          month,
          year,
          status: 'awaiting_confirmation',
          confirmationToken: token,
          cardResourceUri: resourceUri,
        },
      };
    }

    // 0. Explain Transaction Intent (checked prior to record_expense to avoid substring collisions)
    // e.g. "Explain transaction e0000000-0000-...", "Explain expense f0000000-...", "Why did this affect my books?"
    if (
      text.includes('explain') ||
      text.includes('accounting treatment') ||
      text.includes('double entry') ||
      text.includes('why did this')
    ) {
      const uuidMatch = transcript.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      let entityType: 'invoice' | 'expense' | 'payment' | 'journal_entry' = 'invoice';
      if (text.includes('expense')) entityType = 'expense';
      else if (text.includes('payment')) entityType = 'payment';
      else if (text.includes('journal')) entityType = 'journal_entry';

      if (uuidMatch && uuidMatch[0]) {
        const transactionId = uuidMatch[0];
        const args = { transaction_id: transactionId, entity_type: entityType };
        const result = await client.callTool('explain_transaction', args);
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(result.content?.[0]?.text || '{}');
        } catch {
          parsed = {};
        }
        const spoken =
          (parsed['voice_summary'] as string) ||
          ((parsed['accounting_explanation'] as Record<string, unknown>)?.['summary'] as string) ||
          'Here is the double-entry accounting explanation for this transaction.';
        return {
          spokenResponse: spoken,
          toolCalls: [{ name: 'explain_transaction', args, result }],
          actionRequired: 'none',
        };
      } else {
        return {
          spokenResponse:
            'Which transaction would you like me to explain? Please specify the transaction or invoice ID.',
          toolCalls: [],
          actionRequired: 'clarify',
        };
      }
    }

    // 1. Record Expense Intent
    // e.g. "Record 2,400 expense for Swiggy client dinner", "Paid 500 cash for petrol"
    if (
      text.includes('expense') ||
      text.includes('spent') ||
      text.includes('paid') ||
      text.includes('bought')
    ) {
      const parsedAmount = this.extractAmount(transcript);

      // Validate parsed amount: Fail and clarify if missing or zero
      if (!parsedAmount || parsedAmount <= 0) {
        return {
          spokenResponse:
            'How much was the expense? Please specify the amount so I can prepare the draft.',
          toolCalls: [],
          actionRequired: 'clarify',
        };
      }

      if (parsedAmount > 10000000) {
        return {
          spokenResponse:
            'The amount exceeds the single transaction limit of ₹1,00,00,000. Please verify the amount.',
          toolCalls: [],
          actionRequired: 'clarify',
        };
      }

      const amountPaise = Math.round(parsedAmount * 100);

      let description = transcript
        .replace(/^(record|log|add|spent|paid)\s+(an?\s+)?expense\s*(of|for)?/i, '')
        .replace(/^(record|log|add)\s+/i, '')
        .trim();
      if (!description) description = 'Business Expense';

      let paymentMethod: 'upi' | 'cash' | 'bank_transfer' | 'card' = 'upi';
      if (text.includes('cash')) paymentMethod = 'cash';
      else if (text.includes('bank') || text.includes('neft') || text.includes('rtgs'))
        paymentMethod = 'bank_transfer';
      else if (text.includes('card')) paymentMethod = 'card';
      else {
        // Resolve preferred payment method from durable business memory
        const vendorKey = `vendor:${description.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
        const mem = businessMemories[vendorKey] as
          { default_payment_method?: 'upi' | 'cash' | 'bank_transfer' | 'card' } | undefined;
        if (mem?.default_payment_method) {
          paymentMethod = mem.default_payment_method;
        }
      }

      const today = new Date().toISOString().split('T')[0]!;
      const args = {
        amount_paise: amountPaise,
        description,
        payment_method: paymentMethod,
        date: today,
      };

      const result = await client.callTool('record_expense', args);
      let token = (result._meta?.confirmation_token as string) || undefined;
      let resourceUri = (result._meta?.['ui/resourceUri'] as string) || 'ui://cards/expense-draft';
      try {
        if (result.content?.[0]?.text) {
          const parsed = JSON.parse(result.content[0].text);
          if (parsed.confirmation_token) token = parsed.confirmation_token;
          if (parsed.ui_resource_uri) resourceUri = parsed.ui_resource_uri;
        }
      } catch {
        // Fallback to _meta or defaults
      }
      const rupees = (amountPaise / 100).toLocaleString('en-IN');

      return {
        spokenResponse: `Prepared an expense draft for ₹${rupees} for ${description}. Say confirm to post it to your books.`,
        toolCalls: [{ name: 'record_expense', args, result }],
        cardResourceUri: resourceUri,
        confirmationToken: token,
        draftType: 'expense',
        actionRequired: 'confirm',
        draftSummary: {
          type: 'expense',
          amountPaise,
          amountRupees: rupees,
          description,
          paymentMethod,
          date: today,
          confirmationToken: token,
        },
      };
    }

    // 2. Create Invoice Intent
    // e.g. "Create invoice for TechCorp for 50,000 rupees with 18% GST"
    if (text.includes('invoice') || text.includes('bill')) {
      let customerName = 'TechCorp Solutions';
      const matchCust = transcript.match(
        /(?:for|to)\s+([A-Za-z0-9\s&]+?)(?:\s+for|\s+with|\s+amount|\s+due|$)/i,
      );
      if (matchCust && matchCust[1]) {
        customerName = matchCust[1].trim();
      }

      const parsedAmount = this.extractAmount(transcript);

      // Validate parsed amount: Fail and clarify if missing or zero
      if (!parsedAmount || parsedAmount <= 0) {
        return {
          spokenResponse: `What is the invoice amount for ${customerName}? Please specify the amount so I can prepare the draft.`,
          toolCalls: [],
          actionRequired: 'clarify',
        };
      }

      if (parsedAmount > 10000000) {
        return {
          spokenResponse: 'The invoice amount exceeds the allowed limit. Please verify the amount.',
          toolCalls: [],
          actionRequired: 'clarify',
        };
      }

      const unitPricePaise = Math.round(parsedAmount * 100);

      const args = {
        customer_name: customerName,
        place_of_supply_state_code: '33', // Tamil Nadu default
        due_date: new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0]!,
        line_items: [
          {
            description: 'Professional Consulting Services',
            hsn_sac_code: '998311',
            quantity: 1,
            unit_price_paise: unitPricePaise,
            gst_rate_bps: 1800,
          },
        ],
      };

      const result = await client.callTool('create_invoice', args);
      let token = (result._meta?.confirmation_token as string) || undefined;
      let resourceUri = (result._meta?.['ui/resourceUri'] as string) || 'ui://cards/invoice-draft';
      let totalPaise = (result._meta?.total_paise as number) || Math.round(unitPricePaise * 1.18);
      try {
        if (result.content?.[0]?.text) {
          const parsed = JSON.parse(result.content[0].text);
          if (parsed.confirmation_token) token = parsed.confirmation_token;
          if (parsed.ui_resource_uri) resourceUri = parsed.ui_resource_uri;
          if (parsed.total_paise) totalPaise = parsed.total_paise;
        }
      } catch {
        // Fallback to _meta or defaults
      }
      const totalRupees = Math.round(totalPaise / 100).toLocaleString('en-IN');
      const subtotalRupees = Math.round(unitPricePaise / 100).toLocaleString('en-IN');

      return {
        spokenResponse: `Drafted invoice for ${customerName} for total ₹${totalRupees} including GST. Ready for your confirmation.`,
        toolCalls: [{ name: 'create_invoice', args, result }],
        cardResourceUri: resourceUri,
        confirmationToken: token,
        draftType: 'invoice',
        actionRequired: 'confirm',
        draftSummary: {
          type: 'invoice',
          customerName,
          subtotalRupees,
          totalPaise,
          totalRupees,
          gstBreakdown: '18% GST (9% CGST + 9% SGST)',
          dueDate: args.due_date,
          confirmationToken: token,
        },
      };
    }

    // 3. Payment Reminder Intent
    // e.g. "Send payment reminder to Ravi", "Remind customer"
    if (text.includes('reminder') || (text.includes('remind') && text.includes('pay'))) {
      let customerName = 'Ravi Traders';
      const matchCust = transcript.match(/(?:to|for)\s+([A-Za-z0-9\s]+?)(?:\s+via|\s+with|$)/i);
      if (matchCust && matchCust[1]) {
        customerName = matchCust[1].trim();
      }

      // Check durable business memory for customer preference
      const custKey = `customer:${customerName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
      const mem = businessMemories[custKey] as
        | {
            preferred_tone?: 'polite' | 'firm' | 'urgent';
            preferred_channel?: 'whatsapp' | 'email';
          }
        | undefined;

      let tone: 'polite' | 'firm' | 'urgent' = mem?.preferred_tone || 'polite';
      if (text.includes('firm')) tone = 'firm';
      else if (text.includes('urgent')) tone = 'urgent';

      let channel: 'whatsapp' | 'email' = mem?.preferred_channel || 'whatsapp';
      if (text.includes('email')) channel = 'email';
      else if (text.includes('whatsapp')) channel = 'whatsapp';

      const args = {
        customer_name: customerName,
        tone,
        channel,
      };

      const result = await client.callTool('send_payment_reminder', args);
      const token = (result._meta?.confirmation_token as string) || undefined;
      const resourceUri =
        (result._meta?.['ui/resourceUri'] as string) || 'ui://cards/payment-reminder-draft';

      return {
        spokenResponse: `Prepared a ${tone} ${channel} payment reminder for ${customerName}. Say confirm to dispatch it.`,
        toolCalls: [{ name: 'send_payment_reminder', args, result }],
        cardResourceUri: resourceUri,
        confirmationToken: token,
        draftType: 'reminder',
        actionRequired: 'confirm',
        draftSummary: {
          type: 'reminder',
          customerName,
          tone,
          channel,
          confirmationToken: token,
        },
      };
    }

    // 4. Outstanding Invoices / Receivables Intent
    // e.g. "Who owes me money?", "Show outstanding invoices"
    if (
      text.includes('owe') ||
      text.includes('outstanding') ||
      text.includes('receivable') ||
      text.includes('unpaid')
    ) {
      const result = await client.callTool('list_outstanding_invoices', {});
      const textOutput = result.content?.[0]?.text || '';
      return {
        spokenResponse:
          textOutput.split('\n')[0] ||
          'Here are your current outstanding receivables and ageing breakdown.',
        toolCalls: [{ name: 'list_outstanding_invoices', args: {}, result }],
        actionRequired: 'none',
      };
    }

    // 5. GST Liability Intent
    // e.g. "What is my GST liability?", "Calculate GST for this month"
    if (text.includes('gst') || text.includes('tax')) {
      const now = new Date();
      const args = {
        month: now.getMonth() + 1,
        year: now.getFullYear(),
      };
      const result = await client.callTool('get_gst_liability', args);
      const textOutput = result.content?.[0]?.text || '';
      return {
        spokenResponse:
          textOutput.split('\n')[0] ||
          'Here is your deterministic GST liability calculated for this month.',
        toolCalls: [{ name: 'get_gst_liability', args, result }],
        actionRequired: 'none',
      };
    }

    // 6. Cashflow Summary Intent
    // e.g. "What is my cashflow?", "Show cash inflow and outflow", "Compare cashflow with last month"
    if (
      text.includes('cashflow') ||
      text.includes('cash flow') ||
      text.includes('inflow') ||
      text.includes('outflow')
    ) {
      const now = new Date();
      const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]!;
      const toDate = now.toISOString().split('T')[0]!;
      const wantsComparison =
        text.includes('compare') ||
        text.includes('comparison') ||
        text.includes('versus') ||
        text.includes('vs') ||
        text.includes('last month') ||
        text.includes('prior');

      const args = { from_date: fromDate, to_date: toDate, comparison_period: wantsComparison };
      const result = await client.callTool('cashflow_summary', args);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(result.content?.[0]?.text || '{}');
      } catch {
        parsed = {};
      }

      let spoken = '';
      if (
        wantsComparison &&
        (parsed['comparison'] as Record<string, unknown>)?.['comparison_summary']
      ) {
        spoken = (parsed['comparison'] as Record<string, unknown>)['comparison_summary'] as string;
      } else if (parsed['inflow_formatted'] && parsed['outflow_formatted']) {
        const netPaise = Number(parsed['net_cashflow_paise'] ?? 0);
        spoken = `Realized cash inflow is ${parsed['inflow_formatted']} against outflows of ${parsed['outflow_formatted']}. Net cash flow is ${netPaise >= 0 ? 'positive' : 'negative'} at ${parsed['net_cashflow_formatted']}.`;
      } else {
        spoken =
          result.content?.[0]?.text?.split('\n')[0] ||
          'Here is your realized cashflow movement for the month.';
      }

      return {
        spokenResponse: spoken,
        toolCalls: [{ name: 'cashflow_summary', args, result }],
        actionRequired: 'none',
      };
    }

    // 7. What's Changed Intent
    // e.g. "What changed since yesterday?", "What changed this week?", "What's new?"
    if (text.includes('changed') || text.includes('since') || text.includes("what's new")) {
      let reference: 'last_briefing' | 'last_week' | 'last_month' = 'last_briefing';
      if (text.includes('week')) reference = 'last_week';
      else if (text.includes('month')) reference = 'last_month';

      const args = { reference };
      const result = await client.callTool('whats_changed_since', args);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(result.content?.[0]?.text || '{}');
      } catch {
        parsed = {};
      }
      const spoken =
        (parsed['voice_summary'] as string) ||
        result.content?.[0]?.text?.split('\n')[0] ||
        'Here is what has changed in your business since your last briefing.';
      return {
        spokenResponse: spoken,
        toolCalls: [{ name: 'whats_changed_since', args, result }],
        actionRequired: 'none',
      };
    }

    // 8. Business Briefing Intent
    // e.g. "Give me a business briefing", "Daily briefing", "Weekly briefing", "How is my business doing?"
    if (
      text.includes('briefing') ||
      text.includes('summary') ||
      text.includes('overview') ||
      text.includes('how is my business')
    ) {
      const timeframe: 'today' | 'weekly' = text.includes('week') ? 'weekly' : 'today';
      const args = { timeframe };
      const result = await client.callTool('get_business_briefing', args);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(result.content?.[0]?.text || '{}');
      } catch {
        parsed = {};
      }
      const spoken =
        (parsed['voice_summary'] as string) ||
        result.content?.[0]?.text?.split('\n')[0] ||
        'Here is your business financial briefing.';
      return {
        spokenResponse: spoken,
        toolCalls: [{ name: 'get_business_briefing', args, result }],
        cardResourceUri: (parsed['ui_resource_uri'] as string) || 'ui://cards/business-briefing',
        actionRequired: 'none',
      };
    }

    // 9. Close Month Intent
    // e.g. "Close month for September", "Start month end close", "Resume month close", "Close August 2026 books"
    if (
      text.includes('close month') ||
      text.includes('month end') ||
      text.includes('close the month') ||
      text.includes('close books') ||
      text.includes('resume month') ||
      text.includes('continue month')
    ) {
      const { month, year } = this.extractMonthYear(transcript, conversationHistory);
      const toolCalls: Array<{
        name: string;
        args: Record<string, unknown>;
        result: McpToolCallResult;
      }> = [];

      const initialArgs = { month, year, step: 'resume' };
      const result = await client.callTool('close_month', initialArgs);
      toolCalls.push({ name: 'close_month', args: initialArgs, result });

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(result.content?.[0]?.text || '{}');
      } catch {
        parsed = {};
      }

      // Case 1: Month is already closed
      if (parsed['status'] === 'already_closed') {
        return {
          spokenResponse: `Month ${month}/${year} was already closed. Financial books are permanently locked.`,
          toolCalls,
          actionRequired: 'none',
        };
      }

      // Case 2: Scan complete with uncategorized expenses
      const uncategorized = Number(
        parsed['uncategorized_expenses_count'] ?? parsed['uncategorized_count'] ?? 0,
      );
      if (parsed['step'] === 'scan' && uncategorized > 0) {
        return {
          spokenResponse: `I scanned the ledger for ${month}/${year}. There are ${uncategorized} uncategorized expenses. Would you like to treat them as general operational expenses, or review them before closing?`,
          toolCalls,
          draftType: 'month_close',
          actionRequired: 'clarify',
          draftSummary: {
            type: 'month_close',
            month,
            year,
            step: 'scan',
            uncategorizedCount: uncategorized,
            status: 'scanned',
          },
        };
      }

      // Case 3: Categorise step with remaining uncategorized items
      if (
        parsed['step'] === 'categorise' &&
        uncategorized > 0 &&
        !parsed['allow_general_expense']
      ) {
        return {
          spokenResponse: `There are ${uncategorized} uncategorized expenses remaining for ${month}/${year}. Would you like to approve them as general operational expenses?`,
          toolCalls,
          draftType: 'month_close',
          actionRequired: 'clarify',
          draftSummary: {
            type: 'month_close',
            month,
            year,
            step: 'categorise',
            uncategorizedCount: uncategorized,
            status: 'categorisation_pending',
          },
        };
      }

      // Case 4: Zero uncategorized expenses - automatically advance through reconcile to prepare_close
      if (parsed['step'] === 'scan' && uncategorized === 0) {
        const recArgs = { month, year, step: 'reconcile' };
        const recResult = await client.callTool('close_month', recArgs);
        toolCalls.push({ name: 'close_month', args: recArgs, result: recResult });

        let recParsed: Record<string, unknown> = {};
        try {
          recParsed = JSON.parse(recResult.content?.[0]?.text || '{}');
        } catch {
          recParsed = {};
        }

        if (recParsed['ledger_balanced'] === true) {
          const prepArgs = { month, year, step: 'prepare_close' };
          const prepResult = await client.callTool('close_month', prepArgs);
          toolCalls.push({ name: 'close_month', args: prepArgs, result: prepResult });

          let prepParsed: Record<string, unknown> = {};
          try {
            prepParsed = JSON.parse(prepResult.content?.[0]?.text || '{}');
          } catch {
            prepParsed = {};
          }

          const token =
            (prepResult._meta?.confirmation_token as string) ||
            (prepParsed['confirmation_token'] as string) ||
            undefined;
          const resourceUri =
            (prepResult._meta?.['ui/resourceUri'] as string) ||
            (prepParsed['ui_resource_uri'] as string) ||
            `ui://cards/month-end-summary/${month}/${year}`;

          return {
            spokenResponse: `Reconciliation verified and ledger is balanced for ${month}/${year}. Would you like to confirm and lock the books?`,
            toolCalls,
            cardResourceUri: resourceUri,
            confirmationToken: token,
            draftType: 'month_close',
            actionRequired: token ? 'confirm' : 'none',
            draftSummary: {
              type: 'month_close',
              month,
              year,
              status: 'awaiting_confirmation',
              confirmationToken: token,
              cardResourceUri: resourceUri,
            },
          };
        }
      }

      // Case 5: Already at prepare_close
      const token =
        (result._meta?.confirmation_token as string) ||
        (parsed['confirmation_token'] as string) ||
        undefined;
      const resourceUri =
        (result._meta?.['ui/resourceUri'] as string) ||
        (parsed['ui_resource_uri'] as string) ||
        `ui://cards/month-end-summary/${month}/${year}`;

      return {
        spokenResponse: `Initiated month-end close workflow for ${month}/${year}. I have scanned all ledger accounts and prepared the summary.`,
        toolCalls,
        cardResourceUri: resourceUri,
        confirmationToken: token,
        draftType: 'month_close',
        actionRequired: token ? 'confirm' : 'none',
        draftSummary: {
          type: 'month_close',
          month,
          year,
          status: 'awaiting_confirmation',
          confirmationToken: token,
          cardResourceUri: resourceUri,
        },
      };
    }

    // 10. Audit History Intent
    // e.g. "Show audit log", "Audit history"
    if (text.includes('audit') || text.includes('log') || text.includes('activity')) {
      const result = await client.callTool('get_audit_history', { limit: 5 });
      const textOutput = result.content?.[0]?.text || '';
      return {
        spokenResponse:
          textOutput.split('\n')[0] ||
          'Here are the latest entries from your tamper-evident audit log.',
        toolCalls: [{ name: 'get_audit_history', args: { limit: 5 }, result }],
        actionRequired: 'none',
      };
    }

    // Default conversational help response
    return {
      spokenResponse:
        "I'm ready. You can say 'Record an expense of 2,400 for dinner', 'Who owes me money?', 'What is my GST liability?', or 'Create an invoice for TechCorp for 50,000'.",
      toolCalls: [],
      actionRequired: 'none',
    };
  }

  /**
   * Helper to extract numeric amount from voice text (e.g. "2,400", "2400", "50k", "50,000")
   */
  private extractAmount(text: string): number | null {
    const clean = text.replace(/,/g, '');
    const kMatch = clean.match(/(\d+(?:\.\d+)?)\s*k\b/i);
    if (kMatch && kMatch[1]) {
      return parseFloat(kMatch[1]) * 1000;
    }
    const lMatch = clean.match(/(\d+(?:\.\d+)?)\s*lakh\b/i);
    if (lMatch && lMatch[1]) {
      return parseFloat(lMatch[1]) * 100000;
    }
    const numMatch = clean.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)/i);
    if (numMatch && numMatch[1]) {
      return parseFloat(numMatch[1]);
    }
    return null;
  }

  /**
   * Helper to extract month and year from voice transcript or prior conversation history
   */
  private extractMonthYear(
    text: string,
    history?: Array<{ role: string; content: string }>,
  ): { month: number; year: number } {
    const monthNames: Record<string, number> = {
      january: 1,
      jan: 1,
      february: 2,
      feb: 2,
      march: 3,
      mar: 3,
      april: 4,
      apr: 4,
      may: 5,
      june: 6,
      jun: 6,
      july: 7,
      jul: 7,
      august: 8,
      aug: 8,
      september: 9,
      sep: 9,
      sept: 9,
      october: 10,
      oct: 10,
      november: 11,
      nov: 11,
      december: 12,
      dec: 12,
    };

    const lower = text.toLowerCase();
    let month: number | undefined;
    let year: number | undefined;

    for (const [name, num] of Object.entries(monthNames)) {
      const regex = new RegExp(`\\b${name}\\b`, 'i');
      if (regex.test(lower)) {
        month = num;
        break;
      }
    }

    const yearMatch = lower.match(/\b(202[4-9]|203[0-9])\b/);
    if (yearMatch?.[1]) {
      year = parseInt(yearMatch[1], 10);
    }

    if ((!month || !year) && history && history.length > 0) {
      for (let i = history.length - 1; i >= 0; i--) {
        const histText = history[i]!.content.toLowerCase();
        if (!month) {
          for (const [name, num] of Object.entries(monthNames)) {
            const regex = new RegExp(`\\b${name}\\b`, 'i');
            if (regex.test(histText)) {
              month = num;
              break;
            }
          }
          const mMatch =
            histText.match(/\bmonth\s*(\d{1,2})\b/) ||
            histText.match(/\b(\d{1,2})\/(202[4-9]|203[0-9])\b/);
          if (mMatch?.[1]) {
            const m = parseInt(mMatch[1], 10);
            if (m >= 1 && m <= 12) month = m;
          }
        }
        if (!year) {
          const yMatch = histText.match(/\b(202[4-9]|203[0-9])\b/);
          if (yMatch?.[1]) {
            year = parseInt(yMatch[1], 10);
          }
        }
        if (month && year) break;
      }
    }

    const now = new Date();
    if (!month) {
      month = now.getMonth() === 0 ? 12 : now.getMonth();
    }
    if (!year) {
      year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    }

    return { month, year };
  }

  /**
   * Bedrock Converse Execution when AWS client is available
   * STRICT SECURITY ENFORCEMENT:
   * - Model is only exposed to ALLOWED_BEDROCK_TOOLS (confirm_action is strictly excluded).
   * - Any model-generated attempt to call confirm_action or unauthorized tools is blocked.
   */
  private async executeBedrockConverse(
    req: VoiceTurnRequest,
    client: McpHttpClient,
    businessMemories: Record<string, unknown> = {},
  ): Promise<VoiceTurnResponse | null> {
    if (!this.bedrockClient) return null;

    const availableTools = (await client.listTools()) || [];
    // Enforce server-side allowlist: EXCLUDE confirm_action & cancel_action
    const bedrockToolSpecs = (Array.isArray(availableTools) ? availableTools : [])
      .filter((t) => ALLOWED_BEDROCK_TOOLS.has(t.name))
      .map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: {
            json: t.inputSchema as Record<string, unknown>,
          },
        },
      }));

    const memoryPrompt =
      Object.keys(businessMemories).length > 0
        ? `\nACTIVE TENANT BUSINESS PREFERENCES:\n${JSON.stringify(businessMemories, null, 2)}`
        : '';

    const conversation = [
      ...(req.conversationHistory || []).map((m) => ({
        role: m.role,
        content: [{ text: m.content }],
      })),
      {
        role: 'user' as const,
        content: [{ text: req.transcript }],
      },
    ];

    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: `${SYSTEM_PROMPT}${memoryPrompt}` }],
      messages: conversation as unknown as Message[],
      toolConfig: {
        tools: bedrockToolSpecs as unknown as Tool[],
      },
      inferenceConfig: {
        maxTokens: 512,
        temperature: 0.1,
      },
    });

    const response = await this.bedrockClient.send(command);
    const message = response.output?.message;
    if (!message) return null;

    let spokenResponse = '';
    const executedToolCalls: VoiceTurnResponse['toolCalls'] = [];
    let cardResourceUri: string | undefined;
    let confirmationToken: string | undefined;
    let draftType: DraftType | undefined;

    for (const contentBlock of message.content || []) {
      if (contentBlock.text) {
        spokenResponse += contentBlock.text + ' ';
      }
      if (contentBlock.toolUse) {
        const toolName = contentBlock.toolUse.name || '';
        const toolArgs = (contentBlock.toolUse.input as Record<string, unknown>) || {};

        // Hard Server-Side Approval Gate: Refuse any model-initiated confirm_action or unapproved tool
        if (
          !ALLOWED_BEDROCK_TOOLS.has(toolName) ||
          toolName === 'confirm_action' ||
          toolName === 'cancel_action'
        ) {
          console.warn(
            `SECURITY_VIOLATION_BLOCKED: Bedrock model attempted to call prohibited tool '${toolName}'. Execution rejected.`,
          );
          continue;
        }

        try {
          const result = await client.callTool(toolName, toolArgs);
          executedToolCalls.push({ name: toolName, args: toolArgs, result });
          if (result._meta?.['ui/resourceUri']) {
            cardResourceUri = result._meta['ui/resourceUri'] as string;
          }
          if (result._meta?.confirmation_token) {
            confirmationToken = result._meta.confirmation_token as string;
          }
          if (toolName === 'record_expense') draftType = 'expense';
          else if (toolName === 'create_invoice') draftType = 'invoice';
          else if (toolName === 'send_payment_reminder') draftType = 'reminder';
          else if (toolName === 'close_month') draftType = 'month_close';
        } catch (callErr) {
          console.error(`Error executing Bedrock tool ${toolName}:`, callErr);
        }
      }
    }

    spokenResponse = spokenResponse.trim() || 'Processed your request successfully.';
    return {
      spokenResponse,
      toolCalls: executedToolCalls,
      cardResourceUri,
      confirmationToken,
      draftType,
      actionRequired: confirmationToken ? 'confirm' : 'none',
    };
  }
}

export const voiceOrchestrator = new VoiceOrchestrator();
