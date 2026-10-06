import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateConfirmationToken } from '@kanakku/core';
import { createHash } from 'node:crypto';
import { eq, and, lt, gt, ne, notInArray } from 'drizzle-orm';
import {
  getDatabase,
  closeDatabase,
  type KanakkuDatabase,
  businesses,
  users,
  monthEndReports,
  expenseCategories,
  expenses,
  journalEntries,
  journalLines,
  chartOfAccounts,
  auditLogs,
  businessMemory,
  invoices,
  invoiceItems,
  payments,
  paymentReminders,
  pendingConfirmations,
  idempotencyRecords,
  sessionContext,
  conversationSessions,
} from '@kanakku/db';
import { createHttpServer } from './server.js';
import { resolveSessionContext } from './tools/session-helper.js';
import { JSDOM } from 'jsdom';
import {
  McpAppsBrowserHost,
  BROWSER_HOST_LISTENER_SCRIPT,
  MCP_APPS_EXTENSION,
  MCP_APP_MIME_TYPE,
} from './apps/index.js';

describe('Kanakku MCP Server Integration Suite', () => {
  let db: KanakkuDatabase;
  let serverInstance: ReturnType<typeof createHttpServer>;
  let serverPort: number;
  let baseUrl: string;

  const validToken = 'kanakku_test_secret_ramesh_2026';
  const tenant2BizId = 'b0000000-0000-0000-0000-000000000002';
  const tenant2UserId = '10000000-0000-0000-0000-000000000002';
  const tenant2Secret = 'kanakku_test_secret_tenant2_2026';
  const tenant2ApiKeyHash = createHash('sha256').update(tenant2Secret).digest('hex');

  const tenant1EmployeeId = '10000000-0000-0000-0000-000000000099';
  const tenant1EmployeeSecret = 'kanakku_test_secret_employee_2026';
  const tenant1EmployeeApiKeyHash = createHash('sha256')
    .update(tenant1EmployeeSecret)
    .digest('hex');
  const validApiKeyHash = createHash('sha256').update(validToken).digest('hex');

  beforeAll(async () => {
    db = getDatabase();

    // Clean up any test artifacts from prior test runs to ensure a clean seed state
    await db.delete(auditLogs).where(gt(auditLogs.sequenceNumber, 3n));
    await db.delete(monthEndReports);
    await db.delete(pendingConfirmations);
    await db.delete(idempotencyRecords);
    await db.delete(paymentReminders);

    const seedInvoiceIds = [
      'f0000000-0000-0000-0000-000000000001',
      'f0000000-0000-0000-0000-000000000002',
      'f0000000-0000-0000-0000-000000000003',
    ];
    const seedExpenseIds = [
      'd0000000-0000-0000-0000-000000000001',
      'd0000000-0000-0000-0000-000000000002',
      'd0000000-0000-0000-0000-000000000003',
    ];
    const seedPaymentIds = [
      'e1000000-0000-0000-0000-000000000001',
      'e1000000-0000-0000-0000-000000000002',
    ];
    const seedJeIds = [
      'e2000000-0000-0000-0000-000000000001',
      'e2000000-0000-0000-0000-000000000002',
      'e2000000-0000-0000-0000-000000000003',
      'e2000000-0000-0000-0000-000000000004',
      'e2000000-0000-0000-0000-000000000005',
      'e2000000-0000-0000-0000-000000000006',
      'e2000000-0000-0000-0000-000000000007',
      'e2000000-0000-0000-0000-000000000008',
      'e2000000-0000-0000-0000-000000000009',
    ];

    await db.delete(invoiceItems).where(notInArray(invoiceItems.invoiceId, seedInvoiceIds));
    await db.delete(payments).where(notInArray(payments.id, seedPaymentIds));
    await db.delete(invoices).where(notInArray(invoices.id, seedInvoiceIds));
    await db.delete(journalLines).where(notInArray(journalLines.journalEntryId, seedJeIds));
    await db.delete(journalEntries).where(notInArray(journalEntries.id, seedJeIds));
    await db.delete(expenses).where(notInArray(expenses.id, seedExpenseIds));

    // Reset seed expense 3 to uncategorized if it was categorized by prior run
    await db
      .update(expenses)
      .set({ categoryId: null })
      .where(eq(expenses.id, 'd0000000-0000-0000-0000-000000000003'));

    // Reset seed business memory
    await db
      .delete(businessMemory)
      .where(ne(businessMemory.id, 'b1000000-0000-0000-0000-000000000001'));

    // Explicitly provision the test owner API key hash for test fixtures
    await db
      .update(users)
      .set({ apiKeyHash: validApiKeyHash })
      .where(eq(users.id, '10000000-0000-0000-0000-000000000001'));

    // Ensure a second tenant exists for cross-tenant isolation testing
    await db
      .insert(businesses)
      .values({
        id: tenant2BizId,
        name: 'Competitor Corp',
        legalName: 'Competitor Corp Pvt Ltd',
        gstin: '33AABCC9999Z1Z9',
        stateCode: '33',
        pan: 'AABCC9999Z',
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: tenant2UserId,
        businessId: tenant2BizId,
        email: 'other@competitor.com',
        name: 'Other User',
        role: 'owner',
        apiKeyHash: tenant2ApiKeyHash,
      })
      .onConflictDoUpdate({
        target: [users.id],
        set: { apiKeyHash: tenant2ApiKeyHash },
      });

    // Ensure employee user in Tenant 1 exists for same-tenant session isolation testing
    await db
      .insert(users)
      .values({
        id: tenant1EmployeeId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        email: 'employee@shreedesign.in',
        name: 'Staff Employee',
        role: 'member',
        apiKeyHash: tenant1EmployeeApiKeyHash,
      })
      .onConflictDoUpdate({
        target: [users.id],
        set: { apiKeyHash: tenant1EmployeeApiKeyHash },
      });

    // Start HTTP Server on ephemeral port
    serverInstance = createHttpServer({ db, port: 0 });
    serverPort = await serverInstance.listen(0);
    baseUrl = `http://127.0.0.1:${serverPort}`;
  });

  afterAll(async () => {
    await serverInstance.close();
    await closeDatabase();
  });

  // Helper for MCP JSON-RPC requests
  async function mcpPost(
    body: Record<string, unknown>,
    options?: {
      token?: string;
      sessionId?: string;
      protocolVersion?: string;
      extraHeaders?: Record<string, string>;
    },
  ) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    if (options?.token !== undefined) {
      if (options.token) {
        headers['Authorization'] = `Bearer ${options.token}`;
      }
    } else {
      headers['Authorization'] = `Bearer ${validToken}`;
    }

    if (options?.sessionId) {
      headers['mcp-session-id'] = options.sessionId;
    }
    if (options?.protocolVersion) {
      headers['mcp-protocol-version'] = options.protocolVersion;
    }
    if (options?.extraHeaders) {
      Object.assign(headers, options.extraHeaders);
    }

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // SSE event or empty response
      const match = text.match(/data:\s*({.+})/);
      if (match && match[1]) {
        json = JSON.parse(match[1]);
      }
    }

    return {
      status: res.status,
      headers: res.headers,
      sessionId: res.headers.get('mcp-session-id'),
      data: json as Record<string, unknown> & {
        result?: {
          content?: Array<{ text: string }>;
          tools?: Array<{ name: string }>;
          resources?: Array<{ uri: string }>;
          prompts?: Array<{ name: string }>;
          messages?: Array<{ content: { text: string } }>;
          isError?: boolean;
          protocolVersion?: string;
          serverInfo?: { name: string };
        };
        error?: { code?: number; message?: string };
      },
      rawText: text,
    };
  }

  function extractToolError(res: {
    data?: {
      error?: { message?: string };
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
  }): string {
    if (res.data?.error?.message) {
      return res.data.error.message;
    }
    if (res.data?.result?.isError && res.data?.result?.content?.[0]?.text) {
      return res.data.result.content[0].text;
    }
    return '';
  }

  // -------------------------------------------------------------
  // 1. Health & Authentication Boundary Tests
  // -------------------------------------------------------------
  describe('Health & Auth Guards', () => {
    it('returns health status on GET /health', async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.service).toBe('kanakku-mcp-server');
      expect(data.protocol_version).toBe('2025-11-25');
    });

    it('rejects unauthenticated requests to /mcp with 401', async () => {
      const res = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: '' });
      expect(res.status).toBe(401);
      expect(res.data.error).toBe('UNAUTHENTICATED');
    });

    it('rejects invalid credentials to /mcp with 401', async () => {
      const res = await mcpPost(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { token: 'non_existent_token_123' },
      );
      expect(res.status).toBe(401);
      expect(res.data.error).toBe('INVALID_CREDENTIALS');
    });

    it('adversarial test: rejects X-User-Id header bypass with 401', async () => {
      const res = await mcpPost(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        {
          token: '',
          extraHeaders: { 'X-User-Id': '10000000-0000-0000-0000-000000000001' },
        },
      );
      expect(res.status).toBe(401);
      expect(res.data.error).toBe('UNAUTHENTICATED');
    });

    it('adversarial test: rejects user-ID shortcut token (user:<uuid>) with 401', async () => {
      const res = await mcpPost(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { token: 'user:10000000-0000-0000-0000-000000000001' },
      );
      expect(res.status).toBe(401);
      expect(res.data.error).toBe('INVALID_CREDENTIALS');
    });

    it('adversarial test: rejects registered email address shortcut with 401', async () => {
      const res = await mcpPost(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { token: 'ramesh@shreedesign.in' },
      );
      expect(res.status).toBe(401);
      expect(res.data.error).toBe('INVALID_CREDENTIALS');
    });

    it('handles CORS OPTIONS preflight and restricts origins (no wildcard *)', async () => {
      // Allowed origin
      const resAllowed = await fetch(`${baseUrl}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000' },
      });
      expect(resAllowed.status).toBe(204);
      expect(resAllowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      const allowHeaders = resAllowed.headers.get('access-control-allow-headers') || '';
      expect(allowHeaders.toLowerCase()).not.toContain('x-user-id');

      // Unauthorized origin
      const resDisallowed = await fetch(`${baseUrl}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://evil-attacker.com' },
      });
      expect(resDisallowed.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  // -------------------------------------------------------------
  // 2. MCP Handshake & Session Initialization
  // -------------------------------------------------------------
  describe('MCP Protocol Lifecycle (2025-11-25+)', () => {
    let clientSessionId: string;

    it('completes initialize handshake and returns session id', async () => {
      const init = await mcpPost({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-runner', version: '1.0.0' },
        },
      });

      expect(init.status).toBe(200);
      expect(init.sessionId).toBeTruthy();
      clientSessionId = init.sessionId!;
      expect(init.data.result.protocolVersion).toBe('2025-11-25');
      expect(init.data.result.serverInfo.name).toBe('kanakku');
    });

    it('accepts notifications/initialized with session id', async () => {
      const notif = await mcpPost(
        {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        {
          sessionId: clientSessionId,
          protocolVersion: '2025-11-25',
        },
      );

      expect([200, 202]).toContain(notif.status);
    });

    it('responds to ping over authenticated session', async () => {
      const ping = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'ping',
        },
        {
          sessionId: clientSessionId,
          protocolVersion: '2025-11-25',
        },
      );

      expect(ping.status).toBe(200);
      expect(ping.data.result).toBeDefined();
    });

    it('adversarial test: rejects same-tenant session reuse by a different user with 403 Forbidden', async () => {
      // Ramesh initialized clientSessionId.
      // Staff Employee (same tenant, different user) attempts to use Ramesh's session:
      const hijackedCall = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 99,
          method: 'ping',
        },
        {
          token: tenant1EmployeeSecret,
          sessionId: clientSessionId,
          protocolVersion: '2025-11-25',
        },
      );

      expect(hijackedCall.status).toBe(403);
      expect(hijackedCall.rawText).toContain('Cross-user or cross-tenant session access denied');
    });

    it('lists all 13 canonical MCP tools', async () => {
      const toolList = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
        },
        {
          sessionId: clientSessionId,
          protocolVersion: '2025-11-25',
        },
      );

      expect(toolList.status).toBe(200);
      const tools = toolList.data.result.tools;
      expect(tools).toHaveLength(13);

      const toolNames = tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('record_expense');
      expect(toolNames).toContain('create_invoice');
      expect(toolNames).toContain('send_payment_reminder');
      expect(toolNames).toContain('close_month');
      expect(toolNames).toContain('confirm_action');
      expect(toolNames).toContain('cancel_action');
      expect(toolNames).toContain('list_outstanding_invoices');
      expect(toolNames).toContain('get_gst_liability');
      expect(toolNames).toContain('cashflow_summary');
      expect(toolNames).toContain('whats_changed_since');
      expect(toolNames).toContain('get_business_briefing');
      expect(toolNames).toContain('explain_transaction');
      expect(toolNames).toContain('get_audit_history');
    });

    it('lists all 5 tenant-scoped resources', async () => {
      const resList = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'resources/list',
        },
        {
          sessionId: clientSessionId,
          protocolVersion: '2025-11-25',
        },
      );

      expect(resList.status).toBe(200);
      const resources = resList.data.result.resources;
      const uris = resources.map((r: { uri: string }) => r.uri);
      expect(uris).toHaveLength(5);
      expect(uris).toContain('kanakku://business-summary');
      expect(uris).toContain('kanakku://chart-of-accounts');
      expect(uris).toContain('kanakku://gst-rates');
      expect(uris).toContain('kanakku://audit-trail');
      expect(uris).toContain('kanakku://business-memory');
    });

    it('lists all 3 structured workflow prompts', async () => {
      const promptList = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'prompts/list',
        },
        {
          sessionId: clientSessionId,
          protocolVersion: '2025-11-25',
        },
      );

      expect(promptList.status).toBe(200);
      const promptNames = promptList.data.result.prompts.map((p: { name: string }) => p.name);
      expect(promptNames).toContain('month_end_close');
      expect(promptNames).toContain('weekly_briefing');
      expect(promptNames).toContain('business_briefing');
    });
  });

  // -------------------------------------------------------------
  // 3. Two-Phase Mutation Lifecycle & Ledger Integration
  // -------------------------------------------------------------
  describe('Two-Phase Mutation Flow (Draft -> Confirm -> Execute)', () => {
    let activeSessionId: string;

    beforeAll(async () => {
      const init = await mcpPost({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-runner', version: '1.0.0' },
        },
      });
      activeSessionId = init.sessionId!;
      await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
    });

    it('step 1: record_expense prepares draft without touching books', async () => {
      const call = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 240000,
              description: 'Printer ink for design mockups',
              payment_method: 'upi',
              vendor_name: 'HP World Store',
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(call.status).toBe(200);
      const content = JSON.parse(call.data.result.content[0].text);
      expect(content.status).toBe('pending_confirmation');
      expect(content.confirmation_token).toHaveLength(32);
      expect(content.preview_summary).toContain('Draft Expense: ₹2,400.00');
    });

    it('step 2: confirm_action executes draft, creates double-entry journal, and enforces idempotency', async () => {
      // 1. Create a draft
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 150000, // ₹1,500.00
              description: 'Office stationery and notebooks',
              payment_method: 'upi',
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      const draft = JSON.parse(draftRes.data.result.content[0].text);
      const token = draft.confirmation_token;
      const idempotencyKey = `test_idem_${Date.now()}`;

      // 2. Confirm action
      const confirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 13,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: {
              confirmation_token: token,
              idempotency_key: idempotencyKey,
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(confirmRes.status).toBe(200);
      const exec = JSON.parse(confirmRes.data.result.content[0].text);
      expect(exec.status).toBe('executed');
      expect(exec.action_type).toBe('record_expense');
      expect(exec.entity_id).toBeTruthy();
      expect(exec.audit_id).toBeTruthy();
      expect(exec.human_summary).toContain('Expense of ₹1,500.00');

      // 3. Replay with same idempotency key returns cached result
      const replayRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 14,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: {
              confirmation_token: token,
              idempotency_key: idempotencyKey,
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(replayRes.status).toBe(200);
      const replay = JSON.parse(replayRes.data.result.content[0].text);
      expect(replay.status).toBe('executed');
      expect(replay.entity_id).toBe(exec.entity_id);
      expect(replay.audit_id).toBe(exec.audit_id);

      // 4. Repeated confirmation without idempotency key fails closed
      const duplicateRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 15,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: {
              confirmation_token: token,
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(extractToolError(duplicateRes)).toContain('CONFIRMATION_ALREADY_CONSUMED');
    });

    it('step 3: cancel_action aborts draft and preserves financial books untouched', async () => {
      // 1. Create draft
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 16,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 999900,
              description: 'Accidental expense to cancel',
              payment_method: 'card',
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      const draft = JSON.parse(draftRes.data.result.content[0].text);
      const token = draft.confirmation_token;

      // 2. Cancel draft
      const cancelRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 17,
          method: 'tools/call',
          params: {
            name: 'cancel_action',
            arguments: {
              confirmation_token: token,
              reason: 'Mistyped amount',
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(cancelRes.status).toBe(200);
      const cancel = JSON.parse(cancelRes.data.result.content[0].text);
      expect(cancel.status).toBe('cancelled');

      // 3. Attempting to confirm cancelled action must fail closed
      const confirmAttempt = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 18,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: {
              confirmation_token: token,
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(extractToolError(confirmAttempt)).toContain('CONFIRMATION_ALREADY_CONSUMED');
    });

    it('step 4: creates and confirms sales invoice with deterministic GST', async () => {
      const invoiceDraftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 19,
          method: 'tools/call',
          params: {
            name: 'create_invoice',
            arguments: {
              customer_name: 'Ravi Traders',
              place_of_supply_state_code: '33', // Tamil Nadu (intra-state)
              due_date: '2026-10-31',
              line_items: [
                {
                  description: 'UI/UX Design Sprint',
                  quantity: 1,
                  unit_price_paise: 2500000, // ₹25,000.00
                  gst_rate_bps: 1800, // 18%
                },
              ],
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(invoiceDraftRes.status).toBe(200);
      const invoiceDraft = JSON.parse(invoiceDraftRes.data.result.content[0].text);
      expect(invoiceDraft.status).toBe('pending_confirmation');
      expect(invoiceDraft.subtotal_paise).toBe(2500000);
      expect(invoiceDraft.gst_breakdown.cgst_paise).toBe(225000);
      expect(invoiceDraft.gst_breakdown.sgst_paise).toBe(225000);
      expect(invoiceDraft.total_paise).toBe(2950000); // ₹29,500.00

      // Confirm the invoice
      const confirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: {
              confirmation_token: invoiceDraft.confirmation_token,
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(confirmRes.status).toBe(200);
      const confirm = JSON.parse(confirmRes.data.result.content[0].text);
      expect(confirm.status).toBe('executed');
      expect(confirm.action_type).toBe('create_invoice');
      expect(confirm.human_summary).toContain('KAN/2026-27/');
    });

    it('adversarial test: concurrent idempotency requests for separate drafts with same key cannot both execute', async () => {
      // Create Draft 1 (amount ₹500)
      const draft1Res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 110,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 50000,
              description: 'Expense Draft 1',
              payment_method: 'upi',
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      const token1 = JSON.parse(draft1Res.data.result.content[0].text).confirmation_token;

      // Create Draft 2 (amount ₹750)
      const draft2Res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 111,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 75000,
              description: 'Expense Draft 2',
              payment_method: 'upi',
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      const token2 = JSON.parse(draft2Res.data.result.content[0].text).confirmation_token;

      const sharedKey = `race_key_${Date.now()}`;

      // Execute both confirmations concurrently with the same idempotency key
      const [res1, res2] = await Promise.all([
        mcpPost(
          {
            jsonrpc: '2.0',
            id: 112,
            method: 'tools/call',
            params: {
              name: 'confirm_action',
              arguments: { confirmation_token: token1, idempotency_key: sharedKey },
            },
          },
          { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
        ),
        mcpPost(
          {
            jsonrpc: '2.0',
            id: 113,
            method: 'tools/call',
            params: {
              name: 'confirm_action',
              arguments: { confirmation_token: token2, idempotency_key: sharedKey },
            },
          },
          { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
        ),
      ]);

      const isRes1Success = res1.status === 200 && !res1.data.result?.isError && !res1.data.error;
      const isRes2Success = res2.status === 200 && !res2.data.result?.isError && !res2.data.error;

      // Exactly ONE request must succeed; the conflicting request must be rejected!
      expect(isRes1Success !== isRes2Success).toBe(true);

      const failedRes = isRes1Success ? res2 : res1;
      const err = extractToolError(failedRes);
      expect(err).toMatch(/IDEMPOTENCY_CONFLICT|IDEMPOTENCY_IN_FLIGHT/);
    });

    it('accounting test: inter-state expense calculates IGST and debits Input IGST Credit account', async () => {
      // Vendor from Karnataka (29), business in TN (33)
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 120,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 118000, // ₹1,180.00 gross (₹1,000 + 18% IGST)
              description: 'Software development consultation from Bangalore',
              payment_method: 'bank_transfer',
              vendor_name: 'Bangalore Tech LLP',
              vendor_gstin: '29ABCDE1234F1Z5',
              vendor_state_code: '29',
              is_itc_claimed: true,
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      const draft = JSON.parse(draftRes.data.result.content[0].text);
      expect(draft.gst_breakdown.is_inter_state).toBe(true);
      expect(draft.gst_breakdown.igst_paise).toBe(18000);
      expect(draft.gst_breakdown.cgst_paise).toBe(0);
      expect(draft.gst_breakdown.sgst_paise).toBe(0);

      // Confirm
      const confirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 121,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: { confirmation_token: draft.confirmation_token },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(confirmRes.status).toBe(200);
      const confirm = JSON.parse(confirmRes.data.result.content[0].text);
      expect(confirm.status).toBe('executed');

      // Verify double-entry ledger lines
      const explainRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 122,
          method: 'tools/call',
          params: {
            name: 'explain_transaction',
            arguments: { transaction_id: confirm.entity_id, entity_type: 'expense' },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      const explain = JSON.parse(explainRes.data.result.content[0].text);
      expect(explain.journal_entry.is_balanced).toBe(true);
      const lines = explain.journal_entry.lines;
      const igstLine = lines.find((l: { account_name: string }) =>
        l.account_name.includes('Input IGST'),
      );
      expect(igstLine).toBeDefined();
      expect(igstLine.debit_formatted).toBe('₹180.00');
    });

    it('accounting test: blocked ITC (Section 17(5)) capitalizes tax into expense cost without debiting tax asset accounts', async () => {
      // Food / personal expense with ineligible ITC
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 123,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 236000, // ₹2,360.00 gross
              description: 'Client buffet dinner at Grand Hotel',
              payment_method: 'card',
              vendor_name: 'Grand Hotel Chennai',
              vendor_gstin: '33AABCC1234A1Z1',
              vendor_state_code: '33',
              is_itc_claimed: false, // Blocked ITC
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      const draft = JSON.parse(draftRes.data.result.content[0].text);
      expect(draft.is_itc_claimed).toBe(false);

      // Confirm
      const confirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 124,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: { confirmation_token: draft.confirmation_token },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      expect(confirmRes.status).toBe(200);
      const confirm = JSON.parse(confirmRes.data.result.content[0].text);
      expect(confirm.status).toBe('executed');

      // Verify double-entry ledger lines:
      // Expense account must be debited for FULL ₹2,360.00.
      // NO lines for Input CGST, Input SGST, or Input IGST credit asset accounts.
      const explainRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 125,
          method: 'tools/call',
          params: {
            name: 'explain_transaction',
            arguments: { transaction_id: confirm.entity_id, entity_type: 'expense' },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );

      const explain = JSON.parse(explainRes.data.result.content[0].text);
      expect(explain.journal_entry.is_balanced).toBe(true);
      const lines = explain.journal_entry.lines;

      const expenseLine = lines.find((l: { account_name: string }) =>
        l.account_name.includes('Expense'),
      );
      expect(expenseLine.debit_formatted).toBe('₹2,360.00'); // Full gross capitalized

      const inputTaxLine = lines.find((l: { account_name: string }) =>
        l.account_name.includes('Input'),
      );
      expect(inputTaxLine).toBeUndefined(); // Zero credit claimed on balance sheet!
    });

    it('workflow & period lock test: executes multi-step month close and locks books against future postings', async () => {
      // Clean up any existing report from prior test runs for test month 7 / 2026
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, 7),
            eq(monthEndReports.year, 2026),
          ),
        );

      // Step 1: scan for July 2026 (month 7)
      const scanRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 130,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { step: 'scan', month: 7, year: 2026 },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      expect(scanRes.status).toBe(200);
      const scan = JSON.parse(scanRes.data.result.content[0].text);
      expect(scan.status).toBe('scan_complete');
      expect(scan.step).toBe('scan');

      // Step 2: categorise with persisted updates
      const catRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 131,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { step: 'categorise', month: 7, year: 2026 },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      expect(catRes.status).toBe(200);
      const cat = JSON.parse(catRes.data.result.content[0].text);
      expect(cat.status).toBe('categorisation_verified');

      // Step 3: reconcile with actual double-entry balance check
      const recRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 132,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { step: 'reconcile', month: 7, year: 2026 },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      expect(recRes.status).toBe(200);
      const rec = JSON.parse(recRes.data.result.content[0].text);
      expect(rec.status).toBe('reconciliation_verified');
      expect(rec.ledger_balanced).toBe(true);

      // Step 4: prepare_close returns confirmation token
      const prepRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 133,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { step: 'prepare_close', month: 7, year: 2026 },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      expect(prepRes.status).toBe(200);
      const prep = JSON.parse(prepRes.data.result.content[0].text);
      expect(prep.status).toBe('pending_confirmation');
      expect(prep.confirmation_token).toBeDefined();

      // Step 5: Confirm close_month locks the books
      const closeConfirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 134,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: { confirmation_token: prep.confirmation_token },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      expect(closeConfirmRes.status).toBe(200);
      const closeConfirm = JSON.parse(closeConfirmRes.data.result.content[0].text);
      expect(closeConfirm.status).toBe('executed');
      expect(closeConfirm.human_summary).toContain('officially closed and books locked');

      // Step 6: Post-close mutation lock verification - reject posting an expense into July 2026
      const blockedExpenseRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 135,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 50000,
              description: 'Late expense for closed July 2026',
              payment_method: 'upi',
              date: '2026-07-15T10:00:00Z',
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      expect(extractToolError(blockedExpenseRes)).toContain('PERIOD_CLOSED');

      // Step 7: Post-close mutation lock verification - reject issuing an invoice for July 2026
      const blockedInvoiceRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 136,
          method: 'tools/call',
          params: {
            name: 'create_invoice',
            arguments: {
              customer_name: 'Ravi Traders',
              place_of_supply_state_code: '33',
              due_date: '2026-08-31',
              issue_date: '2026-07-20T10:00:00Z',
              line_items: [
                {
                  description: 'Late Invoice',
                  quantity: 1,
                  unit_price_paise: 100000,
                  gst_rate_bps: 1800,
                },
              ],
            },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      expect(extractToolError(blockedInvoiceRes)).toContain('PERIOD_CLOSED');

      // Step 8: Re-close attempt returns already_closed
      const recloseRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 137,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { step: 'scan', month: 7, year: 2026 },
          },
        },
        { sessionId: activeSessionId, protocolVersion: '2025-11-25' },
      );
      const reclose = JSON.parse(recloseRes.data.result.content[0].text);
      expect(reclose.status).toBe('already_closed');
    });
  });

  // -------------------------------------------------------------
  // 4. Deterministic Read Tools & Intelligence
  // -------------------------------------------------------------
  describe('Deterministic Read Queries', () => {
    let readSessionId: string;

    beforeAll(async () => {
      const init = await mcpPost({
        jsonrpc: '2.0',
        id: 30,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-runner', version: '1.0.0' },
        },
      });
      readSessionId = init.sessionId!;
      await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { sessionId: readSessionId, protocolVersion: '2025-11-25' },
      );
    });

    it('list_outstanding_invoices returns receivables with ageing buckets', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 31,
          method: 'tools/call',
          params: {
            name: 'list_outstanding_invoices',
            arguments: {},
          },
        },
        { sessionId: readSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      const data = JSON.parse(res.data.result.content[0].text);
      expect(data.total_outstanding_paise).toBeGreaterThan(0);
      expect(data.ageing_buckets).toBeDefined();
      expect(data.invoices_list).toBeInstanceOf(Array);
    });

    it('get_gst_liability returns Section 49 set-off and disclaimer', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 32,
          method: 'tools/call',
          params: {
            name: 'get_gst_liability',
            arguments: { month: 9, year: 2026 },
          },
        },
        { sessionId: readSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      const data = JSON.parse(res.data.result.content[0].text);
      expect(data.output_tax).toBeDefined();
      expect(data.estimated_itc).toBeDefined();
      expect(data.net_payable).toBeDefined();
      expect(data.statutory_disclaimer).toContain('Chartered Accountant & Tax Professional Notice');
    });

    it('cashflow_summary returns realized cash movements', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 33,
          method: 'tools/call',
          params: {
            name: 'cashflow_summary',
            arguments: {
              from_date: '2026-08-01',
              to_date: '2026-09-30',
            },
          },
        },
        { sessionId: readSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      const data = JSON.parse(res.data.result.content[0].text);
      expect(data.inflow_paise).toBeDefined();
      expect(data.outflow_paise).toBeDefined();
      expect(data.net_cashflow_paise).toBeDefined();
      expect(data.major_movements).toBeInstanceOf(Array);
    });

    it('get_business_briefing returns concise voice summary (<= 2 sentences)', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 34,
          method: 'tools/call',
          params: {
            name: 'get_business_briefing',
            arguments: { timeframe: 'today' },
          },
        },
        { sessionId: readSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      const data = JSON.parse(res.data.result.content[0].text);
      expect(data.voice_summary).toBeTruthy();

      // Ensure voice summary is <= 2 sentences for Alexa+ TTS
      const sentences = data.voice_summary
        .split(/(?<=[^0-9])[.?!]+(?:\s+|$)/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
      expect(sentences.length).toBeLessThanOrEqual(2);
    });

    it('get_audit_history returns serialized logs and intact chain verification', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 35,
          method: 'tools/call',
          params: {
            name: 'get_audit_history',
            arguments: { limit: 10 },
          },
        },
        { sessionId: readSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      const data = JSON.parse(res.data.result.content[0].text);
      expect(data.chain_integrity.error).toBeNull();
      expect(data.chain_integrity.is_valid).toBe(true);
      expect(data.logs.length).toBeGreaterThan(0);
      expect(data.logs[0].sequence_number).toBeDefined();
      expect(data.logs[0].entry_hash).toHaveLength(64);
    });
  });

  // -------------------------------------------------------------
  // 5. Cross-Tenant Rejection & Boundary Tests
  // -------------------------------------------------------------
  describe('Cross-Tenant Isolation Enforcement', () => {
    let tenant1SessionId: string;
    let tenant2SessionId: string;

    beforeAll(async () => {
      // Connect as Tenant 1
      const init1 = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 39,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'tenant1-cross-client', version: '1.0.0' },
          },
        },
        { token: validToken },
      );
      tenant1SessionId = init1.sessionId!;
      await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        {
          token: validToken,
          sessionId: tenant1SessionId,
          protocolVersion: '2025-11-25',
        },
      );

      // Connect as Tenant 2
      const init2 = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 40,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'tenant2-client', version: '1.0.0' },
          },
        },
        { token: tenant2Secret },
      );
      tenant2SessionId = init2.sessionId!;
      await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        {
          token: tenant2Secret,
          sessionId: tenant2SessionId,
          protocolVersion: '2025-11-25',
        },
      );
    });

    it('rejects attempt by Tenant 2 to access Tenant 1 customer', async () => {
      // Tenant 1 customer ID: 'c0000000-0000-0000-0000-000000000001'
      const crossCall = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 41,
          method: 'tools/call',
          params: {
            name: 'create_invoice',
            arguments: {
              customer_id: 'c0000000-0000-0000-0000-000000000001',
              place_of_supply_state_code: '33',
              due_date: '2026-10-31',
              line_items: [
                {
                  description: 'Malicious Cross-Tenant Attempt',
                  quantity: 1,
                  unit_price_paise: 100000,
                  gst_rate_bps: 1800,
                },
              ],
            },
          },
        },
        {
          token: tenant2Secret,
          sessionId: tenant2SessionId,
          protocolVersion: '2025-11-25',
        },
      );

      expect(extractToolError(crossCall)).toContain('CUSTOMER_NOT_FOUND');
    });

    it('rejects attempt by Tenant 2 to confirm a Tenant 1 token', async () => {
      // 1. Tenant 1 creates a draft
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 50000,
              description: 'Tenant 1 Expense',
              payment_method: 'upi',
            },
          },
        },
        {
          token: validToken,
          sessionId: tenant1SessionId,
          protocolVersion: '2025-11-25',
        },
      );

      const draft = JSON.parse(draftRes.data.result.content[0].text);
      const tenant1Token = draft.confirmation_token;

      // 2. Tenant 2 attempts to confirm it
      const hijackAttempt = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 43,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: {
              confirmation_token: tenant1Token,
            },
          },
        },
        {
          token: tenant2Secret,
          sessionId: tenant2SessionId,
          protocolVersion: '2025-11-25',
        },
      );

      expect(extractToolError(hijackAttempt)).toContain('TENANT_MISMATCH');
    });
  });

  // -------------------------------------------------------------
  // 6. Resources & Prompts Read Verification
  // -------------------------------------------------------------
  describe('Resources & Prompts Reading', () => {
    let testSessionId: string;

    beforeAll(async () => {
      const init = await mcpPost({
        jsonrpc: '2.0',
        id: 50,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-runner', version: '1.0.0' },
        },
      });
      testSessionId = init.sessionId!;
      await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
    });

    it('reads kanakku://business-summary resource', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 51,
          method: 'resources/read',
          params: { uri: 'kanakku://business-summary' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      const text = res.data.result.contents[0].text;
      const json = JSON.parse(text);
      expect(json.name).toBe('Kanakku Creative Services');
      expect(json.gstin).toBe('33AAAAK1234A1Z5');
      expect(json.total_outstanding_receivables).toBeTruthy();
    });

    it('reads kanakku://chart-of-accounts resource', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 52,
          method: 'resources/read',
          params: { uri: 'kanakku://chart-of-accounts' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      const text = res.data.result.contents[0].text;
      const json = JSON.parse(text);
      expect(json.chart_of_accounts.length).toBeGreaterThan(0);
      expect(json.chart_of_accounts.some((a: { code: string }) => a.code === '1110')).toBe(true);
    });

    it('reads kanakku://business-memory resource with tenant isolation', async () => {
      const t1MemId = 'b1000000-0000-0000-0000-000000000099';
      const t2MemId = 'b2000000-0000-0000-0000-000000000099';

      await db
        .insert(businessMemory)
        .values({
          id: t1MemId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          category: 'preference',
          entityKey: 'vendor:v-t1-test',
          memoryValue: { notes: 'Tenant 1 private note' },
          confidence: '1.0',
          source: 'manual',
          isActive: true,
        })
        .onConflictDoNothing();

      await db
        .insert(businessMemory)
        .values({
          id: t2MemId,
          businessId: tenant2BizId,
          category: 'preference',
          entityKey: 'vendor:v-t2-test',
          memoryValue: { notes: 'Tenant 2 private note' },
          confidence: '1.0',
          source: 'manual',
          isActive: true,
        })
        .onConflictDoNothing();

      try {
        // Read as Tenant 1
        const resT1 = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 521,
            method: 'resources/read',
            params: { uri: 'kanakku://business-memory' },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        expect(resT1.status).toBe(200);
        const memsT1 = JSON.parse(resT1.data.result.contents[0].text);
        const keysT1 = memsT1.map((m: { entityKey: string }) => m.entityKey);
        expect(keysT1).toContain('vendor:v-t1-test');
        expect(keysT1).not.toContain('vendor:v-t2-test');

        // Read as Tenant 2
        const initT2 = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 522,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'test-runner-t2', version: '1.0.0' },
            },
          },
          { token: tenant2Secret },
        );
        const t2SessionId = initT2.sessionId!;
        await mcpPost(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { sessionId: t2SessionId, protocolVersion: '2025-11-25', token: tenant2Secret },
        );

        const resT2 = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 523,
            method: 'resources/read',
            params: { uri: 'kanakku://business-memory' },
          },
          { sessionId: t2SessionId, protocolVersion: '2025-11-25', token: tenant2Secret },
        );

        expect(resT2.status).toBe(200);
        const memsT2 = JSON.parse(resT2.data.result.contents[0].text);
        const keysT2 = memsT2.map((m: { entityKey: string }) => m.entityKey);
        expect(keysT2).toContain('vendor:v-t2-test');
        expect(keysT2).not.toContain('vendor:v-t1-test');
      } finally {
        await db.delete(businessMemory).where(eq(businessMemory.id, t1MemId));
        await db.delete(businessMemory).where(eq(businessMemory.id, t2MemId));
      }
    });

    it('retrieves month_end_close prompt', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 53,
          method: 'prompts/get',
          params: {
            name: 'month_end_close',
            arguments: { month: '9', year: '2026' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      expect(res.data.result.messages[0].content.text).toContain('close_month');
      expect(res.data.result.messages[0].content.text).toContain('scan');
    });

    it('retrieves weekly_briefing prompt', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 54,
          method: 'prompts/get',
          params: {
            name: 'weekly_briefing',
            arguments: {},
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      expect(res.data.result.messages[0].content.text).toContain('weekly');
    });
  });

  // -------------------------------------------------------------
  // Phase 3: MCP Apps Extension (ui:// resources & capability negotiation)
  // -------------------------------------------------------------
  describe('Phase 3: MCP Apps Extension (ui:// resources & capability negotiation)', () => {
    let testSessionId: string;

    beforeAll(async () => {
      const init = await mcpPost({
        jsonrpc: '2.0',
        id: 9000,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {
            extensions: { [MCP_APPS_EXTENSION]: {} },
          },
          clientInfo: { name: 'phase3-ui-client', version: '1.0.0' },
        },
      });
      expect(init.status).toBe(200);
      expect(init.sessionId).toBeTruthy();
      testSessionId = init.sessionId!;
      await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
    });

    it('health check advertises MCP Apps UI capability and extension identifier, CORS exposes X-Mcp-Ui-Support', async () => {
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const health = await healthRes.json();
      expect(health.capabilities?.mcp_apps_ui).toBe(true);
      expect(health.capabilities?.app_bridge).toBe(true);
      expect(health.capabilities?.extensions?.[MCP_APPS_EXTENSION]).toBeDefined();

      const optionsRes = await fetch(`${baseUrl}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000' },
      });
      expect(optionsRes.status).toBe(204);
      const exposedHeaders = optionsRes.headers.get('access-control-expose-headers') || '';
      expect(exposedHeaders).toContain('X-Mcp-Ui-Support');
    });

    it('tools/list includes _meta.ui.resourceUri for all UI-enabled tools and app visibility for action tools', async () => {
      const toolsRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9001,
          method: 'tools/list',
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(toolsRes.status).toBe(200);
      const tools = toolsRes.data.result.tools as Array<{
        name: string;
        _meta?: { ui?: { resourceUri?: string; visibility?: string[] } };
      }>;

      // Verify UI-to-tool linkages
      const expenseTool = tools.find((t) => t.name === 'record_expense');
      expect(expenseTool?._meta?.ui?.resourceUri).toBe('ui://cards/expense-draft');

      const invoiceTool = tools.find((t) => t.name === 'create_invoice');
      expect(invoiceTool?._meta?.ui?.resourceUri).toBe('ui://cards/invoice-draft');

      const gstTool = tools.find((t) => t.name === 'get_gst_liability');
      expect(gstTool?._meta?.ui?.resourceUri).toBe('ui://cards/gst-liability');

      const closeTool = tools.find((t) => t.name === 'close_month');
      expect(closeTool?._meta?.ui?.resourceUri).toBe('ui://cards/month-end-summary');

      const briefingTool = tools.find((t) => t.name === 'get_business_briefing');
      expect(briefingTool?._meta?.ui?.resourceUri).toBe('ui://cards/business-briefing');

      // Verify action tool visibility for MCP Apps iframe
      const confirmTool = tools.find((t) => t.name === 'confirm_action');
      expect(confirmTool?._meta?.ui?.visibility).toContain('app');
      expect(confirmTool?._meta?.ui?.visibility).toContain('model');

      const cancelTool = tools.find((t) => t.name === 'cancel_action');
      expect(cancelTool?._meta?.ui?.visibility).toContain('app');
      expect(cancelTool?._meta?.ui?.visibility).toContain('model');
    });

    it('lists all MCP Apps ui:// resource templates via resources/templates/list', async () => {
      const tplRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9002,
          method: 'resources/templates/list',
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(tplRes.status).toBe(200);
      const templates = tplRes.data.result.resourceTemplates;
      const uriTemplates = templates.map((t: { uriTemplate: string }) => t.uriTemplate);
      expect(uriTemplates).toContain('ui://cards/gst-liability');
      expect(uriTemplates).toContain('ui://cards/business-briefing');
      expect(uriTemplates).toContain('ui://cards/invoice-draft');
      expect(uriTemplates).toContain('ui://cards/invoice-draft/{token}');
      expect(uriTemplates).toContain('ui://cards/expense-draft');
      expect(uriTemplates).toContain('ui://cards/expense-draft/{token}');
      expect(uriTemplates).toContain('ui://cards/month-end-summary');
      expect(uriTemplates).toContain('ui://cards/month-end-summary/{month}/{year}');
    });

    it('reads static ui://cards/gst-liability card with text/html;profile=mcp-app MIME type', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9003,
          method: 'resources/read',
          params: { uri: 'ui://cards/gst-liability' },
        },
        {
          sessionId: testSessionId,
          protocolVersion: '2025-11-25',
          extraHeaders: { 'X-Mcp-Ui-Support': 'true' },
        },
      );

      expect(res.status).toBe(200);
      expect(res.data.result.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
      const html = res.data.result.contents[0].text;
      expect(html).toContain('GST Liability');
      expect(html).toContain('aria-label="GST Liability Summary Card"');
      expect(html).toContain('Section 49');
      expect(html).toContain('callHostTool');
    });

    it('reads static ui://cards/business-briefing card with text/html;profile=mcp-app MIME type', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9004,
          method: 'resources/read',
          params: { uri: 'ui://cards/business-briefing' },
        },
        {
          sessionId: testSessionId,
          protocolVersion: '2025-11-25',
          extraHeaders: { 'X-Mcp-Ui-Support': 'true' },
        },
      );

      expect(res.status).toBe(200);
      expect(res.data.result.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
      const html = res.data.result.contents[0].text;
      expect(html).toContain('Executive Financial Briefing');
      expect(html).toContain('Active Receivables');
      expect(html).toContain('callHostTool');
    });

    it('reads static generic ui://cards/invoice-draft and ui://cards/expense-draft cards', async () => {
      const invRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9005,
          method: 'resources/read',
          params: { uri: 'ui://cards/invoice-draft' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(invRes.status).toBe(200);
      expect(invRes.data.result.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);

      const expRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9006,
          method: 'resources/read',
          params: { uri: 'ui://cards/expense-draft' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(expRes.status).toBe(200);
      expect(expRes.data.result.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
    });

    it('exercises complete MCP Apps app-to-host confirm_action flow following tool-metadata URI through running server', async () => {
      // 1. Host queries tools/list to discover the tool and its linked UI resource URI
      const toolsRes = await mcpPost(
        { jsonrpc: '2.0', id: 9007, method: 'tools/list' },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(toolsRes.status).toBe(200);
      const invoiceTool = (
        toolsRes.data.result.tools as Array<{
          name: string;
          _meta?: { ui?: { resourceUri?: string } };
        }>
      ).find((t) => t.name === 'create_invoice');
      expect(invoiceTool?._meta?.ui?.resourceUri).toBe('ui://cards/invoice-draft');
      const toolMetaUri = invoiceTool!._meta!.ui!.resourceUri!;

      // 2. Caller executes create_invoice tool on running MCP server
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9008,
          method: 'tools/call',
          params: {
            name: 'create_invoice',
            arguments: {
              customer_name: 'Ravi Traders',
              place_of_supply_state_code: '33',
              due_date: '2026-10-31',
              issue_date: '2026-10-05T10:00:00Z',
              line_items: [
                {
                  description: 'Brand Identity Design',
                  quantity: 1,
                  unit_price_paise: 500000,
                  gst_rate_bps: 1800,
                },
              ],
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(draftRes.status).toBe(200);
      const draft = JSON.parse(draftRes.data.result.content[0].text);
      expect(draft.confirmation_token).toBeTruthy();

      // 3. Host fetches the tool-metadata-linked UI resource (ui://cards/invoice-draft) from the running server
      const cardRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9009,
          method: 'resources/read',
          params: { uri: toolMetaUri },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(cardRes.status).toBe(200);
      expect(cardRes.data.result.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
      const html = cardRes.data.result.contents[0].text;
      expect(html).toContain('Invoice Draft');
      expect(html).toContain('id="btn-confirm"');
      expect(html).toContain('id="btn-cancel"');
      expect(html).toContain('ui/initialize');
      expect(html).toContain('ui/notifications/tool-result');

      // 4. Host sets up genuine MCP Apps Browser Host and renders the delivered card in a real DOM environment
      class MockBrowserWindow {
        public listeners: Array<(event: { data: any; source?: any }) => void> = [];
        public peer?: any;

        addEventListener(type: string, listener: (event: any) => void) {
          if (type === 'message') {
            this.listeners.push(listener);
          }
        }

        removeEventListener(type: string, listener: (event: any) => void) {
          if (type === 'message') {
            this.listeners = this.listeners.filter((l) => l !== listener);
          }
        }

        postMessage(message: any, _origin: string = '*') {
          const evt = { data: message, source: this.peer };
          setTimeout(() => {
            for (const l of this.listeners) {
              l(evt);
            }
          }, 0);
        }
      }

      const hostWindow = new MockBrowserWindow();
      const browserHost = new McpAppsBrowserHost({
        serverUrl: baseUrl,
        authToken: validToken,
        sessionId: testSessionId,
      });
      browserHost.attach(hostWindow);

      // Execute the delivered card HTML and its actual embedded script inside a real DOM environment
      let cardWindow: any;
      const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        beforeParse(window) {
          window.parent = {
            postMessage: (msg: any, origin: string = '*') => {
              hostWindow.postMessage(msg, origin);
            },
          } as any;
          hostWindow.peer = window as any;
          cardWindow = window;
        },
      });

      // Wait for card script to perform handshake: ui/initialize -> host responds -> ui/notifications/initialized
      await new Promise((r) => setTimeout(r, 60));

      // Deliver tool result notification to the card window via host
      browserHost.sendToolResult(draft, cardWindow);

      // Wait for card script's handleToolResult to process tool result and update the DOM
      await new Promise((r) => setTimeout(r, 60));

      // Assert that the card's ACTUAL script hydrated the DOM from the tool result
      expect(cardWindow.currentToken).toBe(draft.confirmation_token);
      expect(dom.window.document.getElementById('card-invoice-number')?.textContent).toBe(
        draft.invoice_number,
      );
      expect(dom.window.document.getElementById('card-recipient')?.textContent).toBe(
        'Ravi Traders',
      );
      expect(dom.window.document.getElementById('card-total')?.textContent).toBe(
        draft.total_formatted,
      );
      const confirmBtn = dom.window.document.getElementById(
        'btn-confirm',
      ) as HTMLButtonElement | null;
      expect(confirmBtn?.disabled).toBe(false);

      // 5. User clicks Confirm in the card: the card's ACTUAL script calls window.handleConfirm()
      // which posts tools/call to window.parent, browserHost proxies over HTTP to /mcp, and returns response to card
      confirmBtn?.click();

      // Wait for async confirmation roundtrip
      let attempts = 0;
      while (
        attempts < 30 &&
        dom.window.document.getElementById('card-badge')?.textContent !== 'Confirmed & Posted'
      ) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }

      expect(dom.window.document.getElementById('card-badge')?.textContent).toBe(
        'Confirmed & Posted',
      );

      // 6. Verify draft is consumed in database and invoice exists
      const [consumed] = await db
        .select()
        .from(pendingConfirmations)
        .where(eq(pendingConfirmations.id, draft.draft_id));
      expect(consumed?.consumedAt).not.toBeNull();

      // Clean up test invoice
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, draft.draft_id));
      browserHost.detach();
    });

    it('guarantees approval preview reliability under multiple drafts: generic card completely hydrates only the exact confirmed draft', async () => {
      // 1. User creates Draft 1 (Anand Enterprises, 1 laptop, ₹5,900, Inter-state Karnataka -> IGST)
      const draft1Res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9020,
          method: 'tools/call',
          params: {
            name: 'create_invoice',
            arguments: {
              customer_name: 'Anand Enterprises',
              place_of_supply_state_code: '29', // Inter-state Karnataka -> IGST
              due_date: '2026-11-15',
              line_items: [
                {
                  description: 'UltraBook Laptop Pro',
                  quantity: 1,
                  unit_price_paise: 500000,
                  gst_rate_bps: 1800,
                },
              ],
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(draft1Res.status).toBe(200);
      const draft1 = JSON.parse(draft1Res.data.result.content[0].text);
      expect(draft1.customer_name).toBe('Anand Enterprises');

      // 2. User creates Draft 2 (Meena Textiles, 2 cloud compute nodes, ₹23,600, Intra-state Tamil Nadu -> CGST+SGST)
      const draft2Res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9021,
          method: 'tools/call',
          params: {
            name: 'create_invoice',
            arguments: {
              customer_name: 'Meena Textiles',
              place_of_supply_state_code: '33', // Intra-state Tamil Nadu -> CGST+SGST
              due_date: '2026-11-20',
              line_items: [
                {
                  description: 'Dedicated Cloud Compute Node',
                  quantity: 2,
                  unit_price_paise: 1000000,
                  gst_rate_bps: 1800,
                },
              ],
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(draft2Res.status).toBe(200);
      const draft2 = JSON.parse(draft2Res.data.result.content[0].text);
      expect(draft2.customer_name).toBe('Meena Textiles');

      // 3. Host reads generic UI card resource ui://cards/invoice-draft from running server
      const cardRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9022,
          method: 'resources/read',
          params: { uri: 'ui://cards/invoice-draft' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(cardRes.status).toBe(200);
      const html = cardRes.data.result.contents[0].text;

      // Assert that generic template starts clean and does not display Draft 1's items or recipient
      expect(html).not.toContain('UltraBook Laptop Pro');
      expect(html).not.toContain('Anand Enterprises');
      expect(html).toContain('Awaiting Draft Details...');

      // 4. Test dynamic DOM hydration with the card's ACTUAL script:
      let cardWin: any;
      const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        beforeParse(window) {
          window.parent = { postMessage: () => {} } as any;
          cardWin = window;
        },
      });

      cardWin.handleToolResult(draft2);

      // Verify that every element strictly reflects Draft 2 using safe DOM properties:
      expect(cardWin.currentToken).toBe(draft2.confirmation_token);
      expect(dom.window.document.getElementById('card-recipient')?.textContent).toBe(
        'Meena Textiles',
      );
      const itemsEl = dom.window.document.getElementById('card-items');
      expect(itemsEl?.textContent).toContain('Dedicated Cloud Compute Node');
      expect(itemsEl?.textContent).not.toContain('UltraBook Laptop Pro');
      const taxesEl = dom.window.document.getElementById('card-taxes');
      expect(taxesEl?.textContent).toContain('CGST:');
      expect(taxesEl?.textContent).not.toContain('IGST:');
      expect(dom.window.document.getElementById('card-total')?.textContent).toBe(
        draft2.total_formatted,
      );
      expect(dom.window.document.getElementById('card-disclaimer')?.textContent).toContain(
        draft2.confirmation_token.slice(0, 10),
      );
      const btn = dom.window.document.getElementById('btn-confirm') as HTMLButtonElement | null;
      expect(btn?.disabled).toBe(false);

      // 5. Confirm Draft 2
      const confirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9023,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: {
              confirmation_token: draft2.confirmation_token,
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(confirmRes.status).toBe(200);

      // 6. Verify database: Draft 2 is consumed, Draft 1 remains UNCONSUMED and pending
      const [d2Db] = await db
        .select()
        .from(pendingConfirmations)
        .where(eq(pendingConfirmations.id, draft2.draft_id));
      expect(d2Db?.consumedAt).not.toBeNull();

      const [d1Db] = await db
        .select()
        .from(pendingConfirmations)
        .where(eq(pendingConfirmations.id, draft1.draft_id));
      expect(d1Db?.consumedAt).toBeNull();

      // Clean up Draft 1
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, draft1.draft_id));
    });

    it('SECURITY REGRESSION: prevents HTML/XSS injection through draft line descriptions and ITC reasons', async () => {
      // 1. Create a draft with malicious script/img payload
      const xssDraftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9088,
          method: 'tools/call',
          params: {
            name: 'create_invoice',
            arguments: {
              customer_name: 'Anand Enterprises',
              place_of_supply_state_code: '33',
              due_date: '2026-12-31',
              line_items: [
                {
                  description:
                    '<img src=x onerror="window.xssExecuted=true"><script>window.scriptExecuted=true</script>',
                  hsn_sac: '998314',
                  quantity: 1,
                  unit_price_paise: 100000,
                  gst_rate_bps: 1800,
                },
              ],
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const xssDraft = JSON.parse(xssDraftRes.data.result.content[0].text);
      expect(xssDraft.confirmation_token).toBeDefined();

      // 2. Fetch the generic card HTML
      const cardRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9089,
          method: 'resources/read',
          params: { uri: 'ui://cards/invoice-draft' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const html = cardRes.data.result.contents[0].text;

      // 3. Render in JSDOM with script execution enabled
      let invoiceCardWindow: any;
      const invoiceDom = new JSDOM(html, {
        runScripts: 'dangerously',
        beforeParse(window) {
          window.parent = { postMessage: () => {} } as any;
          invoiceCardWindow = window;
        },
      });

      // 4. Hydrate with the malicious draft
      invoiceCardWindow.handleToolResult(xssDraft);

      // 5. Verify NO malicious scripts or image onerror handlers executed
      expect(invoiceCardWindow.xssExecuted).toBeUndefined();
      expect(invoiceCardWindow.scriptExecuted).toBeUndefined();

      // 6. Verify content was inserted safely through DOM textContent
      const itemsEl = invoiceDom.window.document.getElementById('card-items');
      const firstRowDesc = itemsEl?.querySelector('td');
      expect(firstRowDesc?.textContent).toBe(
        '<img src=x onerror="window.xssExecuted=true"><script>window.scriptExecuted=true</script>',
      );
      // Verify no img or script child elements exist in card-items
      expect(itemsEl?.getElementsByTagName('img').length).toBe(0);
      expect(itemsEl?.getElementsByTagName('script').length).toBe(0);

      // 7. Verify confirmation token was not accessed or exfiltrated by any injected script
      expect(invoiceCardWindow.currentToken).toBe(xssDraft.confirmation_token);

      // 8. Now test the expense card for blocked ITC reason injection
      const expenseCardRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9090,
          method: 'resources/read',
          params: { uri: 'ui://cards/expense-draft' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      const expenseHtml = expenseCardRes.data.result.contents[0].text;

      let expenseCardWindow: any;
      const expenseDom = new JSDOM(expenseHtml, {
        runScripts: 'dangerously',
        beforeParse(window) {
          window.parent = { postMessage: () => {} } as any;
          expenseCardWindow = window;
        },
      });

      expenseCardWindow.handleToolResult({
        confirmation_token: 'test-token-itc',
        is_itc_eligible: false,
        itc_block_reason: '<img src=x onerror="window.itcXssExecuted=true">Sec 17(5)',
      });

      expect(expenseCardWindow.itcXssExecuted).toBeUndefined();
      const itcEl = expenseDom.window.document.getElementById('card-itc-container');
      expect(itcEl?.getElementsByTagName('img').length).toBe(0);
      expect(itcEl?.textContent).toContain(
        '<img src=x onerror="window.itcXssExecuted=true">Sec 17(5)',
      );

      // Clean up
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, xssDraft.draft_id));
    });

    it('SECURITY REGRESSION: prevents authenticated SSRF via spoofed Host headers on /mcp/app-bridge', async () => {
      // 1. Create a pending draft to confirm
      const expenseDraftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9091,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 50000,
              description: 'SSRF verification test expense',
              payment_method: 'upi',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const draft = JSON.parse(expenseDraftRes.data.result.content[0].text);
      const token = draft.confirmation_token;

      // 2. Make a direct request to /mcp/app-bridge with a spoofed external Host header
      const spoofedHost = 'evil-attacker-destination.internal:9999';
      const bridgeRes = await fetch(`${baseUrl}/mcp/app-bridge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
          Host: spoofedHost,
          'mcp-session-id': testSessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'test-ssrf-bridge',
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: { confirmation_token: token },
          },
        }),
      });

      expect(bridgeRes.status).toBe(200);
      const bridgeJson = await bridgeRes.json();
      expect(bridgeJson.jsonrpc).toBe('2.0');
      expect(bridgeJson.id).toBe('test-ssrf-bridge');
      // The request MUST complete securely against the local server and NOT forward caller token to the spoofed host
      expect(bridgeJson.error).toBeUndefined();
      expect(bridgeJson.result).toBeDefined();

      const [consumed] = await db
        .select()
        .from(pendingConfirmations)
        .where(eq(pendingConfirmations.id, draft.draft_id));
      expect(consumed?.consumedAt).not.toBeNull();
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, draft.draft_id));
    });

    it('serves MCP Apps Host Harness at /apps/harness and rendered card at /apps/render', async () => {
      // Unauthenticated request should be rejected with 401
      const unauthRes = await fetch(`${baseUrl}/apps/harness`);
      expect(unauthRes.status).toBe(401);

      // Authenticated request with Bearer token succeeds
      const harnessRes = await fetch(`${baseUrl}/apps/harness`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(harnessRes.status).toBe(200);
      const harnessHtml = await harnessRes.text();
      expect(harnessHtml).toContain('Kanakku MCP Apps Host Harness');
      expect(harnessHtml).toContain('id="mcp-app-frame"');
      expect(harnessHtml).toContain('tools/call');

      // Verify strict iframe isolation: allow-same-origin is strictly NOT set
      expect(harnessHtml).toContain('sandbox="allow-scripts allow-forms"');
      expect(harnessHtml).not.toContain('allow-same-origin');

      const renderRes = await fetch(`${baseUrl}/apps/render?uri=ui://cards/invoice-draft`);
      expect(renderRes.status).toBe(200);
      expect(renderRes.headers.get('content-type')).toContain('text/html;profile=mcp-app');
      const renderHtml = await renderRes.text();
      expect(renderHtml).toContain('Invoice Draft');
      expect(renderHtml).toContain('id="btn-confirm"');
    });

    it('verifies BROWSER_HOST_LISTENER_SCRIPT contains standard MCP Apps postMessage proxy logic', () => {
      expect(BROWSER_HOST_LISTENER_SCRIPT).toContain("window.addEventListener('message'");
      expect(BROWSER_HOST_LISTENER_SCRIPT).toContain('ui/initialize');
      expect(BROWSER_HOST_LISTENER_SCRIPT).toContain('tools/call');
      expect(BROWSER_HOST_LISTENER_SCRIPT).toContain('fetch(targetUrl');
    });

    it('completes full approval flow end-to-end through the served /apps/harness page with safe serialization and scoping', async () => {
      // 1. Tool creates invoice draft with potentially dangerous script-injection string
      const injectionAttempt = '</script><script>window.harnessPwned=true</script>';
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9020,
          method: 'tools/call',
          params: {
            name: 'create_invoice',
            arguments: {
              customer_name: 'Meena Textiles',
              place_of_supply_state_code: '33',
              due_date: '2026-11-20',
              line_items: [
                {
                  description: `Harness Verification Service ${injectionAttempt}`,
                  quantity: 1,
                  unit_price_paise: 750000,
                  gst_rate_bps: 1800,
                },
              ],
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(draftRes.status).toBe(200);
      const draft = JSON.parse(draftRes.data.result.content[0].text);
      expect(draft.draft_id).toBeTruthy();
      expect(draft.confirmation_token).toBeTruthy();

      // 2. Unauthenticated request to /apps/harness with draft_id MUST be rejected with 401
      const unauthHarnessRes = await fetch(`${baseUrl}/apps/harness?draft_id=${draft.draft_id}`);
      expect(unauthHarnessRes.status).toBe(401);

      // Verify query-parameter auth_token, token, and session_id are strictly rejected with 401
      const queryAuthRes = await fetch(
        `${baseUrl}/apps/harness?auth_token=${validToken}&draft_id=${draft.draft_id}`,
      );
      expect(queryAuthRes.status).toBe(401);

      const querySessionRes = await fetch(
        `${baseUrl}/apps/harness?session_id=${testSessionId}&draft_id=${draft.draft_id}`,
      );
      expect(querySessionRes.status).toBe(401);

      // 3. Authenticated request with session ID and confirmation token strictly in headers (NEVER in URL)
      const harnessUrl = `${baseUrl}/apps/harness?draft_id=${draft.draft_id}`;
      expect(harnessUrl).not.toContain(validToken);
      expect(harnessUrl).not.toContain(draft.confirmation_token);
      expect(harnessUrl).not.toContain(testSessionId);

      const harnessRes = await fetch(harnessUrl, {
        headers: {
          Authorization: `Bearer ${validToken}`,
          'mcp-session-id': testSessionId,
          'x-confirmation-token': draft.confirmation_token,
        },
      });
      expect(harnessRes.status).toBe(200);
      const harnessHtml = await harnessRes.text();

      // Verify iframe sandbox isolation: allow-same-origin MUST NOT be present
      expect(harnessHtml).toContain('sandbox="allow-scripts allow-forms"');
      expect(harnessHtml).not.toContain('allow-same-origin');

      // Verify auth token is NOT leaked into HTML or window
      expect(harnessHtml).not.toContain(validToken);
      expect(harnessHtml).not.toContain('window.MCP_AUTH_TOKEN');

      // Verify safe JSON script context serialization (no raw unescaped script closing tags)
      expect(harnessHtml).toContain('<script type="application/json" id="mcp-harness-config">');
      expect(harnessHtml).not.toContain(injectionAttempt); // Escaped as \u003c/script\u003e
      expect(harnessHtml).toContain(draft.draft_id);
      expect(harnessHtml).toContain(draft.confirmation_token);

      // 4. Fetch the embedded card HTML (from iframe src /apps/render)
      const renderRes = await fetch(`${baseUrl}/apps/render?uri=ui://cards/invoice-draft`);
      expect(renderRes.status).toBe(200);
      const cardHtml = await renderRes.text();

      // 5. Set up parent harness and child card iframe in JSDOM
      const parentDom = new JSDOM(harnessHtml, {
        url: `${baseUrl}/apps/harness`,
        runScripts: 'dangerously',
        beforeParse(window) {
          (window as any).fetch = fetch; // wire node fetch for real network call
        },
      });

      // Verify injection attempt failed: window.harnessPwned was NOT executed
      expect((parentDom.window as any).harnessPwned).toBeUndefined();

      let cardWindow: any;
      const cardDom = new JSDOM(cardHtml, {
        url: `${baseUrl}/apps/render`,
        runScripts: 'dangerously',
        beforeParse(window) {
          cardWindow = window;
          window.parent = {
            postMessage: (msg: any) => {
              // Deliver message from iframe to parent window
              parentDom.window.dispatchEvent(
                new (parentDom.window as any).MessageEvent('message', {
                  data: msg,
                  source: {
                    postMessage: (reply: any) => {
                      // Deliver reply from parent back to iframe
                      if (cardWindow) {
                        cardWindow.dispatchEvent(
                          new (cardWindow as any).MessageEvent('message', {
                            data: reply,
                            origin: parentDom.window.location.origin,
                          }),
                        );
                      }
                    },
                  },
                }),
              );
            },
          } as any;
        },
      });

      // 6. Wire the parent harness window to deliver tool result to iframe
      const iframeElement = parentDom.window.document.getElementById('mcp-app-frame') as any;
      if (iframeElement) {
        Object.defineProperty(iframeElement, 'contentWindow', {
          value: {
            postMessage: (msg: any) => {
              cardWindow.dispatchEvent(
                new (cardWindow as any).MessageEvent('message', {
                  data: msg,
                  origin: parentDom.window.location.origin,
                }),
              );
            },
          },
          configurable: true,
        });
      }

      // 7. Deliver the initial tool-result from the served harness
      parentDom.window.sendToolResult();

      // Wait for hydration
      await new Promise((r) => setTimeout(r, 60));

      // 8. Verify card was populated with draft data and confirmation token
      expect(cardWindow.currentToken).toBe(draft.confirmation_token);
      const totalEl = cardDom.window.document.getElementById('card-total');
      expect(totalEl?.textContent).toContain('8,850');

      // 9. Confirm button is now active with the draft confirmation token! Click #btn-confirm
      const confirmBtn = cardDom.window.document.getElementById('btn-confirm') as HTMLButtonElement;
      expect(confirmBtn).not.toBeNull();
      expect(confirmBtn.disabled).toBe(false);

      // Execute click
      confirmBtn.click();

      // Allow network request from harness to /mcp/app-bridge to complete
      await new Promise((r) => setTimeout(r, 400));

      // 10. Verify card UI updated to confirmed & posted
      const badge = cardDom.window.document.getElementById('card-badge');
      expect(badge?.textContent).toBe('Confirmed & Posted');

      // 11. Verify database state: confirmation consumed
      const [consumed] = await db
        .select()
        .from(pendingConfirmations)
        .where(eq(pendingConfirmations.id, draft.draft_id));
      expect(consumed?.consumedAt).not.toBeNull();

      // Clean up
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, draft.draft_id));
    });

    it('enforces tenant scoping when fetching draft in /apps/harness', async () => {
      // 1. Tool creates draft for authenticated tenant
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9022,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 50000,
              description: 'Tenant Scoping Isolation Test',
              payment_method: 'cash',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      const draft = JSON.parse(draftRes.data.result.content[0].text);

      // 2. Unauthenticated request to /apps/harness is rejected with 401
      const resUnauth = await fetch(`${baseUrl}/apps/harness?draft_id=${draft.draft_id}`);
      expect(resUnauth.status).toBe(401);

      // 3. Requesting a draft with non-existent or other tenant's ID returns initialToolResult: null
      const harnessNonExistent = await fetch(
        `${baseUrl}/apps/harness?draft_id=00000000-0000-0000-0000-000000000000`,
        {
          headers: { Authorization: `Bearer ${validToken}` },
        },
      );
      expect(harnessNonExistent.status).toBe(200);
      const nonExistentHtml = await harnessNonExistent.text();
      expect(nonExistentHtml).toContain('"initialToolResult":null');

      // Clean up
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, draft.draft_id));
    });

    it('verifies rendered card protocol compatibility with official @modelcontextprotocol/ext-apps AppBridge host', async () => {
      // 1. Tool creates expense draft
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9021,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 180000,
              description: 'Official AppBridge Protocol Test Lunch',
              payment_method: 'upi',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      const draft = JSON.parse(draftRes.data.result.content[0].text);

      // 2. Fetch rendered card HTML
      const renderRes = await fetch(`${baseUrl}/apps/render?uri=ui://cards/expense-draft`);
      const cardHtml = await renderRes.text();

      // 3. Connect official AppBridge from @modelcontextprotocol/ext-apps/app-bridge on host side
      const { AppBridge } = await import('@modelcontextprotocol/ext-apps/app-bridge');
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

      const [clientTransport, hostTransport] = InMemoryTransport.createLinkedPair();

      const bridge = new AppBridge(
        undefined,
        { name: 'kanakku-official-host', version: '0.1.0' },
        { serverTools: {} },
      );

      let toolCallReceived: any = null;
      bridge.oncalltool = async (params) => {
        toolCallReceived = params;
        // Route through running server /mcp/app-bridge endpoint
        const forwardRes = await fetch(`${baseUrl}/mcp/app-bridge`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${validToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'official-sdk-call-1',
            method: 'tools/call',
            params,
          }),
        });
        const forwardJson = (await forwardRes.json()) as any;
        return forwardJson.result || { content: [] };
      };

      await bridge.connect(hostTransport);

      // 4. Mount the actual rendered card HTML in JSDOM (testing the actual card script as served)
      let cardWindow: any;
      const cardDom = new JSDOM(cardHtml, {
        url: `${baseUrl}/apps/render`,
        runScripts: 'dangerously',
        beforeParse(window) {
          cardWindow = window;
          window.parent = {
            postMessage: (msg: any) => {
              clientTransport.send(msg);
            },
          } as any;
        },
      });

      // Deliver messages from official host bridge to the rendered card window
      clientTransport.onmessage = (msg: any) => {
        if (cardWindow) {
          cardWindow.dispatchEvent(
            new (cardWindow as any).MessageEvent('message', {
              data: msg,
              origin: `${baseUrl}`,
            }),
          );
        }
      };

      // 5. Verify the actual card window object shipped in the rendered card
      expect(cardWindow.mcpApp).toBeDefined();
      expect(cardWindow.mcpApp.name).toBe('kanakku-ui-card');
      expect(cardWindow.mcpApp.version).toBe('0.1.0');
      expect(cardWindow.mcpApp.protocolVersion).toBe('2026-01-26');
      expect(typeof cardWindow.mcpApp.callServerTool).toBe('function');

      // 6. Host sends tool result using official AppBridge.sendToolResult
      await bridge.sendToolResult({
        confirmation_token: draft.confirmation_token,
        status: 'pending_confirmation',
        vendor: 'Official SDK Bistro',
        amount_formatted: '₹1,800.00',
        description: 'Official AppBridge Protocol Test Lunch',
        payment_method: 'UPI',
      });

      // Allow card to hydrate via postMessage
      await new Promise((r) => setTimeout(r, 60));

      expect(cardWindow.currentToken).toBe(draft.confirmation_token);
      const descEl = cardDom.window.document.getElementById('card-recipient');
      expect(descEl?.textContent).toBe('Official AppBridge Protocol Test Lunch');

      // 7. Click confirm button on card to exercise card's actual DOM and callHostTool flow
      const confirmBtn = cardDom.window.document.getElementById('btn-confirm') as HTMLButtonElement;
      expect(confirmBtn).not.toBeNull();
      expect(confirmBtn.disabled).toBe(false);
      confirmBtn.click();

      // Allow network request from host bridge to /mcp/app-bridge to complete
      await new Promise((r) => setTimeout(r, 400));

      expect(toolCallReceived).not.toBeNull();
      expect(toolCallReceived.name).toBe('confirm_action');

      // Verify card UI updated to confirmed & posted
      const badge = cardDom.window.document.getElementById('card-badge');
      expect(badge?.textContent).toBe('Confirmed & Posted');

      // 8. Verify draft consumed in database
      const [consumed] = await db
        .select()
        .from(pendingConfirmations)
        .where(eq(pendingConfirmations.id, draft.draft_id));
      expect(consumed?.consumedAt).not.toBeNull();

      // Clean up
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, draft.draft_id));
      await bridge.close();
    });

    it('exercises complete MCP Apps app-to-host cancel_action flow through the running server /mcp/app-bridge endpoint', async () => {
      // 1. Tool creates expense draft on running server
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9010,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 250000,
              description: 'Ergonomic Studio Chair',
              payment_method: 'bank_transfer',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(draftRes.status).toBe(200);
      const draft = JSON.parse(draftRes.data.result.content[0].text);
      expect(draft.confirmation_token).toBeTruthy();

      // 2. Read linked generic expense card from running server
      const cardRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9011,
          method: 'resources/read',
          params: { uri: 'ui://cards/expense-draft' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(cardRes.status).toBe(200);
      expect(cardRes.data.result.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
      const html = cardRes.data.result.contents[0].text;
      expect(html).toContain('Expense Record');
      expect(html).toContain('id="btn-cancel"');

      // 3. App dispatches cancellation through the running server's dedicated /mcp/app-bridge HTTP endpoint
      const cancelMessage = {
        jsonrpc: '2.0',
        id: 'req-app-expense-cancel-endpoint',
        method: 'tools/call',
        params: {
          name: 'cancel_action',
          arguments: {
            confirmation_token: draft.confirmation_token,
          },
        },
      };

      const bridgeHttpRes = await fetch(`${baseUrl}/mcp/app-bridge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify(cancelMessage),
      });

      expect(bridgeHttpRes.status).toBe(200);
      const cancelResponse = (await bridgeHttpRes.json()) as {
        jsonrpc: string;
        id: string;
        result?: { status: string; message: string };
        error?: unknown;
      };

      expect(cancelResponse.jsonrpc).toBe('2.0');
      expect(cancelResponse.id).toBe('req-app-expense-cancel-endpoint');
      expect(cancelResponse.error).toBeUndefined();
      expect(cancelResponse.result?.status).toBe('cancelled');

      // 4. Verify draft is marked consumed/cancelled in database
      const [cancelled] = await db
        .select()
        .from(pendingConfirmations)
        .where(eq(pendingConfirmations.id, draft.draft_id));
      expect(cancelled?.consumedAt).not.toBeNull();

      // Clean up
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, draft.draft_id));
    });

    it('enforces tenant isolation on dynamic ui:// draft cards', async () => {
      // 1. Tenant 1 creates an expense draft
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9011,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 100000,
              description: 'Confidential Strategy Report',
              payment_method: 'upi',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      const draft = JSON.parse(draftRes.data.result.content[0].text);
      const t1Token = draft.confirmation_token;

      // 2. Tenant 2 tries to read Tenant 1's draft card
      const initT2 = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9012,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 't2-client', version: '1.0.0' },
          },
        },
        { token: tenant2Secret },
      );
      const t2SessionId = initT2.sessionId!;
      await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { sessionId: t2SessionId, protocolVersion: '2025-11-25', token: tenant2Secret },
      );

      const crossTenantRead = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9013,
          method: 'resources/read',
          params: { uri: `ui://cards/expense-draft/${t1Token}` },
        },
        { sessionId: t2SessionId, protocolVersion: '2025-11-25', token: tenant2Secret },
      );

      expect(crossTenantRead.status).toBe(200);
      const html = crossTenantRead.data.result.contents[0].text;
      expect(html).toContain('Draft Not Found or Expired');
      expect(html).not.toContain('Confidential Strategy Report');

      // Clean up draft
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, draft.draft_id));
    });

    it('reads dynamic ui://cards/month-end-summary/{month}/{year} card with text/html;profile=mcp-app MIME type', async () => {
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9014,
          method: 'resources/read',
          params: { uri: 'ui://cards/month-end-summary/8/2026' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      expect(res.data.result.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
      const html = res.data.result.contents[0].text;
      expect(html).toContain('Month Close: 8/2026');
      expect(html).toContain('Billed Revenue');
    });
  });

  // -------------------------------------------------------------
  // 6. Phase 2 Hardening: Authoritative ITC, Period Lock Concurrency, Categorisation Bounds, Workflow Sequence
  // -------------------------------------------------------------
  describe('Phase 2 Hardening & Security Assurance', () => {
    let testSessionId: string;

    beforeAll(async () => {
      const init = await mcpPost({
        jsonrpc: '2.0',
        id: 7000,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'hardening-test-runner', version: '1.0.0' },
        },
      });
      testSessionId = init.sessionId!;
      await mcpPost(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
    });

    it('statutory ITC authority: rejects claiming ITC on Section 17(5) blocked category', async () => {
      // Find category with isItcEligible: false (e.g. Office Refreshments & Food)
      const [blockedCat] = await db
        .select()
        .from(expenseCategories)
        .where(
          and(
            eq(expenseCategories.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(expenseCategories.isItcEligible, false),
          ),
        )
        .limit(1);

      expect(blockedCat).toBeDefined();

      // Attempt to override category and claim ITC
      const res = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7001,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 11800,
              description: 'Client team lunch and refreshments',
              payment_method: 'card',
              category_id: blockedCat!.id,
              is_itc_claimed: true, // Caller attempts to claim ITC for blocked category
              vendor_gstin: '33AABCT1234F1Z1',
              date: '2026-09-18T12:00:00Z',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(res.status).toBe(200);
      const err = extractToolError(res);
      expect(err).toContain('ITC_NOT_ELIGIBLE');
      expect(err).toContain('Section 17(5)');
    });

    it('statutory ITC authority: allows caller to voluntarily decline eligible ITC', async () => {
      // Find category with isItcEligible: true (e.g. Software Subscriptions)
      const [eligibleCat] = await db
        .select()
        .from(expenseCategories)
        .where(
          and(
            eq(expenseCategories.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(expenseCategories.isItcEligible, true),
          ),
        )
        .limit(1);

      expect(eligibleCat).toBeDefined();

      // Voluntary decline: is_itc_claimed: false
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7002,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 50000,
              description: 'Domain renewal for personal side project',
              payment_method: 'bank_transfer',
              category_id: eligibleCat!.id,
              is_itc_claimed: false, // Voluntarily declined
              vendor_gstin: '33AABCT1234F1Z1',
              date: '2026-09-19T12:00:00Z',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(draftRes.status).toBe(200);
      const draft = JSON.parse(draftRes.data.result!.content![0]!.text);
      expect(draft.is_itc_claimed).toBe(false);

      // Confirm and verify DB record
      const confirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7003,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: { confirmation_token: draft.confirmation_token },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(confirmRes.status).toBe(200);
      const confirmed = JSON.parse(confirmRes.data.result!.content![0]!.text);
      expect(confirmed.status).toBe('executed');

      const [saved] = await db.select().from(expenses).where(eq(expenses.id, confirmed.entity_id));
      expect(saved?.isItcClaimed).toBe(false);
    });

    it('workflow sequence enforcement: prevents calling steps out of order', async () => {
      // Clean up any existing report from prior test runs for month 10 / 2026
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, 10),
            eq(monthEndReports.year, 2026),
          ),
        );

      // 1. Direct prepare_close on un-scanned month 10/2026 must fail
      const prepRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7004,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month: 10, year: 2026, step: 'prepare_close' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(extractToolError(prepRes)).toContain('WORKFLOW_SEQUENCE_ERROR');

      // 2. Direct categorise on un-scanned month 10/2026 must fail
      const catRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7005,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month: 10, year: 2026, step: 'categorise' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(extractToolError(catRes)).toContain('WORKFLOW_SEQUENCE_ERROR');

      // 3. Direct reconcile on un-scanned month 10/2026 must fail
      const recRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7006,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month: 10, year: 2026, step: 'reconcile' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(extractToolError(recRes)).toContain('WORKFLOW_SEQUENCE_ERROR');
    });

    it('categorisation month validation: rejects out-of-period expenses and non-existent IDs', async () => {
      // First, run scan on month 9/2026
      const scanRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7007,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month: 9, year: 2026, step: 'scan' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(scanRes.status).toBe(200);

      // Find an expense from July 2026 in the database
      const [julyExpense] = await db
        .select()
        .from(expenses)
        .where(
          and(
            eq(expenses.businessId, 'b0000000-0000-0000-0000-000000000001'),
            lt(expenses.expenseDate, new Date('2026-08-01T00:00:00Z')),
          ),
        )
        .limit(1);

      expect(julyExpense).toBeDefined();

      const [validCat] = await db
        .select()
        .from(expenseCategories)
        .where(eq(expenseCategories.businessId, 'b0000000-0000-0000-0000-000000000001'))
        .limit(1);

      // Attempt to categorise July expense during September 2026 close
      const outOfPeriodRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7008,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: {
              month: 9,
              year: 2026,
              step: 'categorise',
              payload: {
                categorisations: [{ expense_id: julyExpense!.id, category_id: validCat!.id }],
              },
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const outErr = extractToolError(outOfPeriodRes);
      expect(outErr).toContain('INVALID_CATEGORISATION');
      expect(outErr).toContain('falls outside the workflow period');

      // Attempt to categorise a non-existent expense
      const nonExistentRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7009,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: {
              month: 9,
              year: 2026,
              step: 'categorise',
              payload: {
                categorisations: [
                  {
                    expense_id: 'e0000000-0000-0000-0000-999999999999',
                    category_id: validCat!.id,
                  },
                ],
              },
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const notFoundErr = extractToolError(nonExistentRes);
      expect(notFoundErr).toContain('EXPENSE_NOT_FOUND');
    });

    it('per-journal balance verification: flags individual unbalanced entries even if net totals equal', async () => {
      // Use Month 12 / 2026 as test sandbox
      const testMonth = 12;
      const testYear = 2026;

      // Clean up any existing report from prior test runs for month 12 / 2026
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, testMonth),
            eq(monthEndReports.year, testYear),
          ),
        );

      // Scan December 2026
      await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7010,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month: testMonth, year: testYear, step: 'scan' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const [arAccount] = await db
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '1110'),
          ),
        );

      // Insert two offsetting unbalanced entries in Dec 2026
      // Entry 1: Debit 10000, Credit 0
      const [entry1] = await db
        .insert(journalEntries)
        .values({
          businessId: 'b0000000-0000-0000-0000-000000000001',
          entryNumber: 'TEST/2026-27/UNBAL-1',
          entryDate: new Date('2026-12-10T10:00:00Z'),
          sourceEntityType: 'manual',
          sourceEntityId: '00000000-0000-0000-0000-000000000001',
          narration: 'Offsetting unbalanced entry 1',
        })
        .returning();

      await db.insert(journalLines).values({
        businessId: 'b0000000-0000-0000-0000-000000000001',
        journalEntryId: entry1!.id,
        accountId: arAccount!.id,
        debitPaise: 10000n,
        creditPaise: 0n,
      });

      // Entry 2: Debit 0, Credit 10000
      const [entry2] = await db
        .insert(journalEntries)
        .values({
          businessId: 'b0000000-0000-0000-0000-000000000001',
          entryNumber: 'TEST/2026-27/UNBAL-2',
          entryDate: new Date('2026-12-11T10:00:00Z'),
          sourceEntityType: 'manual',
          sourceEntityId: '00000000-0000-0000-0000-000000000002',
          narration: 'Offsetting unbalanced entry 2',
        })
        .returning();

      await db.insert(journalLines).values({
        businessId: 'b0000000-0000-0000-0000-000000000001',
        journalEntryId: entry2!.id,
        accountId: arAccount!.id,
        debitPaise: 0n,
        creditPaise: 10000n,
      });

      try {
        // Total debits = 10000, Total credits = 10000. Sum matches, but per-journal entries are invalid!
        const recRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 7011,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: { month: testMonth, year: testYear, step: 'reconcile' },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        const recText = recRes.data.result!.content![0]!.text;
        const rec = JSON.parse(recText);
        expect(rec.ledger_balanced).toBe(false);
        expect(rec.status).toBe('reconciliation_failed');
        expect(rec.unbalanced_entries).toContain('TEST/2026-27/UNBAL-1');
        expect(rec.unbalanced_entries).toContain('TEST/2026-27/UNBAL-2');
      } finally {
        await db.delete(journalLines).where(eq(journalLines.journalEntryId, entry1!.id));
        await db.delete(journalLines).where(eq(journalLines.journalEntryId, entry2!.id));
        await db.delete(journalEntries).where(eq(journalEntries.id, entry1!.id));
        await db.delete(journalEntries).where(eq(journalEntries.id, entry2!.id));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, testMonth),
              eq(monthEndReports.year, testYear),
            ),
          );
      }
    });

    it('period lock concurrency race: serializes simultaneous close and posting, preventing posts to closed periods', async () => {
      // Month 11 / November 2026
      const month = 11;
      const year = 2026;

      // Clean up any existing report from prior test runs for month 11 / 2026
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // 1. Prepare Month 11 workflow to obtain a confirmation token for close_month
      await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7012,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month, year, step: 'scan' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7013,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month, year, step: 'reconcile' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const closePrepRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7014,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month, year, step: 'prepare_close' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const closePrep = JSON.parse(closePrepRes.data.result!.content![0]!.text);
      const closeToken = closePrep.confirmation_token;

      // 2. Prepare an expense in November 2026 to obtain a confirmation token for record_expense
      const expDraftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7015,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 250000,
              description: 'Concurrent race test office expense',
              payment_method: 'bank_transfer',
              date: '2026-11-20T10:00:00Z',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const expDraft = JSON.parse(expDraftRes.data.result!.content![0]!.text);
      const expenseToken = expDraft.confirmation_token;

      // 3. Simultaneously fire confirm_action for both close_month and record_expense
      const [closeOutcome, expenseOutcome] = await Promise.all([
        mcpPost(
          {
            jsonrpc: '2.0',
            id: 7016,
            method: 'tools/call',
            params: {
              name: 'confirm_action',
              arguments: { confirmation_token: closeToken },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        ),
        mcpPost(
          {
            jsonrpc: '2.0',
            id: 7017,
            method: 'tools/call',
            params: {
              name: 'confirm_action',
              arguments: { confirmation_token: expenseToken },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        ),
      ]);

      // Exactly one order occurs due to PostgreSQL advisory transaction lock:
      // Case A: close_month commits first -> expense confirmation is serialized after and fails with PERIOD_ALREADY_CLOSED.
      // Case B: expense commits first -> close_month is serialized after, reconciles the expense, and locks the period.
      const closeErr = extractToolError(closeOutcome);
      const expErr = extractToolError(expenseOutcome);

      if (expErr) {
        // Case A: close_month committed first -> expense confirmation failed with PERIOD_ALREADY_CLOSED
        expect(expErr).toMatch(/PERIOD_(ALREADY_)?CLOSED/);
        expect(closeErr).toBe('');
      } else {
        // Case B: expense committed first -> close confirmation detected modified period totals and rejected with STALE_CLOSE_SNAPSHOT
        expect(closeErr).toContain('STALE_CLOSE_SNAPSHOT');

        // Re-reconcile, re-prepare and confirm close so Month 11 is cleanly closed for subsequent checks
        await mcpPost(
          {
            jsonrpc: '2.0',
            id: 70171,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'reconcile' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        const rePrep = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 70172,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'prepare_close' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        const rePrepToken = JSON.parse(rePrep.data.result!.content![0]!.text).confirmation_token;
        const reClose = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 70173,
            method: 'tools/call',
            params: { name: 'confirm_action', arguments: { confirmation_token: rePrepToken } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(reClose.status).toBe(200);
      }

      // Assert that once Month 11 is closed, any subsequent attempt to post into November 2026 is strictly rejected
      const postAfterClose = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7018,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 100000,
              description: 'Post-close rejected expense',
              payment_method: 'bank_transfer',
              date: '2026-11-25T10:00:00Z',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const postAfterCloseErr = extractToolError(postAfterClose);
      expect(postAfterCloseErr).toMatch(/PERIOD_(ALREADY_)?CLOSED/);
    });

    it('journal reclassification: categorising an expense reclassifies the journal entry line to glAccountId and appends an audit log', async () => {
      const month = 10;
      const year = 2026;

      // 1. Record an expense in October 2026
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7020,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 450000,
              description: 'October Office Stationery Supplies',
              payment_method: 'bank_transfer',
              date: '2026-10-12T10:00:00Z',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const draft = JSON.parse(draftRes.data.result!.content![0]!.text);
      const confirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7021,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: { confirmation_token: draft.confirmation_token },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const confirmData = JSON.parse(confirmRes.data.result!.content![0]!.text);
      expect(confirmData.status).toBe('executed');
      const expenseId = confirmData.entity_id;

      // Find the created journal entry
      const [jEntry] = await db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.sourceEntityType, 'expense'),
            eq(journalEntries.sourceEntityId, expenseId),
          ),
        )
        .limit(1);

      expect(jEntry).toBeDefined();

      // Find the GL account for category "Cloud Infrastructure" (code 5200)
      const [cloudCat] = await db
        .select({ id: expenseCategories.id, glAccountId: expenseCategories.glAccountId })
        .from(expenseCategories)
        .where(
          and(
            eq(expenseCategories.name, 'Cloud Infrastructure'),
            eq(expenseCategories.businessId, 'b0000000-0000-0000-0000-000000000001'),
          ),
        )
        .limit(1);

      expect(cloudCat?.glAccountId).toBeDefined();

      // Clear category on expense to simulate uncategorized initial state before workflow categorisation
      await db.update(expenses).set({ categoryId: null }).where(eq(expenses.id, expenseId));

      // Clean up any month 10 reports from prior runs
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // Execute month-close workflow steps: scan, then categorise
      await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7022,
          method: 'tools/call',
          params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const catRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7023,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: {
              month,
              year,
              step: 'categorise',
              payload: {
                categorisations: [{ expense_id: expenseId, category_id: cloudCat!.id }],
              },
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(catRes.status).toBe(200);
      const catData = JSON.parse(catRes.data.result!.content![0]!.text);
      expect(catData.applied_categorisations).toBe(1);

      // Verify that the journal line was reclassified to the category's glAccountId!
      const linesAfter = await db
        .select({ accountId: journalLines.accountId, debitPaise: journalLines.debitPaise })
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, jEntry!.id));

      const debitLineAfter = linesAfter.find((l) => l.debitPaise > 0n);
      expect(debitLineAfter?.accountId).toBe(cloudCat!.glAccountId);

      // Verify that an audited journal reclassification log was written
      const [reclassAudit] = await db
        .select({ action: auditLogs.action, afterState: auditLogs.afterState })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'reclassify_expense'), eq(auditLogs.entityId, expenseId)))
        .limit(1);

      expect(reclassAudit).toBeDefined();
      expect(reclassAudit?.action).toBe('reclassify_expense');
      expect((reclassAudit?.afterState as Record<string, unknown>).new_gl_account_id).toBe(
        cloudCat!.glAccountId,
      );
    });

    it('period locking: categorising an expense in an already closed period is rejected with PERIOD_CLOSED', async () => {
      // Month 11, 2026 was closed in the previous test
      const catInClosedPeriod = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7024,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: {
              month: 11,
              year: 2026,
              step: 'categorise',
              payload: {
                categorisations: [
                  {
                    expense_id: 'e0000000-0000-0000-0000-000000000001',
                    category_id: 'c0000000-0000-0000-0000-000000000001',
                  },
                ],
              },
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const catData = JSON.parse(catInClosedPeriod.data.result!.content![0]!.text);
      expect(catData.status).toBe('already_closed');
      expect(catData.message).toContain('already closed');
    });

    it('stale close snapshot protection: rejects confirming close_month if transactions were posted after prepare_close', async () => {
      const month = 4;
      const year = 2026;

      // Clean up any month 4 reports from prior test runs
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // 1. Prepare month-close for April 2026
      await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7030,
          method: 'tools/call',
          params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7031,
          method: 'tools/call',
          params: { name: 'close_month', arguments: { month, year, step: 'reconcile' } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const prepRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7032,
          method: 'tools/call',
          params: { name: 'close_month', arguments: { month, year, step: 'prepare_close' } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const prep = JSON.parse(prepRes.data.result!.content![0]!.text);
      const staleToken = prep.confirmation_token;

      // 2. Post a new transaction in April 2026 after prepare_close has snapshotted totals
      const expDraft = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7033,
          method: 'tools/call',
          params: {
            name: 'record_expense',
            arguments: {
              amount_paise: 200000,
              description: 'Late April Office Supplies',
              payment_method: 'bank_transfer',
              date: '2026-04-28T10:00:00Z',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      const expToken = JSON.parse(expDraft.data.result!.content![0]!.text).confirmation_token;

      await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7034,
          method: 'tools/call',
          params: { name: 'confirm_action', arguments: { confirmation_token: expToken } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      // 3. Attempt to confirm close_month with the earlier token snapshotted before the expense was posted
      const closeConfirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7035,
          method: 'tools/call',
          params: { name: 'confirm_action', arguments: { confirmation_token: staleToken } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const err = extractToolError(closeConfirmRes);
      expect(err).toContain('STALE_CLOSE_SNAPSHOT');
    });

    it('uncategorized expenses workflow: requires explicit allow_general_expense approval before advancing reconcile or prepare_close', async () => {
      const month = 8;
      const year = 2026;

      // Clean up month 8 reports
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // Insert a truly uncategorized expense (categoryId: null) in August 2026 with a balanced journal entry
      const [augExp] = await db
        .insert(expenses)
        .values({
          businessId: 'b0000000-0000-0000-0000-000000000001',
          amountPaise: 150000n,
          taxableAmountPaise: 150000n,
          paymentMethod: 'bank_transfer',
          expenseDate: new Date('2026-08-10T10:00:00Z'),
          description: 'Uncategorized August Hardware Tool',
          categoryId: null,
        })
        .returning();

      const [augJe] = await db
        .insert(journalEntries)
        .values({
          businessId: 'b0000000-0000-0000-0000-000000000001',
          entryNumber: 'JE-202608-TEST-UNCAT',
          entryDate: new Date('2026-08-10T10:00:00Z'),
          sourceEntityType: 'expense',
          sourceEntityId: augExp!.id,
          narration: 'Uncategorized August Hardware Tool',
        })
        .returning();

      await db.insert(journalLines).values([
        {
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: augJe!.id,
          accountId: 'a0000000-0000-0000-0000-000000005100',
          debitPaise: 150000n,
          creditPaise: 0n,
        },
        {
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: augJe!.id,
          accountId: 'a0000000-0000-0000-0000-000000001110',
          debitPaise: 0n,
          creditPaise: 150000n,
        },
      ]);

      try {
        // Step 1: scan
        await mcpPost(
          {
            jsonrpc: '2.0',
            id: 7042,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        // Step 2: reconcile without approval must fail with UNCATEGORIZED_EXPENSES_REMAINING
        const recWithoutApproval = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 7043,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'reconcile' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        const recErr = extractToolError(recWithoutApproval);
        expect(recErr).toContain('UNCATEGORIZED_EXPENSES_REMAINING');

        // Step 2b: reconcile with allow_general_expense: true succeeds
        const recWithApproval = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 7044,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: {
                month,
                year,
                step: 'reconcile',
                payload: { allow_general_expense: true },
              },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(recWithApproval.status).toBe(200);
        const recData = JSON.parse(recWithApproval.data.result!.content![0]!.text);
        expect(recData.allow_general_expense).toBe(true);
        expect(recData.unresolved_treatment).toBe('general_operational_expense');

        // Step 3: prepare_close reflects the approved general expense treatment
        const prepRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 7045,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'prepare_close' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(prepRes.status).toBe(200);
        const prepData = JSON.parse(prepRes.data.result!.content![0]!.text);
        expect(prepData.draft_report.allow_general_expense).toBe(true);
        expect(prepData.draft_report.unresolved_treatment).toBe('general_operational_expense');
        expect(prepData.preview_summary).toContain('approved general operational expense');
      } finally {
        await db.delete(journalLines).where(eq(journalLines.journalEntryId, augJe!.id));
        await db.delete(journalEntries).where(eq(journalEntries.id, augJe!.id));
        await db.delete(expenses).where(eq(expenses.id, augExp!.id));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          );
      }
    });

    it('cross-session business memory: records customer reminder preference on confirmation and reuses it on subsequent drafts', async () => {
      const customerId = 'c0000000-0000-0000-0000-000000000001';

      // Insert an open invoice for this customer to ensure an outstanding balance exists
      await db.insert(invoices).values({
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId,
        invoiceNumber: 'INV/2026-27/REM-TEST',
        financialYear: '2026-27',
        issueDate: new Date('2026-09-01T10:00:00Z'),
        dueDate: new Date('2026-09-15T10:00:00Z'),
        placeOfSupplyStateCode: '33',
        isInterState: false,
        subtotalPaise: 500000n,
        totalPaise: 590000n,
        paidAmountPaise: 0n,
        status: 'issued',
      });

      // 1. Prepare payment reminder with explicit tone: firm and channel: email
      const draftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7050,
          method: 'tools/call',
          params: {
            name: 'send_payment_reminder',
            arguments: {
              customer_id: customerId,
              tone: 'firm',
              channel: 'email',
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const draft = JSON.parse(draftRes.data.result!.content![0]!.text);
      expect(draft.tone).toBe('firm');
      expect(draft.channel).toBe('email');

      // 2. Confirm reminder action
      const confirmRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7051,
          method: 'tools/call',
          params: {
            name: 'confirm_action',
            arguments: { confirmation_token: draft.confirmation_token },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(confirmRes.status).toBe(200);

      // Verify businessMemory row was created for this customer
      const [mem] = await db
        .select({
          category: businessMemory.category,
          entityKey: businessMemory.entityKey,
          memoryValue: businessMemory.memoryValue,
          isActive: businessMemory.isActive,
        })
        .from(businessMemory)
        .where(
          and(
            eq(businessMemory.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(businessMemory.category, 'customer_preference'),
            eq(businessMemory.entityKey, `customer:${customerId}`),
          ),
        )
        .limit(1);

      expect(mem).toBeDefined();
      expect(mem?.isActive).toBe(true);
      expect((mem?.memoryValue as Record<string, unknown>).preferred_tone).toBe('firm');
      expect((mem?.memoryValue as Record<string, unknown>).preferred_channel).toBe('email');

      // 3. Draft another reminder for the same customer without providing tone or channel
      const secondDraftRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7052,
          method: 'tools/call',
          params: {
            name: 'send_payment_reminder',
            arguments: {
              customer_id: customerId,
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const secondDraft = JSON.parse(secondDraftRes.data.result!.content![0]!.text);
      expect(secondDraft.tone).toBe('firm');
      expect(secondDraft.channel).toBe('email');

      // 4. Verify reading the kanakku://business-memory resource
      const resourceRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 7053,
          method: 'resources/read',
          params: { uri: 'kanakku://business-memory' },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(resourceRes.status).toBe(200);
      const resText = resourceRes.data.result.contents[0].text;
      const memList = JSON.parse(resText);
      expect(Array.isArray(memList)).toBe(true);
      expect(
        memList.some((m: { entityKey: string }) => m.entityKey === `customer:${customerId}`),
      ).toBe(true);
    });

    it('reconciliation fails and gates month-close when a transaction lacks a balanced journal entry', async () => {
      const month = 10;
      const year = 2026;
      const unjournaledInvId = '11000000-0000-0000-0000-000000000001';

      // Clean up any month 10 reports
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // Insert an invoice in October 2026 WITHOUT a journal entry
      await db.insert(invoices).values({
        id: unjournaledInvId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId: 'c0000000-0000-0000-0000-000000000001',
        invoiceNumber: 'INV/2026-27/UNJOURNALED-TEST',
        financialYear: '2026-27',
        issueDate: new Date('2026-10-10T10:00:00Z'),
        dueDate: new Date('2026-10-25T10:00:00Z'),
        placeOfSupplyStateCode: '33',
        isInterState: false,
        subtotalPaise: 1000000n,
        cgstPaise: 90000n,
        sgstPaise: 90000n,
        igstPaise: 0n,
        totalPaise: 1180000n,
        paidAmountPaise: 0n,
        status: 'issued',
      });

      try {
        // Step 1: Scan completes
        const scanRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8001,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(scanRes.status).toBe(200);

        // Step 2: Reconcile must flag missing journal entry and fail
        const recRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8002,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: {
                month,
                year,
                step: 'reconcile',
                payload: { allow_general_expense: true },
              },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(recRes.status).toBe(200);
        const recData = JSON.parse(recRes.data.result!.content![0]!.text);
        expect(recData.status).toBe('reconciliation_failed');
        expect(recData.workflow_state).toBe('missing_journal_entries_detected');
        expect(recData.ledger_balanced).toBe(false);
        expect(recData.missing_journal_transactions).toHaveLength(1);
        expect(recData.missing_journal_transactions[0].id).toBe(unjournaledInvId);

        // Step 3: prepare_close must be blocked
        const prepRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8003,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'prepare_close' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        const err = extractToolError(prepRes);
        expect(err).toMatch(/UNJOURNALED_TRANSACTIONS_DETECTED|WORKFLOW_SEQUENCE_ERROR/);
      } finally {
        await db.delete(invoices).where(eq(invoices.id, unjournaledInvId));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          );
      }
    });

    it('reconciliation and close confirmation fail when a transaction journal entry is dated in the wrong month', async () => {
      const month = 10;
      const year = 2026;
      const misdatedInvId = '11000000-0000-0000-0000-000000000002';
      const misdatedJeId = 'e2000000-0000-0000-0000-000000000071';
      const misdatedJlDebitId = 'e3000000-0000-0000-0000-000000000071';
      const misdatedJlCreditId = 'e3000000-0000-0000-0000-000000000072';

      // Clean up month 10 reports
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // Insert an invoice in October 2026
      await db.insert(invoices).values({
        id: misdatedInvId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId: 'c0000000-0000-0000-0000-000000000001',
        invoiceNumber: 'INV/2026-27/MISDATED-TEST',
        financialYear: '2026-27',
        issueDate: new Date('2026-10-15T10:00:00Z'),
        dueDate: new Date('2026-10-30T10:00:00Z'),
        placeOfSupplyStateCode: '33',
        isInterState: false,
        subtotalPaise: 1000000n,
        cgstPaise: 90000n,
        sgstPaise: 90000n,
        igstPaise: 0n,
        totalPaise: 1180000n,
        paidAmountPaise: 0n,
        status: 'issued',
      });

      // Insert matching journal entry dated in November 2026 (wrong month!)
      await db.insert(journalEntries).values({
        id: misdatedJeId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        entryNumber: 'JE-202611-MISDATED',
        entryDate: new Date('2026-11-05T10:00:00Z'), // WRONG MONTH: Nov instead of Oct!
        sourceEntityType: 'invoice',
        sourceEntityId: misdatedInvId,
        narration: 'Invoice issued misdated in November',
      });

      const [arAcc] = await db
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '1120'),
          ),
        );
      const [revAcc] = await db
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '4100'),
          ),
        );

      await db.insert(journalLines).values([
        {
          id: misdatedJlDebitId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: misdatedJeId,
          accountId: arAcc!.id,
          debitPaise: 1180000n,
          creditPaise: 0n,
        },
        {
          id: misdatedJlCreditId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: misdatedJeId,
          accountId: revAcc!.id,
          debitPaise: 0n,
          creditPaise: 1180000n,
        },
      ]);

      try {
        await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8020,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        // Reconcile must fail because the invoice lacks a journal entry in October
        const recRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8021,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: {
                month,
                year,
                step: 'reconcile',
                payload: { allow_general_expense: true },
              },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(recRes.status).toBe(200);
        const recData = JSON.parse(recRes.data.result!.content![0]!.text);
        expect(recData.status).toBe('reconciliation_failed');
        expect(recData.workflow_state).toBe('missing_journal_entries_detected');
        expect(recData.ledger_balanced).toBe(false);
        expect(recData.missing_journal_transactions).toHaveLength(1);
        expect(recData.missing_journal_transactions[0].id).toBe(misdatedInvId);

        // Prepare close must be blocked
        const prepRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8022,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'prepare_close' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        const err = extractToolError(prepRes);
        expect(err).toMatch(/UNJOURNALED_TRANSACTIONS_DETECTED|WORKFLOW_SEQUENCE_ERROR/);

        // Attempt confirm_action: must detect unjournaled transaction and reject under the advisory lock
        const payload = {
          month,
          year,
          prepared_summary: {
            billed_revenue_paise: 1000000,
            total_expenses_paise: 0,
            collections_paise: 0,
            net_gst_payable_paise: 180000,
            uncategorized_expenses_count: 0,
            allow_general_expense: true,
          },
        };
        const generated = generateConfirmationToken(payload);
        await db.insert(pendingConfirmations).values({
          businessId: 'b0000000-0000-0000-0000-000000000001',
          userId: '10000000-0000-0000-0000-000000000001',
          tokenHash: generated.tokenHash,
          actionType: 'close_month',
          payload,
          payloadHash: generated.payloadHash,
          humanSummary: 'Close month test for misdated journal',
          expiresAt: generated.expiresAt,
        });

        try {
          const confirmRes = await mcpPost(
            {
              jsonrpc: '2.0',
              id: 8023,
              method: 'tools/call',
              params: {
                name: 'confirm_action',
                arguments: { confirmation_token: generated.tokenSecret },
              },
            },
            { sessionId: testSessionId, protocolVersion: '2025-11-25' },
          );
          const confirmErr = extractToolError(confirmRes);
          expect(confirmErr).toContain('UNJOURNALED_TRANSACTIONS_DETECTED');
        } finally {
          await db
            .delete(pendingConfirmations)
            .where(eq(pendingConfirmations.tokenHash, generated.tokenHash));
        }
      } finally {
        await db.delete(journalLines).where(eq(journalLines.journalEntryId, misdatedJeId));
        await db.delete(journalEntries).where(eq(journalEntries.id, misdatedJeId));
        await db.delete(invoices).where(eq(invoices.id, misdatedInvId));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          );
      }
    });

    it('reconciliation and close confirmation fail when a journal entry has a header with no lines', async () => {
      const month = 10;
      const year = 2026;
      const emptyJeInvId = '11000000-0000-0000-0000-000000000003';
      const emptyJeId = 'e2000000-0000-0000-0000-000000000072';

      // Clean up month 10 reports
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // Insert an invoice in October 2026
      await db.insert(invoices).values({
        id: emptyJeInvId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId: 'c0000000-0000-0000-0000-000000000001',
        invoiceNumber: 'INV/2026-27/EMPTY-JE-TEST',
        financialYear: '2026-27',
        issueDate: new Date('2026-10-18T10:00:00Z'),
        dueDate: new Date('2026-10-30T10:00:00Z'),
        placeOfSupplyStateCode: '33',
        isInterState: false,
        subtotalPaise: 1000000n,
        cgstPaise: 90000n,
        sgstPaise: 90000n,
        igstPaise: 0n,
        totalPaise: 1180000n,
        paidAmountPaise: 0n,
        status: 'issued',
      });

      // Insert a journal entry header with NO journal lines!
      await db.insert(journalEntries).values({
        id: emptyJeId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        entryNumber: 'JE-202610-NO-LINES',
        entryDate: new Date('2026-10-18T10:00:00Z'),
        sourceEntityType: 'invoice',
        sourceEntityId: emptyJeInvId,
        narration: 'Invoice issued but journal lines are missing',
      });

      try {
        await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8030,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        // Reconcile must fail: the entry has 0 lines, unbalanced, and invoice lacks a valid journal entry
        const recRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8031,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: {
                month,
                year,
                step: 'reconcile',
                payload: { allow_general_expense: true },
              },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(recRes.status).toBe(200);
        const recData = JSON.parse(recRes.data.result!.content![0]!.text);
        expect(recData.status).toBe('reconciliation_failed');
        expect(recData.ledger_balanced).toBe(false);
        expect(recData.unbalanced_entries).toContain('JE-202610-NO-LINES');
        expect(recData.invalid_journal_entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ entryNumber: 'JE-202610-NO-LINES' })]),
        );
        expect(recData.missing_journal_transactions).toHaveLength(1);
        expect(recData.missing_journal_transactions[0].id).toBe(emptyJeInvId);

        // Prepare close must be blocked
        const prepRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8032,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'prepare_close' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        const err = extractToolError(prepRes);
        expect(err).toMatch(/UNJOURNALED_TRANSACTIONS_DETECTED|WORKFLOW_SEQUENCE_ERROR/);

        // Attempt confirm_action: must detect unjournaled/unbalanced transaction and reject under the advisory lock
        const payload = {
          month,
          year,
          prepared_summary: {
            billed_revenue_paise: 1000000,
            total_expenses_paise: 0,
            collections_paise: 0,
            net_gst_payable_paise: 180000,
            uncategorized_expenses_count: 0,
            allow_general_expense: true,
          },
        };
        const generated = generateConfirmationToken(payload);
        await db.insert(pendingConfirmations).values({
          businessId: 'b0000000-0000-0000-0000-000000000001',
          userId: '10000000-0000-0000-0000-000000000001',
          tokenHash: generated.tokenHash,
          actionType: 'close_month',
          payload,
          payloadHash: generated.payloadHash,
          humanSummary: 'Close month test for empty journal header',
          expiresAt: generated.expiresAt,
        });

        try {
          const confirmRes = await mcpPost(
            {
              jsonrpc: '2.0',
              id: 8033,
              method: 'tools/call',
              params: {
                name: 'confirm_action',
                arguments: { confirmation_token: generated.tokenSecret },
              },
            },
            { sessionId: testSessionId, protocolVersion: '2025-11-25' },
          );
          const confirmErr = extractToolError(confirmRes);
          expect(confirmErr).toMatch(
            /UNJOURNALED_TRANSACTIONS_DETECTED|UNBALANCED_JOURNAL_ENTRIES_DETECTED/,
          );
        } finally {
          await db
            .delete(pendingConfirmations)
            .where(eq(pendingConfirmations.tokenHash, generated.tokenHash));
        }
      } finally {
        await db.delete(journalEntries).where(eq(journalEntries.id, emptyJeId));
        await db.delete(invoices).where(eq(invoices.id, emptyJeInvId));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          );
      }
    });

    it('reconciliation and close confirmation fail when a journal entry has a balanced but wrong amount (amount mismatch)', async () => {
      const month = 10;
      const year = 2026;
      const mismatchInvId = '11000000-0000-0000-0000-000000000004';
      const mismatchJeId = 'e2000000-0000-0000-0000-000000000073';
      const mismatchJlDebitId = 'e3000000-0000-0000-0000-000000000073';
      const mismatchJlCreditId = 'e3000000-0000-0000-0000-000000000074';

      // Clean up month 10 reports
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // Insert an invoice for ₹11,800 (1,180,000 paise) in October 2026
      await db.insert(invoices).values({
        id: mismatchInvId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId: 'c0000000-0000-0000-0000-000000000001',
        invoiceNumber: 'INV/2026-27/MISMATCH-TEST',
        financialYear: '2026-27',
        issueDate: new Date('2026-10-20T10:00:00Z'),
        dueDate: new Date('2026-10-30T10:00:00Z'),
        placeOfSupplyStateCode: '33',
        isInterState: false,
        subtotalPaise: 1000000n,
        cgstPaise: 90000n,
        sgstPaise: 90000n,
        igstPaise: 0n,
        totalPaise: 1180000n,
        paidAmountPaise: 0n,
        status: 'issued',
      });

      // Insert a journal entry dated in October 2026 for ₹1 (100 paise) - BALANCED BUT WRONG AMOUNT!
      await db.insert(journalEntries).values({
        id: mismatchJeId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        entryNumber: 'JE-202610-WRONG-AMOUNT',
        entryDate: new Date('2026-10-20T10:00:00Z'),
        sourceEntityType: 'invoice',
        sourceEntityId: mismatchInvId,
        narration: 'Invoice issued with wrong journal amount of ₹1',
      });

      const [arAcc] = await db
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '1120'),
          ),
        );
      const [revAcc] = await db
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '4100'),
          ),
        );

      await db.insert(journalLines).values([
        {
          id: mismatchJlDebitId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: mismatchJeId,
          accountId: arAcc!.id,
          debitPaise: 100n,
          creditPaise: 0n,
        },
        {
          id: mismatchJlCreditId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: mismatchJeId,
          accountId: revAcc!.id,
          debitPaise: 0n,
          creditPaise: 100n,
        },
      ]);

      try {
        await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8040,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        // Reconcile must fail: balanced ₹1 journal entry does not match ₹11,800 invoice
        const recRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8041,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: {
                month,
                year,
                step: 'reconcile',
                payload: { allow_general_expense: true },
              },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(recRes.status).toBe(200);
        const recData = JSON.parse(recRes.data.result!.content![0]!.text);
        expect(recData.status).toBe('reconciliation_failed');
        expect(recData.workflow_state).toBe('amount_mismatch_detected');
        expect(recData.ledger_balanced).toBe(false);
        expect(recData.amount_mismatch_transactions).toHaveLength(1);
        expect(recData.amount_mismatch_transactions[0]).toMatchObject({
          type: 'invoice',
          id: mismatchInvId,
          expectedAmountPaise: 1180000,
          actualAmountPaise: 100,
          entryNumber: 'JE-202610-WRONG-AMOUNT',
        });

        // Prepare close must be blocked due to amount mismatch
        const prepRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8042,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'prepare_close' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        const prepErr = extractToolError(prepRes);
        expect(prepErr).toMatch(/JOURNAL_AMOUNT_MISMATCH_DETECTED|WORKFLOW_SEQUENCE_ERROR/);

        // Confirm close must also fail live under the period advisory lock
        const payload = {
          month,
          year,
          prepared_summary: {
            billed_revenue_paise: 1000000,
            total_expenses_paise: 0,
            collections_paise: 0,
            net_gst_payable_paise: 180000,
            uncategorized_expenses_count: 0,
            allow_general_expense: true,
          },
        };
        const generated = generateConfirmationToken(payload);
        await db.insert(pendingConfirmations).values({
          businessId: 'b0000000-0000-0000-0000-000000000001',
          userId: '10000000-0000-0000-0000-000000000001',
          tokenHash: generated.tokenHash,
          actionType: 'close_month',
          payload,
          payloadHash: generated.payloadHash,
          humanSummary: 'Close month test for amount mismatch',
          expiresAt: generated.expiresAt,
        });

        try {
          const confirmRes = await mcpPost(
            {
              jsonrpc: '2.0',
              id: 8043,
              method: 'tools/call',
              params: {
                name: 'confirm_action',
                arguments: { confirmation_token: generated.tokenSecret },
              },
            },
            { sessionId: testSessionId, protocolVersion: '2025-11-25' },
          );
          const confirmErr = extractToolError(confirmRes);
          expect(confirmErr).toContain('JOURNAL_AMOUNT_MISMATCH_DETECTED');
          expect(confirmErr).toContain('JE-202610-WRONG-AMOUNT');
        } finally {
          await db
            .delete(pendingConfirmations)
            .where(eq(pendingConfirmations.tokenHash, generated.tokenHash));
        }
      } finally {
        await db.delete(journalLines).where(eq(journalLines.journalEntryId, mismatchJeId));
        await db.delete(journalEntries).where(eq(journalEntries.id, mismatchJeId));
        await db.delete(invoices).where(eq(invoices.id, mismatchInvId));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          );
      }
    });

    it('stale close snapshot protection: rejects confirming close_month if categorisation changed after prepare_close', async () => {
      const month = 12;
      const year = 2026;
      const expId = 'e9000000-0000-0000-0000-000000000001';
      const jEntryId = 'e2000000-0000-0000-0000-000000000099';
      const jLineDebitId = 'e3000000-0000-0000-0000-000000000098';
      const jLineCreditId = 'e3000000-0000-0000-0000-000000000099';

      // Clean up prior test data
      await db.delete(journalLines).where(eq(journalLines.journalEntryId, jEntryId));
      await db.delete(journalEntries).where(eq(journalEntries.id, jEntryId));
      await db.delete(expenses).where(eq(expenses.id, expId));
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // Create an uncategorized expense with a balanced journal entry in December 2026
      await db.insert(expenses).values({
        id: expId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        description: 'Uncategorized Testing Expense',
        amountPaise: 500000n,
        taxableAmountPaise: 500000n,
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 0n,
        isItcClaimed: false,
        paymentMethod: 'bank_transfer',
        expenseDate: new Date('2026-12-15T10:00:00Z'),
        status: 'posted',
        categoryId: null,
      });

      // Journal entry for this expense (Suspense/General Debit 5000, Bank Credit 5000)
      const [bankAcc] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '1110'),
          ),
        );
      const [genExpAcc] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '5100'),
          ),
        );

      await db.insert(journalEntries).values({
        id: jEntryId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        entryNumber: 'JE-2026-12-001',
        entryDate: new Date('2026-12-15T10:00:00Z'),
        sourceEntityType: 'expense',
        sourceEntityId: expId,
        narration: 'December test expense',
      });

      await db.insert(journalLines).values([
        {
          id: jLineDebitId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: jEntryId,
          accountId: genExpAcc!.id,
          debitPaise: 500000n,
          creditPaise: 0n,
        },
        {
          id: jLineCreditId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: jEntryId,
          accountId: bankAcc!.id,
          debitPaise: 0n,
          creditPaise: 500000n,
        },
      ]);

      try {
        // 1. Scan December
        await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8010,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        // 2. Reconcile with allow_general_expense: true
        await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8011,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: {
                month,
                year,
                step: 'reconcile',
                payload: { allow_general_expense: true },
              },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        // 3. Prepare close: snapshots uncategorized_expenses_count: 1
        const prepRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8012,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'prepare_close' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        const prep = JSON.parse(prepRes.data.result!.content![0]!.text);
        const confirmationToken = prep.confirmation_token;
        expect(prep.draft_report.uncategorized_expenses_count).toBe(1);

        // 4. Now categorise the expense before confirming
        const [cat] = await db
          .select({ id: expenseCategories.id })
          .from(expenseCategories)
          .where(eq(expenseCategories.businessId, 'b0000000-0000-0000-0000-000000000001'))
          .limit(1);

        await db.update(expenses).set({ categoryId: cat!.id }).where(eq(expenses.id, expId));

        // 5. Attempt confirm_action: must detect stale categorisation state and reject
        const confirmRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 8013,
            method: 'tools/call',
            params: {
              name: 'confirm_action',
              arguments: { confirmation_token: confirmationToken },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );

        const err = extractToolError(confirmRes);
        expect(err).toContain('STALE_CLOSE_SNAPSHOT');
        expect(err).toContain('Expense categorisation changed');
      } finally {
        await db.delete(journalLines).where(eq(journalLines.journalEntryId, jEntryId));
        await db.delete(journalEntries).where(eq(journalEntries.id, jEntryId));
        await db.delete(expenses).where(eq(expenses.id, expId));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          );
      }
    });
  });

  describe('Phase 5: Multi-step Resumable State Machine in close_month', () => {
    it('auto-advances through scan -> categorise -> reconcile -> prepare_close when step is omitted or "resume"', async () => {
      const month = 6;
      const year = 2026;
      const expId = 'e0000000-0000-0000-0000-000000000601';
      const jEntryId = 'e2000000-0000-0000-0000-000000000601';
      const jLineDebitId = 'e3000000-0000-0000-0000-000000000601';
      const jLineCreditId = 'e3000000-0000-0000-0000-000000000602';

      // 1. Initialize test session
      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9001,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'phase5-test-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );
      const testSessionId = initRes.sessionId!;
      expect(testSessionId).toBeDefined();

      // 2. Seed an uncategorized expense with balanced journal entry for June 2026
      await db.insert(expenses).values({
        id: expId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        amountPaise: 300000n,
        taxableAmountPaise: 300000n,
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 0n,
        categoryId: null, // uncategorized
        paymentMethod: 'bank_transfer',
        expenseDate: new Date('2026-06-15T10:00:00Z'),
        description: 'June Uncategorized Operational Expense',
        status: 'recorded',
      });

      const [bankAcc] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '1110'),
          ),
        );
      const [genExpAcc] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '5100'),
          ),
        );

      await db.insert(journalEntries).values({
        id: jEntryId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        entryNumber: 'JE-2026-06-001',
        entryDate: new Date('2026-06-15T10:00:00Z'),
        sourceEntityType: 'expense',
        sourceEntityId: expId,
        narration: 'June uncategorized expense entry',
      });

      await db.insert(journalLines).values([
        {
          id: jLineDebitId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: jEntryId,
          accountId: genExpAcc!.id,
          debitPaise: 300000n,
          creditPaise: 0n,
        },
        {
          id: jLineCreditId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: jEntryId,
          accountId: bankAcc!.id,
          debitPaise: 0n,
          creditPaise: 300000n,
        },
      ]);

      try {
        // Step 1: Scan via resumption (step omitted entirely)
        const scanRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9002,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(scanRes.status).toBe(200);
        const scan = JSON.parse(scanRes.data.result.content[0].text);
        expect(scan.step).toBe('scan');
        expect(scan.status).toBe('scan_complete');
        expect(scan.uncategorized_expenses_count).toBe(1);
        expect(scan.next_recommended_step).toBe('categorise');

        // Verify sessionContext has active workflow state recorded
        const [sessionRow] = await db
          .select()
          .from(conversationSessions)
          .where(eq(conversationSessions.sessionKey, testSessionId))
          .limit(1);
        if (sessionRow) {
          const [sContext] = await db
            .select()
            .from(sessionContext)
            .where(eq(sessionContext.sessionId, sessionRow.id))
            .limit(1);
          expect(sContext?.activeWorkflowName).toBe('close_month');
          expect((sContext?.activeWorkflowState as any)?.step).toBe('scan');
        }

        // Step 2: Categorise via resumption (step: 'resume' with allow_general_expense approval)
        const catRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9003,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: { month, year, step: 'resume', payload: { allow_general_expense: true } },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(catRes.status).toBe(200);
        const cat = JSON.parse(catRes.data.result.content[0].text);
        expect(cat.step).toBe('categorise');
        expect(cat.allow_general_expense).toBe(true);
        expect(cat.next_recommended_step).toBe('reconcile');

        // Step 3: Reconcile via resumption (step: 'resume')
        const recRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9004,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'resume' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(recRes.status).toBe(200);
        const rec = JSON.parse(recRes.data.result.content[0].text);
        expect(rec.step).toBe('reconcile');
        expect(rec.status).toBe('reconciliation_verified');
        expect(rec.ledger_balanced).toBe(true);
        expect(rec.next_recommended_step).toBe('prepare_close');

        // Step 4: Prepare close via resumption (step omitted)
        const prepRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9005,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(prepRes.status).toBe(200);
        const prep = JSON.parse(prepRes.data.result.content[0].text);
        expect(prep.step).toBe('prepare_close');
        expect(prep.status).toBe('pending_confirmation');
        expect(prep.confirmation_token).toBeDefined();
        expect(prep.ui_resource_uri).toBe(`ui://cards/month-end-summary/${month}/${year}`);

        // Step 5: Re-running resume while awaiting confirmation returns the existing draft safely
        const resumePrepRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9006,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'resume' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(resumePrepRes.status).toBe(200);
        const resumePrep = JSON.parse(resumePrepRes.data.result.content[0].text);
        expect(resumePrep.step).toBe('prepare_close');
        expect(resumePrep.status).toBe('pending_confirmation');

        // Step 6: Confirm close_month locks the books
        const confirmRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9007,
            method: 'tools/call',
            params: {
              name: 'confirm_action',
              arguments: { confirmation_token: prep.confirmation_token },
            },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(confirmRes.status).toBe(200);
        const confirmData = JSON.parse(confirmRes.data.result.content[0].text);
        expect(confirmData.status).toBe('executed');

        // Verify monthEndReports isClosed = true
        const [closedReport] = await db
          .select()
          .from(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          )
          .limit(1);
        expect(closedReport?.isClosed).toBe(true);

        // Step 7: Post-close resumption check: Calling close_month on closed month returns already_closed
        const postCloseRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9008,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'resume' } },
          },
          { sessionId: testSessionId, protocolVersion: '2025-11-25' },
        );
        expect(postCloseRes.status).toBe(200);
        const postClose = JSON.parse(postCloseRes.data.result.content[0].text);
        expect(postClose.status).toBe('already_closed');
        expect(postClose.message).toContain('Books are locked');
      } finally {
        await db.delete(journalLines).where(eq(journalLines.journalEntryId, jEntryId));
        await db.delete(journalEntries).where(eq(journalEntries.id, jEntryId));
        await db.delete(expenses).where(eq(expenses.id, expId));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          );
      }
    });

    it('session workflow state persistence: stores and retrieves active workflow state across distinct session contexts', async () => {
      const customSessionKey = 'test-session-phase5-isolated';
      const month = 5;
      const year = 2026;

      // 1. Initialize test session
      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9019,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'phase5-isolated-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );
      const testSessionId = initRes.sessionId!;
      expect(testSessionId).toBeDefined();

      // 2. Call close_month with explicit sessionId argument
      const scanRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9020,
          method: 'tools/call',
          params: {
            name: 'close_month',
            arguments: { month, year, step: 'scan', sessionId: customSessionKey },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(scanRes.status).toBe(200);

      // Verify conversationSessions and sessionContext exist for this custom session key
      const [customSession] = await db
        .select()
        .from(conversationSessions)
        .where(eq(conversationSessions.sessionKey, customSessionKey))
        .limit(1);
      expect(customSession).toBeDefined();

      const [customContext] = await db
        .select()
        .from(sessionContext)
        .where(eq(sessionContext.sessionId, customSession!.id))
        .limit(1);
      expect(customContext).toBeDefined();
      expect(customContext!.activeWorkflowName).toBe('close_month');
      expect((customContext!.activeWorkflowState as any)?.step).toBe('scan');

      // Cleanup
      await db.delete(sessionContext).where(eq(sessionContext.id, customContext!.id));
      await db.delete(conversationSessions).where(eq(conversationSessions.id, customSession!.id));
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );
    });

    it('security regression: blocks member role from executing close_month categorisation and reclassifying journals', async () => {
      const month = 9;
      const year = 2029;
      const expId = 'e0000000-0000-0000-0000-000000000901';
      const jEntryId = 'e2000000-0000-0000-0000-000000000901';
      const jLineDebitId = 'e3000000-0000-0000-0000-000000000901';
      const jLineCreditId = 'e3000000-0000-0000-0000-000000000902';

      // Ensure employee user role is 'member' and period report is clean
      await db.update(users).set({ role: 'member' }).where(eq(users.id, tenant1EmployeeId));
      await db
        .delete(monthEndReports)
        .where(
          and(
            eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(monthEndReports.month, month),
            eq(monthEndReports.year, year),
          ),
        );

      // 1. Initialize employee session (role: member)
      const empInitRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9030,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'employee-client', version: '1.0.0' },
          },
        },
        { token: tenant1EmployeeSecret, protocolVersion: '2025-11-25' },
      );
      const empSessionId = empInitRes.sessionId!;
      expect(empSessionId).toBeDefined();

      // 2. Seed an uncategorized expense with balanced journal entry for September 2029
      await db.insert(expenses).values({
        id: expId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        amountPaise: 150000n,
        taxableAmountPaise: 150000n,
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 0n,
        categoryId: null, // uncategorized
        paymentMethod: 'bank_transfer',
        expenseDate: new Date('2029-09-10T10:00:00Z'),
        description: 'September Uncategorized Employee Expense',
        status: 'recorded',
      });

      const [bankAcc] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '1110'),
          ),
        );
      const [genExpAcc] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(chartOfAccounts.code, '5100'),
          ),
        );

      await db.insert(journalEntries).values({
        id: jEntryId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        entryNumber: 'JE-2029-09-001',
        entryDate: new Date('2029-09-10T10:00:00Z'),
        sourceEntityType: 'expense',
        sourceEntityId: expId,
        narration: 'September uncategorized expense entry',
      });

      await db.insert(journalLines).values([
        {
          id: jLineDebitId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: jEntryId,
          accountId: genExpAcc!.id,
          debitPaise: 150000n,
          creditPaise: 0n,
        },
        {
          id: jLineCreditId,
          businessId: 'b0000000-0000-0000-0000-000000000001',
          journalEntryId: jEntryId,
          accountId: bankAcc!.id,
          debitPaise: 0n,
          creditPaise: 150000n,
        },
      ]);

      try {
        // Step 1: Employee scans month (scan is read-only)
        const scanRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9031,
            method: 'tools/call',
            params: { name: 'close_month', arguments: { month, year, step: 'scan' } },
          },
          { token: tenant1EmployeeSecret, sessionId: empSessionId, protocolVersion: '2025-11-25' },
        );
        expect(scanRes.status).toBe(200);

        // Step 2: Employee attempts categorise / journal reclassification
        const catRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9032,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: {
                month,
                year,
                step: 'categorise',
                payload: { allow_general_expense: true },
              },
            },
          },
          { token: tenant1EmployeeSecret, sessionId: empSessionId, protocolVersion: '2025-11-25' },
        );

        // Verify tool call returns error
        const isErrorResult =
          catRes.data?.error ||
          catRes.data?.result?.isError === true ||
          JSON.stringify(catRes.data).includes('UNAUTHORIZED');
        if (!isErrorResult) {
          console.error('FAILED catRes debug:', JSON.stringify(catRes));
        }
        expect(isErrorResult).toBeTruthy();
        expect(JSON.stringify(catRes.data)).toContain("User role 'member' is not authorized");

        // Verify database state: expense category is STILL null (not reclassified)
        const [expCheck] = await db
          .select({ categoryId: expenses.categoryId })
          .from(expenses)
          .where(eq(expenses.id, expId));
        expect(expCheck?.categoryId).toBeNull();

        // Verify journal line was NOT reclassified
        const [debitCheck] = await db
          .select({ accountId: journalLines.accountId })
          .from(journalLines)
          .where(eq(journalLines.id, jLineDebitId));
        expect(debitCheck?.accountId).toBe(genExpAcc!.id);
      } finally {
        await db.delete(journalLines).where(eq(journalLines.journalEntryId, jEntryId));
        await db.delete(journalEntries).where(eq(journalEntries.id, jEntryId));
        await db.delete(expenses).where(eq(expenses.id, expId));
        await db
          .delete(monthEndReports)
          .where(
            and(
              eq(monthEndReports.businessId, 'b0000000-0000-0000-0000-000000000001'),
              eq(monthEndReports.month, month),
              eq(monthEndReports.year, year),
            ),
          );
      }
    });

    it('security regression: rejects cross-tenant session key collision and prevents cross-tenant state access', async () => {
      const tenant2SessionKey = 'tenant2-private-isolated-session-key';
      const tenant2SessionId = 'c2000000-0000-0000-0000-000000000002';
      const tenant2ContextId = 'c3000000-0000-0000-0000-000000000002';

      // 1. Seed Tenant 2 session and confidential workflow state
      await db.insert(conversationSessions).values({
        id: tenant2SessionId,
        businessId: tenant2BizId,
        sessionKey: tenant2SessionKey,
        lastActiveAt: new Date(),
      });

      await db.insert(sessionContext).values({
        id: tenant2ContextId,
        sessionId: tenant2SessionId,
        activeWorkflowName: 'close_month',
        activeWorkflowState: {
          month: 11,
          year: 2026,
          step: 'scan',
          confidentialTenant2Data: 'super-secret-balance-12345',
        },
        updatedAt: new Date(),
      });

      try {
        // Direct helper assertion: resolveSessionContext MUST reject cross-tenant sessionKey
        await expect(
          resolveSessionContext(db, 'b0000000-0000-0000-0000-000000000001', tenant2SessionKey),
        ).rejects.toThrow('CROSS_TENANT_SESSION_COLLISION');

        // MCP Tool call assertion: Tenant 1 calls close_month specifying Tenant 2's sessionKey
        const initRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9040,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'tenant1-attacker-client', version: '1.0.0' },
            },
          },
          { protocolVersion: '2025-11-25' },
        );
        const tenant1TransportSessionId = initRes.sessionId!;

        const collisionRes = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 9041,
            method: 'tools/call',
            params: {
              name: 'close_month',
              arguments: {
                month: 11,
                year: 2026,
                step: 'scan',
                sessionId: tenant2SessionKey, // Attacker attempts to target Tenant 2's session
              },
            },
          },
          { sessionId: tenant1TransportSessionId, protocolVersion: '2025-11-25' },
        );

        const errorMsg = JSON.stringify(collisionRes.data);
        expect(errorMsg).toContain('CROSS_TENANT_SESSION_COLLISION');

        // Verify Tenant 2's session and session context are COMPLETELY UNTOUCHED
        const [tenant2SessionCheck] = await db
          .select()
          .from(conversationSessions)
          .where(eq(conversationSessions.id, tenant2SessionId));
        expect(tenant2SessionCheck?.businessId).toBe(tenant2BizId);
        expect(tenant2SessionCheck?.sessionKey).toBe(tenant2SessionKey);

        const [tenant2ContextCheck] = await db
          .select()
          .from(sessionContext)
          .where(eq(sessionContext.id, tenant2ContextId));
        expect(tenant2ContextCheck?.activeWorkflowName).toBe('close_month');
        expect((tenant2ContextCheck?.activeWorkflowState as any)?.confidentialTenant2Data).toBe(
          'super-secret-balance-12345',
        );
      } finally {
        await db.delete(sessionContext).where(eq(sessionContext.id, tenant2ContextId));
        await db.delete(conversationSessions).where(eq(conversationSessions.id, tenant2SessionId));
      }
    });
  });

  // -------------------------------------------------------------
  // Phase 6: Business Intelligence, Comparison & Anomaly Insights Suite
  // -------------------------------------------------------------
  describe('Phase 6: Business Intelligence, Comparison & Anomaly Insights Suite', () => {
    it('get_business_briefing: returns cashflow, receivables, GST status, anomalies, and UI card URI', async () => {
      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9501,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'bi-test-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );
      const testSessionId = initRes.sessionId!;

      // 1. Test today briefing
      const todayRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9502,
          method: 'tools/call',
          params: { name: 'get_business_briefing', arguments: { timeframe: 'today' } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(todayRes.status).toBe(200);
      const todayData = JSON.parse(todayRes.data.result.content[0].text);
      expect(todayData.timeframe).toBe('today');
      expect(todayData.cash_inflow).toBeDefined();
      expect(todayData.overdue_receivables).toBeDefined();
      expect(todayData.upcoming_bills).toBeDefined();
      expect(todayData.gst_status).toBeDefined();
      expect(todayData.gst_status.output_tax_formatted).toBeDefined();
      expect(todayData.gst_status.estimated_itc_formatted).toBeDefined();
      expect(todayData.action_items).toBeInstanceOf(Array);
      expect(todayData.anomalies).toBeInstanceOf(Array);
      expect(todayData.ui_resource_uri).toBe('ui://cards/business-briefing');

      // Voice summary check: strictly <= 2 sentences for TTS
      const sentences = todayData.voice_summary.split(/[.?!]\s+/).filter(Boolean);
      expect(sentences.length).toBeLessThanOrEqual(2);

      // 2. Test weekly briefing
      const weeklyRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9503,
          method: 'tools/call',
          params: { name: 'get_business_briefing', arguments: { timeframe: 'weekly' } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );
      expect(weeklyRes.status).toBe(200);
      const weeklyData = JSON.parse(weeklyRes.data.result.content[0].text);
      expect(weeklyData.timeframe).toBe('weekly');
    });

    it('cashflow_summary: computes preceding comparison period metrics and deltas when requested', async () => {
      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9510,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'cashflow-test-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );
      const testSessionId = initRes.sessionId!;

      // Call cashflow_summary with comparison_period: true
      const cfRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9511,
          method: 'tools/call',
          params: {
            name: 'cashflow_summary',
            arguments: {
              from_date: '2026-09-01T00:00:00Z',
              to_date: '2026-09-30T23:59:59Z',
              comparison_period: true,
            },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(cfRes.status).toBe(200);
      const cfData = JSON.parse(cfRes.data.result.content[0].text);
      expect(cfData.inflow_formatted).toBeDefined();
      expect(cfData.outflow_formatted).toBeDefined();
      expect(cfData.net_cashflow_formatted).toBeDefined();
      expect(cfData.major_movements).toBeInstanceOf(Array);

      // Verify comparison metrics
      expect(cfData.comparison).toBeDefined();
      expect(cfData.comparison.preceding_period).toBeDefined();
      expect(cfData.comparison.previous_inflow).toBeDefined();
      expect(cfData.comparison.previous_outflow).toBeDefined();
      expect(cfData.comparison.previous_net_cashflow).toBeDefined();
      expect(cfData.comparison.inflow_delta).toBeDefined();
      expect(cfData.comparison.outflow_delta).toBeDefined();
      expect(cfData.comparison.net_cashflow_delta).toBeDefined();
      expect(cfData.comparison.comparison_summary).toContain('Net cashflow');
    });

    it('whats_changed_since: detects new movements and surfaces factual anomaly insights with references', async () => {
      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9520,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'changed-test-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );
      const testSessionId = initRes.sessionId!;

      const baseline = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      const changedRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9521,
          method: 'tools/call',
          params: {
            name: 'whats_changed_since',
            arguments: { since_timestamp: baseline },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(changedRes.status).toBe(200);
      const changedData = JSON.parse(changedRes.data.result.content[0].text);
      expect(changedData.baseline_timestamp).toBe(baseline);
      expect(changedData.evaluation_timestamp).toBeDefined();
      expect(changedData.voice_summary).toBeDefined();
      expect(changedData.insights).toBeInstanceOf(Array);

      // If insights are returned, each must have factual underlying references
      for (const ins of changedData.insights) {
        expect(ins.id).toBeDefined();
        expect(ins.title).toBeDefined();
        expect(ins.underlyingReferences).toBeInstanceOf(Array);
        for (const ref of ins.underlyingReferences) {
          expect(ref.entityType).toBeDefined();
          expect(ref.formattedAmount).toBeDefined();
        }
      }
    });

    it('explain_transaction: breaks down invoice with balanced debits/credits, GST, and accounting impact', async () => {
      const seedInvoiceId = 'f0000000-0000-0000-0000-000000000001';

      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9530,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'explain-test-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );
      const testSessionId = initRes.sessionId!;

      // 1. Explain Invoice
      const invExplainRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9531,
          method: 'tools/call',
          params: {
            name: 'explain_transaction',
            arguments: { transaction_id: seedInvoiceId, entity_type: 'invoice' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(invExplainRes.status).toBe(200);
      const invData = JSON.parse(invExplainRes.data.result.content[0].text);
      expect(invData.entity_details.type).toBe('invoice');
      expect(invData.accounting_explanation.summary).toContain('Sales invoice issued');
      expect(invData.accounting_explanation.gst_treatment).toContain('Output GST');
      expect(invData.accounting_explanation.book_impact).toBeDefined();
      expect(invData.voice_summary).toContain('double-entry ledger');
      expect(invData.journal_entry).toBeDefined();
      expect(invData.journal_entry.is_balanced).toBe(true);
      expect(invData.journal_entry.lines.length).toBeGreaterThanOrEqual(2);

      // Verify that journal lines contain debits and credits
      const debits = invData.journal_entry.lines.filter((l: any) => l.debit_paise > 0);
      const credits = invData.journal_entry.lines.filter((l: any) => l.credit_paise > 0);
      expect(debits.length).toBeGreaterThan(0);
      expect(credits.length).toBeGreaterThan(0);

      // 2. Explain Expense
      const seedExpenseId = 'd0000000-0000-0000-0000-000000000001';
      const expExplainRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9532,
          method: 'tools/call',
          params: {
            name: 'explain_transaction',
            arguments: { transaction_id: seedExpenseId, entity_type: 'expense' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(expExplainRes.status).toBe(200);
      const expData = JSON.parse(expExplainRes.data.result.content[0].text);
      expect(expData.entity_details.type).toBe('expense');
      expect(expData.accounting_explanation.summary).toContain('Business expense');
      expect(expData.journal_entry.is_balanced).toBe(true);

      // 3. Tenant Isolation Check: Tenant 1 cannot explain Tenant 2's transaction
      const foreignId = 'd0000000-0000-0000-0000-000000000099';
      const foreignRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9533,
          method: 'tools/call',
          params: {
            name: 'explain_transaction',
            arguments: { transaction_id: foreignId, entity_type: 'expense' },
          },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      const errText = JSON.stringify(foreignRes.data);
      expect(errText).toContain('EXPENSE_NOT_FOUND');
    });

    it('get_audit_history: returns before/after state, confirmation status, and verifies cryptographic chain integrity', async () => {
      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9540,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'audit-test-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );
      const testSessionId = initRes.sessionId!;

      const auditRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9541,
          method: 'tools/call',
          params: { name: 'get_audit_history', arguments: { limit: 10 } },
        },
        { sessionId: testSessionId, protocolVersion: '2025-11-25' },
      );

      expect(auditRes.status).toBe(200);
      const auditData = JSON.parse(auditRes.data.result.content[0].text);
      expect(auditData.chain_integrity.is_valid).toBe(true);
      expect(auditData.chain_integrity.total_chain_entries).toBeGreaterThan(0);
      expect(auditData.chain_integrity.head_hash).toBeDefined();
      expect(auditData.voice_summary).toContain('intact');
      expect(auditData.ui_resource_uri).toBe('ui://cards/audit-activity');

      // Verify individual log entry properties
      expect(auditData.logs.length).toBeGreaterThan(0);
      const firstLog = auditData.logs[0];
      expect(firstLog.sequence_number).toBeDefined();
      expect(firstLog.request_id).toBeDefined();
      expect(firstLog.who).toBeDefined();
      expect(firstLog.action).toBeDefined();
      expect(firstLog.entry_hash).toBeDefined();
      expect(firstLog.prev_hash).toBeDefined();
      expect(firstLog.confirmation_status).toBeDefined();
    });

    it('regression: explain_transaction accurately reports unposted/missing journal entries conditionally', async () => {
      // 1. Insert an unposted expense without any journal entry
      const unpostedExpenseId = 'd0000000-0000-0000-0000-000000000888';
      await db.insert(expenses).values({
        id: unpostedExpenseId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        categoryId: 'e0000000-0000-0000-0000-000000000001',
        amountPaise: 750000n,
        taxableAmountPaise: 750000n,
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 0n,
        roundOffPaise: 0n,
        gstRateBps: 0,
        isItcClaimed: false,
        paymentMethod: 'bank_transfer',
        expenseDate: new Date(),
        description: 'Unposted equipment purchase',
        status: 'draft',
      });

      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9550,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'explain-unposted-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );

      const explainRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9551,
          method: 'tools/call',
          params: {
            name: 'explain_transaction',
            arguments: { transaction_id: unpostedExpenseId, entity_type: 'expense' },
          },
        },
        { sessionId: initRes.sessionId!, protocolVersion: '2025-11-25' },
      );

      expect(explainRes.status).toBe(200);
      const data = JSON.parse(explainRes.data.result.content[0].text);
      expect(data.integration_status).toBe('missing_journal_entry');
      expect(data.journal_entry).toBeNull();
      expect(data.voice_summary).toContain('does not have a posted double-entry journal entry yet');
    });

    it('regression: get_business_briefing enforces strict date bounds on cash inflow and separates upcoming bills from realized outflows', async () => {
      const now = new Date();
      const futureDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // +2 days
      const priorDate = new Date(now.getTime() - 36 * 60 * 60 * 1000); // -36 hours (prior window for daily)

      // 1. Insert future-dated payment (should NOT count as collected cash inflow in today briefing)
      await db.insert(payments).values({
        id: 'b0000000-0000-0000-0000-000000000777',
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId: 'c0000000-0000-0000-0000-000000000001',
        amountPaise: 999900n, // ₹9,999
        paymentDate: futureDate,
        paymentMode: 'bank_transfer',
        status: 'recorded',
      });

      // 2. Insert future-dated expense (should count in upcoming_bills, NOT in past outflows)
      await db.insert(expenses).values({
        id: 'd0000000-0000-0000-0000-000000000777',
        businessId: 'b0000000-0000-0000-0000-000000000001',
        categoryId: 'e0000000-0000-0000-0000-000000000001',
        amountPaise: 450000n, // ₹4,500 upcoming bill
        taxableAmountPaise: 450000n,
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 0n,
        roundOffPaise: 0n,
        gstRateBps: 0,
        isItcClaimed: false,
        paymentMethod: 'bank_transfer',
        expenseDate: futureDate,
        description: 'Upcoming Server Renewal Bill',
        status: 'posted',
      });

      // 3. Insert prior-window expense (should be in prior window, NOT current daily window)
      await db.insert(expenses).values({
        id: 'd0000000-0000-0000-0000-000000000778',
        businessId: 'b0000000-0000-0000-0000-000000000001',
        categoryId: 'e0000000-0000-0000-0000-000000000001',
        amountPaise: 200000n, // ₹2,000 in prior window
        taxableAmountPaise: 200000n,
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 0n,
        roundOffPaise: 0n,
        gstRateBps: 0,
        isItcClaimed: false,
        paymentMethod: 'bank_transfer',
        expenseDate: priorDate,
        description: 'Prior day software maintenance',
        status: 'posted',
      });

      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9560,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'bounds-test-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );

      const briefRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9561,
          method: 'tools/call',
          params: { name: 'get_business_briefing', arguments: { timeframe: 'today' } },
        },
        { sessionId: initRes.sessionId!, protocolVersion: '2025-11-25' },
      );

      expect(briefRes.status).toBe(200);
      const briefData = JSON.parse(briefRes.data.result.content[0].text);

      // Future payment must not be in cash_inflow
      expect(briefData.cash_inflow.paise).not.toBe(999900);

      // Future expenses and draft expenses are not misrepresented as upcoming vendor bills
      expect(briefData.upcoming_bills.paise).toBe(0);
      expect(briefData.upcoming_bills.note).toBe('No vendor bills due');

      // Voice summary must not claim books are "reconciled" without verification
      expect(briefData.voice_summary.toLowerCase()).not.toContain('reconciled');

      // Overdue receivables should separate overdue invoice count from total open invoices
      expect(briefData.overdue_receivables.overdue_invoices_count).toBeDefined();
      expect(briefData.overdue_receivables.open_invoices_count).toBeDefined();
      expect(briefData.overdue_receivables.overdue_invoices_count).toBeLessThanOrEqual(
        briefData.overdue_receivables.open_invoices_count,
      );

      // If voice summary mentions overdue invoices, it must mention the overdue count, not open invoices count
      if (briefData.overdue_receivables.overdue_invoices_count > 0) {
        expect(briefData.voice_summary).toContain(
          `${briefData.overdue_receivables.overdue_invoices_count} overdue invoice`,
        );
      }

      // GST status calculation must use IST calendar month
      const istMonth = parseInt(
        new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'numeric' }).format(
          now,
        ),
        10,
      );
      expect(briefData.gst_status.month).toBe(istMonth);

      // Briefing checkpoint must be recorded in businessMemory
      const [checkpoint] = await db
        .select()
        .from(businessMemory)
        .where(
          and(
            eq(businessMemory.businessId, 'b0000000-0000-0000-0000-000000000001'),
            eq(businessMemory.category, 'briefing_checkpoint'),
          ),
        );
      expect(checkpoint).toBeDefined();

      // Subsequent whats_changed_since with reference: 'last_briefing' resolves without falling back to random sessions
      const changedRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9562,
          method: 'tools/call',
          params: { name: 'whats_changed_since', arguments: { reference: 'last_briefing' } },
        },
        { sessionId: initRes.sessionId!, protocolVersion: '2025-11-25' },
      );

      expect(changedRes.status).toBe(200);
      const changedData = JSON.parse(changedRes.data.result.content[0].text);
      expect(changedData.baseline_timestamp).toBeDefined();
    });

    it('regression: whats_changed_since excludes draft and cancelled invoices from issued invoice counts and totals', async () => {
      const baseline = new Date(Date.now() + 1000);
      const invoiceCreatedAt = new Date(baseline.getTime() + 1000);

      // 1. Insert a draft invoice created after baseline
      const draftInvoiceId = 'f0000000-0000-0000-0000-000000000991';
      await db.insert(invoices).values({
        id: draftInvoiceId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId: 'c0000000-0000-0000-0000-000000000001',
        invoiceNumber: 'INV-REG-DRAFT-01',
        financialYear: '2026-27',
        issueDate: invoiceCreatedAt,
        dueDate: new Date(invoiceCreatedAt.getTime() + 15 * 24 * 60 * 60 * 1000),
        placeOfSupplyStateCode: '33',
        isInterState: false,
        subtotalPaise: 100000n,
        cgstPaise: 9000n,
        sgstPaise: 9000n,
        igstPaise: 0n,
        totalPaise: 118000n, // ₹1,180
        paidAmountPaise: 0n,
        roundOffPaise: 0n,
        status: 'draft',
        createdAt: invoiceCreatedAt,
      });

      // 2. Insert a cancelled invoice created after baseline
      const cancelledInvoiceId = 'f0000000-0000-0000-0000-000000000992';
      await db.insert(invoices).values({
        id: cancelledInvoiceId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId: 'c0000000-0000-0000-0000-000000000001',
        invoiceNumber: 'INV-REG-CANCEL-01',
        financialYear: '2026-27',
        issueDate: invoiceCreatedAt,
        dueDate: new Date(invoiceCreatedAt.getTime() + 15 * 24 * 60 * 60 * 1000),
        placeOfSupplyStateCode: '33',
        isInterState: false,
        subtotalPaise: 200000n,
        cgstPaise: 18000n,
        sgstPaise: 18000n,
        igstPaise: 0n,
        totalPaise: 236000n, // ₹2,360
        paidAmountPaise: 0n,
        roundOffPaise: 0n,
        status: 'cancelled',
        createdAt: invoiceCreatedAt,
      });

      // 3. Insert an issued invoice created after baseline
      const issuedInvoiceId = 'f0000000-0000-0000-0000-000000000993';
      await db.insert(invoices).values({
        id: issuedInvoiceId,
        businessId: 'b0000000-0000-0000-0000-000000000001',
        customerId: 'c0000000-0000-0000-0000-000000000001',
        invoiceNumber: 'INV-REG-ISSUED-01',
        financialYear: '2026-27',
        issueDate: invoiceCreatedAt,
        dueDate: new Date(invoiceCreatedAt.getTime() + 15 * 24 * 60 * 60 * 1000),
        placeOfSupplyStateCode: '33',
        isInterState: false,
        subtotalPaise: 500000n,
        cgstPaise: 45000n,
        sgstPaise: 45000n,
        igstPaise: 0n,
        totalPaise: 590000n, // ₹5,900
        paidAmountPaise: 0n,
        roundOffPaise: 0n,
        status: 'issued',
        createdAt: invoiceCreatedAt,
      });

      const initRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9570,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'whats-changed-status-client', version: '1.0.0' },
          },
        },
        { protocolVersion: '2025-11-25' },
      );

      const changedRes = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 9571,
          method: 'tools/call',
          params: {
            name: 'whats_changed_since',
            arguments: { since_timestamp: baseline.toISOString() },
          },
        },
        { sessionId: initRes.sessionId!, protocolVersion: '2025-11-25' },
      );

      expect(changedRes.status).toBe(200);
      const changedData = JSON.parse(changedRes.data.result.content[0].text);

      // Must only count the issued invoice (not draft or cancelled)
      expect(changedData.new_invoices_count).toBe(1);
      expect(changedData.new_invoices_total_paise).toBe(590000);
      expect(changedData.new_invoices_total_formatted).toBe('₹5,900.00');

      // The voice summary must reflect 1 invoice issued, never including the draft or cancelled invoices
      if (changedData.voice_summary.includes('issued')) {
        expect(changedData.voice_summary).toContain('1 invoice');
        expect(changedData.voice_summary).not.toContain('3 invoice');
      }
    });
  });
});
