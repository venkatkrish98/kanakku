import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceOrchestrator, type VoiceTurnRequest, ALLOWED_BEDROCK_TOOLS } from './orchestrator';
import { McpHttpClient, type McpToolCallResult } from '../mcp-client/client';

describe('VoiceOrchestrator & Deterministic Intent Engine (Phase 4 Hardened)', () => {
  let orchestrator: VoiceOrchestrator;
  let mockMcpClient: McpHttpClient;

  beforeEach(() => {
    orchestrator = new VoiceOrchestrator();

    mockMcpClient = {
      callTool: vi.fn(),
      confirmAction: vi.fn(),
      cancelAction: vi.fn(),
      listTools: vi.fn().mockResolvedValue([]),
      readResource: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('mock-session-123'),
      setSessionId: vi.fn(),
      initialize: vi.fn(),
    } as unknown as McpHttpClient;
  });

  it('asks for clarification when an expense transcript is missing an amount (no silent defaults)', async () => {
    const req: VoiceTurnRequest = {
      transcript: 'Record expense for dinner with clients',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    // Must NOT call record_expense tool with an invented amount!
    expect(mockMcpClient.callTool).not.toHaveBeenCalled();
    expect(response.actionRequired).toBe('clarify');
    expect(response.spokenResponse).toContain('How much was the expense?');
  });

  it('asks for clarification when an invoice transcript is missing an amount (no silent defaults)', async () => {
    const req: VoiceTurnRequest = {
      transcript: 'Create invoice for TechCorp Solutions',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    // Must NOT call create_invoice tool with an invented amount!
    expect(mockMcpClient.callTool).not.toHaveBeenCalled();
    expect(response.actionRequired).toBe('clarify');
    expect(response.spokenResponse).toContain('What is the invoice amount');
    expect(response.spokenResponse).toContain('TechCorp');
  });

  it('correctly maps expense voice command with amount to record_expense and yields expense draft', async () => {
    const mockToolResult: McpToolCallResult = {
      content: [{ type: 'text', text: 'Expense draft created for ₹2,400.' }],
      _meta: {
        'ui/resourceUri': 'ui://cards/expense-draft',
        draft_id: 'd-12345',
        confirmation_token: 'test_token_exp_999',
      },
    };

    (mockMcpClient.callTool as any).mockResolvedValue(mockToolResult);

    const req: VoiceTurnRequest = {
      transcript: 'Record 2,400 expense for Swiggy client dinner paid via UPI',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    expect(mockMcpClient.callTool).toHaveBeenCalledWith(
      'record_expense',
      expect.objectContaining({
        amount_paise: 240000,
        payment_method: 'upi',
      }),
    );

    expect(response.actionRequired).toBe('confirm');
    expect(response.draftType).toBe('expense');
    expect(response.confirmationToken).toBe('test_token_exp_999');
    expect(response.cardResourceUri).toBe('ui://cards/expense-draft');
    expect(response.spokenResponse).toContain('₹2,400');
    expect(response.spokenResponse).toContain('confirm');
  });

  it('correctly maps invoice creation command with amount to create_invoice and yields invoice draft', async () => {
    const mockToolResult: McpToolCallResult = {
      content: [{ type: 'text', text: 'Invoice draft prepared.' }],
      _meta: {
        'ui/resourceUri': 'ui://cards/invoice-draft',
        draft_id: 'inv-draft-001',
        total_paise: 5900000,
        confirmation_token: 'test_token_inv_888',
      },
    };

    (mockMcpClient.callTool as any).mockResolvedValue(mockToolResult);

    const req: VoiceTurnRequest = {
      transcript: 'Create invoice for TechCorp for 50,000 rupees with 18% GST',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    expect(mockMcpClient.callTool).toHaveBeenCalledWith(
      'create_invoice',
      expect.objectContaining({
        customer_name: expect.stringContaining('TechCorp'),
      }),
    );

    expect(response.actionRequired).toBe('confirm');
    expect(response.draftType).toBe('invoice');
    expect(response.confirmationToken).toBe('test_token_inv_888');
    expect(response.spokenResponse).toContain('TechCorp');
  });

  it('strictly excludes confirm_action and cancel_action from Bedrock allowed tool set', () => {
    expect(ALLOWED_BEDROCK_TOOLS.has('confirm_action')).toBe(false);
    expect(ALLOWED_BEDROCK_TOOLS.has('cancel_action')).toBe(false);
    expect(ALLOWED_BEDROCK_TOOLS.has('record_expense')).toBe(true);
    expect(ALLOWED_BEDROCK_TOOLS.has('create_invoice')).toBe(true);
    expect(ALLOWED_BEDROCK_TOOLS.has('get_gst_liability')).toBe(true);
  });

  it('executes confirm_action when human user says "confirm" with an authorized owner role', async () => {
    const mockConfirmResult: McpToolCallResult = {
      content: [{ type: 'text', text: 'Expense successfully recorded to double-entry ledger.' }],
      _meta: {
        entity_id: 'e-999',
        action_type: 'record_expense',
      },
    };

    (mockMcpClient.confirmAction as any).mockResolvedValue(mockConfirmResult);

    const req: VoiceTurnRequest = {
      transcript: 'Confirm it',
      pendingToken: 'test_token_exp_999',
      userRole: 'owner',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    expect(mockMcpClient.confirmAction).toHaveBeenCalledWith('test_token_exp_999');
    expect(response.actionRequired).toBe('none');
    expect(response.spokenResponse).toContain('confirmed and posted');
  });

  it('blocks voice confirmation and throws AuthorizationError when userRole is "member"', async () => {
    const req: VoiceTurnRequest = {
      transcript: 'Proceed and confirm',
      pendingToken: 'test_token_exp_999',
      userRole: 'member',
      client: mockMcpClient,
    };

    await expect(orchestrator.processTurn(req)).rejects.toThrow(
      "FORBIDDEN: User role 'member' is not authorized to execute ledger writes",
    );
    expect(mockMcpClient.confirmAction).not.toHaveBeenCalled();
  });

  it('does NOT confirm transaction when user utterance is conditional or contradictory (e.g. "Yes, but don’t post it yet")', async () => {
    const req: VoiceTurnRequest = {
      transcript: "Yes, but don't post it yet",
      pendingToken: 'test_token_exp_999',
      userRole: 'owner',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    expect(mockMcpClient.confirmAction).not.toHaveBeenCalled();
    expect(response.toolCalls).toHaveLength(0);
    expect(response.spokenResponse).toContain('will not post the transaction');
    expect(response.actionRequired).toBe('confirm');
    expect(response.confirmationToken).toBe('test_token_exp_999');
  });

  it('does NOT cancel transaction when user utterance is hesitant or contradictory (e.g. "No, don’t cancel yet")', async () => {
    const req: VoiceTurnRequest = {
      transcript: "No, don't cancel yet",
      pendingToken: 'test_token_exp_999',
      userRole: 'owner',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    expect(mockMcpClient.cancelAction).not.toHaveBeenCalled();
    expect(mockMcpClient.confirmAction).not.toHaveBeenCalled();
    expect(response.toolCalls).toHaveLength(0);
    expect(response.spokenResponse).toContain('Keeping the draft on hold');
    expect(response.actionRequired).toBe('confirm');
    expect(response.confirmationToken).toBe('test_token_exp_999');
  });

  it('executes cancel_action when human user says "cancel" with a pending draft token', async () => {
    const mockCancelResult: McpToolCallResult = {
      content: [{ type: 'text', text: 'Draft cancelled.' }],
      _meta: {
        status: 'cancelled',
      },
    };

    (mockMcpClient.cancelAction as any).mockResolvedValue(mockCancelResult);

    const req: VoiceTurnRequest = {
      transcript: 'No, cancel this draft',
      pendingToken: 'test_token_exp_999',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    expect(mockMcpClient.cancelAction).toHaveBeenCalledWith('test_token_exp_999', 'Cancelled via voice');
    expect(response.actionRequired).toBe('none');
    expect(response.spokenResponse).toContain('Cancelled');
  });

  it('routes query "who owes me money?" to list_outstanding_invoices', async () => {
    const mockResult: McpToolCallResult = {
      content: [
        {
          type: 'text',
          text: 'Total outstanding is ₹1,25,000 across 3 invoices.\n- Ravi Traders: ₹45,000 (Overdue)',
        },
      ],
    };

    (mockMcpClient.callTool as any).mockResolvedValue(mockResult);

    const req: VoiceTurnRequest = {
      transcript: 'Who owes me money?',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    expect(mockMcpClient.callTool).toHaveBeenCalledWith('list_outstanding_invoices', {});
    expect(response.actionRequired).toBe('none');
    expect(response.spokenResponse).toContain('₹1,25,000');
  });

  it('routes query "What is my GST liability for this month?" to get_gst_liability', async () => {
    const mockResult: McpToolCallResult = {
      content: [
        {
          type: 'text',
          text: 'Net GST payable for this month is ₹18,400.\nOutput: ₹36,000, Estimated ITC: ₹17,600.',
        },
      ],
    };

    (mockMcpClient.callTool as any).mockResolvedValue(mockResult);

    const req: VoiceTurnRequest = {
      transcript: 'What is my GST liability for this month?',
      client: mockMcpClient,
    };

    const response = await orchestrator.processTurn(req);

    expect(mockMcpClient.callTool).toHaveBeenCalledWith('get_gst_liability', expect.any(Object));
    expect(response.actionRequired).toBe('none');
    expect(response.spokenResponse).toContain('₹18,400');
  });

  describe('Phase 5: Voice Multi-Turn Month-End Close State Machine', () => {
    it('handles multi-turn month close flow with clarification for uncategorized expenses and owner confirmation', async () => {
      // Turn 1: Initial user utterance triggering close for September 2026
      const scanResult: McpToolCallResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              step: 'scan',
              status: 'scan_complete',
              month: 9,
              year: 2026,
              uncategorized_expenses_count: 2,
            }),
          },
        ],
      };
      (mockMcpClient.callTool as any).mockResolvedValueOnce(scanResult);

      const turn1Req: VoiceTurnRequest = {
        transcript: 'Start month end close for September 2026',
        client: mockMcpClient,
      };

      const turn1Res = await orchestrator.processTurn(turn1Req);

      expect(mockMcpClient.callTool).toHaveBeenCalledWith('close_month', {
        month: 9,
        year: 2026,
        step: 'resume',
      });
      expect(turn1Res.actionRequired).toBe('clarify');
      expect(turn1Res.draftType).toBe('month_close');
      expect(turn1Res.spokenResponse).toContain('2 uncategorized expenses');
      expect(turn1Res.spokenResponse).toContain('general operational expenses');

      // Turn 2: User responds to clarification approving general expenses
      const catResult: McpToolCallResult = {
        content: [{ type: 'text', text: JSON.stringify({ step: 'categorise', allow_general_expense: true }) }],
      };
      const recResult: McpToolCallResult = {
        content: [{ type: 'text', text: JSON.stringify({ step: 'reconcile', ledger_balanced: true }) }],
      };
      const prepResult: McpToolCallResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              step: 'prepare_close',
              status: 'pending_confirmation',
              confirmation_token: 'tok_close_sep_2026_abc123',
              ui_resource_uri: 'ui://cards/month-end-summary/9/2026',
            }),
          },
        ],
        _meta: {
          confirmation_token: 'tok_close_sep_2026_abc123',
          'ui/resourceUri': 'ui://cards/month-end-summary/9/2026',
        },
      };

      (mockMcpClient.callTool as any).mockClear();
      (mockMcpClient.callTool as any)
        .mockResolvedValueOnce(catResult)
        .mockResolvedValueOnce(recResult)
        .mockResolvedValueOnce(prepResult);

      const turn2Req: VoiceTurnRequest = {
        transcript: 'Treat as general expenses',
        conversationHistory: [
          { role: 'user', content: 'Start month end close for September 2026' },
          { role: 'assistant', content: turn1Res.spokenResponse },
        ],
        userRole: 'owner',
        client: mockMcpClient,
      };

      const turn2Res = await orchestrator.processTurn(turn2Req);

      expect(mockMcpClient.callTool).toHaveBeenCalledWith('close_month', {
        month: 9,
        year: 2026,
        step: 'categorise',
        payload: { allow_general_expense: true },
      });
      expect(mockMcpClient.callTool).toHaveBeenCalledWith('close_month', {
        month: 9,
        year: 2026,
        step: 'reconcile',
        payload: { allow_general_expense: true },
      });
      expect(mockMcpClient.callTool).toHaveBeenCalledWith('close_month', {
        month: 9,
        year: 2026,
        step: 'prepare_close',
        payload: { allow_general_expense: true },
      });

      expect(turn2Res.actionRequired).toBe('confirm');
      expect(turn2Res.confirmationToken).toBe('tok_close_sep_2026_abc123');
      expect(turn2Res.cardResourceUri).toBe('ui://cards/month-end-summary/9/2026');
      expect(turn2Res.spokenResponse).toContain('Reconciliation verified');

      // Turn 3: Owner user confirms the prepared month close
      const confirmResult: McpToolCallResult = {
        content: [{ type: 'text', text: 'Month 9/2026 closed.' }],
        _meta: { status: 'executed' },
      };
      (mockMcpClient.confirmAction as any).mockResolvedValueOnce(confirmResult);

      const turn3Req: VoiceTurnRequest = {
        transcript: 'Yes, lock the books',
        pendingToken: 'tok_close_sep_2026_abc123',
        userRole: 'owner',
        client: mockMcpClient,
      };

      const turn3Res = await orchestrator.processTurn(turn3Req);

      expect(mockMcpClient.confirmAction).toHaveBeenCalledWith('tok_close_sep_2026_abc123');
      expect(turn3Res.actionRequired).toBe('none');
      expect(turn3Res.spokenResponse).toContain('confirmed and posted');
    });

    it('blocks unauthorized member role from executing general expense categorisation (journal reclassification)', async () => {
      const req: VoiceTurnRequest = {
        transcript: 'Treat as general expenses',
        conversationHistory: [
          { role: 'user', content: 'Start month end close for September 2026' },
          { role: 'assistant', content: 'There are 2 uncategorized expenses.' },
        ],
        userRole: 'member',
        client: mockMcpClient,
      };

      await expect(orchestrator.processTurn(req)).rejects.toThrow(
        "User role 'member' is not authorized to execute ledger writes",
      );
      expect(mockMcpClient.callTool).not.toHaveBeenCalled();
    });

    it('auto-advances to prepare_close when month has zero uncategorized expenses', async () => {
      const scanResult: McpToolCallResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              step: 'scan',
              status: 'scan_complete',
              month: 10,
              year: 2026,
              uncategorized_expenses_count: 0,
            }),
          },
        ],
      };
      const recResult: McpToolCallResult = {
        content: [{ type: 'text', text: JSON.stringify({ step: 'reconcile', ledger_balanced: true }) }],
      };
      const prepResult: McpToolCallResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              step: 'prepare_close',
              status: 'pending_confirmation',
              confirmation_token: 'tok_close_oct_2026_xyz',
              ui_resource_uri: 'ui://cards/month-end-summary/10/2026',
            }),
          },
        ],
        _meta: {
          confirmation_token: 'tok_close_oct_2026_xyz',
          'ui/resourceUri': 'ui://cards/month-end-summary/10/2026',
        },
      };

      (mockMcpClient.callTool as any)
        .mockResolvedValueOnce(scanResult)
        .mockResolvedValueOnce(recResult)
        .mockResolvedValueOnce(prepResult);

      const req: VoiceTurnRequest = {
        transcript: 'Close month for October 2026',
        client: mockMcpClient,
      };

      const res = await orchestrator.processTurn(req);

      expect(mockMcpClient.callTool).toHaveBeenCalledWith('close_month', {
        month: 10,
        year: 2026,
        step: 'resume',
      });
      expect(mockMcpClient.callTool).toHaveBeenCalledWith('close_month', {
        month: 10,
        year: 2026,
        step: 'reconcile',
      });
      expect(mockMcpClient.callTool).toHaveBeenCalledWith('close_month', {
        month: 10,
        year: 2026,
        step: 'prepare_close',
      });

      expect(res.actionRequired).toBe('confirm');
      expect(res.confirmationToken).toBe('tok_close_oct_2026_xyz');
      expect(res.cardResourceUri).toBe('ui://cards/month-end-summary/10/2026');
      expect(res.spokenResponse).toContain('Reconciliation verified');
    });

    it('informs user when month is already closed and books are locked', async () => {
      const alreadyClosedResult: McpToolCallResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'already_closed',
              month: 9,
              year: 2026,
            }),
          },
        ],
      };

      (mockMcpClient.callTool as any).mockResolvedValueOnce(alreadyClosedResult);

      const req: VoiceTurnRequest = {
        transcript: 'Close month for September 2026',
        client: mockMcpClient,
      };

      const res = await orchestrator.processTurn(req);

      expect(res.actionRequired).toBe('none');
      expect(res.spokenResponse).toContain('already closed');
      expect(res.spokenResponse).toContain('locked');
    });
  });

  describe('Phase 6: Business Intelligence & Anomaly Insights Intents', () => {
    it('handles weekly business briefing intent and returns briefing card', async () => {
      const briefingResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              timeframe: 'weekly',
              voice_summary: 'You collected ₹1,50,000 this week with zero overdue receivables.',
              ui_resource_uri: 'ui://cards/business-briefing',
            }),
          },
        ],
      };

      (mockMcpClient.callTool as any).mockResolvedValueOnce(briefingResult);

      const res = await orchestrator.processTurn({
        transcript: 'Give me a weekly business briefing',
        client: mockMcpClient,
      });

      expect(mockMcpClient.callTool).toHaveBeenCalledWith('get_business_briefing', {
        timeframe: 'weekly',
      });
      expect(res.spokenResponse).toContain('collected ₹1,50,000 this week');
      expect(res.cardResourceUri).toBe('ui://cards/business-briefing');
      expect(res.actionRequired).toBe('none');
    });

    it('handles cashflow comparison intent with comparison_period true', async () => {
      const cashflowResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              inflow_formatted: '₹2,00,000.00',
              outflow_formatted: '₹50,000.00',
              net_cashflow_formatted: '₹1,50,000.00',
              comparison: {
                comparison_summary: 'Net cashflow increased by ₹50,000.00 compared to preceding period.',
              },
            }),
          },
        ],
      };

      (mockMcpClient.callTool as any).mockResolvedValueOnce(cashflowResult);

      const res = await orchestrator.processTurn({
        transcript: 'Compare cashflow with last month',
        client: mockMcpClient,
      });

      expect(mockMcpClient.callTool).toHaveBeenCalledWith(
        'cashflow_summary',
        expect.objectContaining({ comparison_period: true }),
      );
      expect(res.spokenResponse).toContain('Net cashflow increased by ₹50,000.00');
      expect(res.actionRequired).toBe('none');
    });

    it('handles whats_changed intent with week reference resolution', async () => {
      const changedResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              voice_summary: 'Since last week, you collected ₹80,000 across 2 customer payments.',
            }),
          },
        ],
      };

      (mockMcpClient.callTool as any).mockResolvedValueOnce(changedResult);

      const res = await orchestrator.processTurn({
        transcript: 'What changed this week?',
        client: mockMcpClient,
      });

      expect(mockMcpClient.callTool).toHaveBeenCalledWith('whats_changed_since', {
        reference: 'last_week',
      });
      expect(res.spokenResponse).toContain('collected ₹80,000 across 2 customer payments');
      expect(res.actionRequired).toBe('none');
    });

    it('handles explain_transaction intent for UUID with double-entry accounting explanation', async () => {
      const targetId = 'e0000000-0000-0000-0000-000000000001';
      const explainResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              voice_summary: 'This expense for Acme Office has been verified in the double-entry ledger. Total debits and credits equal ₹2,400.00.',
              accounting_explanation: {
                summary: 'Business expense for office supplies. Debited Expense Account and credited Bank.',
              },
            }),
          },
        ],
      };

      (mockMcpClient.callTool as any).mockResolvedValueOnce(explainResult);

      const res = await orchestrator.processTurn({
        transcript: `Explain expense ${targetId}`,
        client: mockMcpClient,
      });

      expect(mockMcpClient.callTool).toHaveBeenCalledWith('explain_transaction', {
        transaction_id: targetId,
        entity_type: 'expense',
      });
      expect(res.spokenResponse).toContain('verified in the double-entry ledger');
      expect(res.actionRequired).toBe('none');
    });

    it('clarifies when explain intent is called without a transaction ID', async () => {
      const res = await orchestrator.processTurn({
        transcript: 'Explain this transaction please',
        client: mockMcpClient,
      });

      expect(mockMcpClient.callTool).not.toHaveBeenCalled();
      expect(res.actionRequired).toBe('clarify');
      expect(res.spokenResponse).toContain('Which transaction would you like me to explain?');
    });
  });
});
