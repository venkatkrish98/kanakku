import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route.js';
import { NextRequest } from 'next/server';
import { voiceOrchestrator } from '@/lib/bedrock/orchestrator';

vi.mock('@/lib/bedrock/orchestrator', () => ({
  voiceOrchestrator: {
    processTurn: vi.fn(),
  },
}));

vi.mock('@kanakku/db', () => ({
  getDatabase: vi.fn().mockReturnValue({}),
}));

const mockAuthenticateToken = vi.fn();
vi.mock('@kanakku/mcp-server', () => ({
  authenticateToken: (...args: any[]) => mockAuthenticateToken(...args),
}));

vi.mock('@/lib/mcp-client/client', () => {
  const MockMcpClient = vi.fn().mockImplementation((config: any) => ({
    token: config?.token,
    confirmAction: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Confirmed' }],
      _meta: { status: 'executed' },
    }),
    cancelAction: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Cancelled' }],
      _meta: { status: 'cancelled' },
    }),
  }));
  return {
    McpHttpClient: MockMcpClient,
  };
});

describe('Voice API Route Handler (/api/voice) Security & Authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated requests with 401 Unauthorized when Authorization header is missing', async () => {
    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      body: JSON.stringify({ transcript: 'Record expense of 500' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain('UNAUTHORIZED');
  });

  it('rejects invalid or expired token with 401 Unauthorized', async () => {
    mockAuthenticateToken.mockRejectedValue(new Error('Invalid token'));

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer invalid_secret_token_123',
      },
      body: JSON.stringify({ transcript: 'Record expense of 500' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain('UNAUTHORIZED');
  });

  it('blocks unauthorized roles (member) from executing confirm action with 403 Forbidden', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-123',
      userId: 'user-emp-99',
      userRole: 'member',
    });

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer employee_secret_token',
      },
      body: JSON.stringify({
        action: 'confirm',
        confirmationToken: 'tok_confirm_456',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('FORBIDDEN');
    expect(data.error).toContain("User role 'member' is not authorized to execute ledger writes");
  });

  it('blocks unauthorized roles (member) from confirming through a voice transcript with a pending token', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-123',
      userId: 'user-emp-99',
      userRole: 'member',
    });

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer employee_secret_token',
      },
      body: JSON.stringify({
        transcript: 'Yes, please confirm this transaction',
        pendingToken: 'tok_confirm_456',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('FORBIDDEN');
    expect(data.error).toContain("User role 'member' is not authorized to execute ledger writes");
    expect(voiceOrchestrator.processTurn).not.toHaveBeenCalled();
  });

  it('blocks unauthorized roles (member) from reclassifying journals via voice ("treat as general expenses") with 403 Forbidden', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-123',
      userId: 'user-emp-99',
      userRole: 'member',
    });

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer employee_secret_token',
      },
      body: JSON.stringify({
        transcript: 'Treat as general expenses',
        conversationHistory: [
          { role: 'user', content: 'Start month end close for September 2026' },
          { role: 'assistant', content: 'There are 2 uncategorized expenses.' },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('FORBIDDEN');
    expect(data.error).toContain("User role 'member' is not authorized to execute ledger writes");
    expect(voiceOrchestrator.processTurn).not.toHaveBeenCalled();
  });

  it('allows authorized roles (owner) to execute confirm action', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-123',
      userId: 'user-owner-1',
      userRole: 'owner',
    });

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner_secret_token',
      },
      body: JSON.stringify({
        action: 'confirm',
        confirmationToken: 'tok_confirm_456',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.spokenResponse).toContain('confirmed');
  });

  it('does NOT treat conditional utterances ("Yes, but don\'t post it yet") as confirmation intent', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-123',
      userId: 'user-owner-1',
      userRole: 'owner',
    });

    (voiceOrchestrator.processTurn as any).mockResolvedValue({
      spokenResponse:
        'Understood. I will not post the transaction. The draft remains on hold. You can say "confirm" when ready or "cancel" to discard.',
      toolCalls: [],
      confirmationToken: 'tok_confirm_456',
      actionRequired: 'confirm',
    });

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner_secret_token',
      },
      body: JSON.stringify({
        transcript: "Yes, but don't post it yet",
        pendingToken: 'tok_confirm_456',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.spokenResponse).toContain('will not post the transaction');
    expect(data.actionRequired).toBe('confirm');
    expect(data.toolCalls).toHaveLength(0);
  });

  it('does NOT treat hesitant cancellation ("No, don\'t cancel yet") as cancellation intent', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-123',
      userId: 'user-owner-1',
      userRole: 'owner',
    });

    (voiceOrchestrator.processTurn as any).mockResolvedValue({
      spokenResponse:
        'Understood. Keeping the draft on hold without any changes. You can say "confirm" when ready to post, or "cancel" to discard.',
      toolCalls: [],
      confirmationToken: 'tok_confirm_456',
      actionRequired: 'confirm',
    });

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner_secret_token',
      },
      body: JSON.stringify({
        transcript: "No, don't cancel yet",
        pendingToken: 'tok_confirm_456',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.spokenResponse).toContain('Keeping the draft on hold');
    expect(data.actionRequired).toBe('confirm');
    expect(data.toolCalls).toHaveLength(0);
  });

  it('rejects requests with missing transcript', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-123',
      userId: 'user-owner-1',
      userRole: 'owner',
    });

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner_secret_token',
      },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Missing or invalid transcript');
  });

  it('rejects transcript exceeding length limit of 1000 characters', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-123',
      userId: 'user-owner-1',
      userRole: 'owner',
    });

    const longTranscript = 'a'.repeat(1005);
    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner_secret_token',
      },
      body: JSON.stringify({ transcript: longTranscript }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('exceeds maximum allowed length');
  });

  it('handles authenticated voice turn and passes tenant context to orchestrator', async () => {
    mockAuthenticateToken.mockResolvedValue({
      businessId: 'biz-test-tenant-1',
      userId: 'user-test-owner-1',
      userRole: 'owner',
    });

    (voiceOrchestrator.processTurn as any).mockResolvedValue({
      spokenResponse: 'Prepared expense draft for ₹2,400.',
      toolCalls: [{ name: 'record_expense', args: {}, result: {} }],
      cardResourceUri: 'ui://cards/expense-draft',
      confirmationToken: 'tok_123',
      draftType: 'expense',
      actionRequired: 'confirm',
      draftSummary: { amountRupees: '2,400' },
    });

    const req = new NextRequest('http://localhost:3000/api/voice', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid_owner_token',
      },
      body: JSON.stringify({
        transcript: 'Record 2,400 for dinner',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.spokenResponse).toBe('Prepared expense draft for ₹2,400.');
    expect(data.confirmationToken).toBe('tok_123');
    expect(data.draftType).toBe('expense');
    expect(data.actionRequired).toBe('confirm');

    expect(voiceOrchestrator.processTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-test-tenant-1',
        userId: 'user-test-owner-1',
        userRole: 'owner',
      }),
    );
  });
});
