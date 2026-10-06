import { NextRequest, NextResponse } from 'next/server';
import { voiceOrchestrator } from '@/lib/bedrock/orchestrator';
import { McpHttpClient } from '@/lib/mcp-client/client';
import { getDatabase } from '@kanakku/db';
import { authenticateToken } from '@kanakku/mcp-server';
import {
  assertAuthorizedForLedgerWrite,
  AuthorizationError,
  isConfirmationIntent,
} from '@/lib/auth/authorization';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    // 1. Strict Server-Side Authentication & Tenant Isolation Check
    const authHeader = req.headers.get('authorization') || req.headers.get('x-api-key');
    if (!authHeader) {
      return NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED: Authentication token required in Authorization or X-Api-Key header',
        },
        { status: 401 },
      );
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED: Empty authentication token provided' },
        { status: 401 },
      );
    }

    // Verify token against database to extract businessId, userId, and userRole
    let tenantContext;
    try {
      const db = getDatabase();
      tenantContext = await authenticateToken(token, db);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : 'Invalid credentials';
      return NextResponse.json({ success: false, error: `UNAUTHORIZED: ${msg}` }, { status: 401 });
    }

    const body = await req.json();
    const { transcript, conversationHistory, pendingToken, action, confirmationToken, reason } =
      body;

    // Construct MCP client strictly bound to the authenticated caller's verified token
    const mcpClient = new McpHttpClient({
      baseUrl: process.env.MCP_SERVER_URL || 'http://127.0.0.1:3001',
      token,
    });

    // 2. Explicit Button Action Handling (Confirm / Cancel from UI Card)
    if (action === 'confirm') {
      if (!confirmationToken || typeof confirmationToken !== 'string') {
        return NextResponse.json(
          { success: false, error: 'BAD_REQUEST: Missing confirmation_token for confirm action' },
          { status: 400 },
        );
      }

      // Shared Server-Side Authorization Boundary: Verify user role has financial write execution privilege
      assertAuthorizedForLedgerWrite(tenantContext.userRole);

      const result = await mcpClient.confirmAction(confirmationToken);
      return NextResponse.json({
        success: true,
        spokenResponse: 'Transaction confirmed and posted to the double-entry books.',
        toolCalls: [
          { name: 'confirm_action', args: { confirmation_token: confirmationToken }, result },
        ],
        actionRequired: 'none',
      });
    }

    if (action === 'cancel') {
      if (!confirmationToken || typeof confirmationToken !== 'string') {
        return NextResponse.json(
          { success: false, error: 'BAD_REQUEST: Missing confirmation_token for cancel action' },
          { status: 400 },
        );
      }

      const result = await mcpClient.cancelAction(
        confirmationToken,
        reason || 'Cancelled by authenticated user',
      );
      return NextResponse.json({
        success: true,
        spokenResponse: 'Draft cancelled and discarded. Books are untouched.',
        toolCalls: [
          { name: 'cancel_action', args: { confirmation_token: confirmationToken }, result },
        ],
        actionRequired: 'none',
      });
    }

    // 3. Voice Turn Processing & Input Validation
    if (!transcript || typeof transcript !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid transcript' },
        { status: 400 },
      );
    }

    if (transcript.length > 1000) {
      return NextResponse.json(
        { success: false, error: 'Transcript exceeds maximum allowed length of 1000 characters' },
        { status: 400 },
      );
    }

    // Shared Server-Side Authorization Boundary:
    // If confirming a pending draft via voice transcript, enforce the exact same role gate
    if (pendingToken && isConfirmationIntent(transcript)) {
      assertAuthorizedForLedgerWrite(tenantContext.userRole);
    }

    // Role Gate: Reclassifying expenses and updating accounting journals during month close requires owner or accountant
    const lowerTranscript = transcript.toLowerCase();
    const isCategorisationIntent =
      lowerTranscript.includes('general expense') ||
      lowerTranscript.includes('general operational') ||
      lowerTranscript.includes('allow general') ||
      lowerTranscript.includes('approve general') ||
      lowerTranscript.includes('treat as general') ||
      lowerTranscript.includes('classify as general') ||
      lowerTranscript.includes('put as general');

    if (isCategorisationIntent) {
      assertAuthorizedForLedgerWrite(tenantContext.userRole);
    }

    // Sanitize conversation history: bound size to 10 items, truncate content to 500 chars
    const sanitizedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = Array.isArray(
      conversationHistory,
    )
      ? conversationHistory.slice(-10).map((item) => ({
          role: item.role === 'assistant' ? 'assistant' : 'user',
          content: String(item.content || '').slice(0, 500),
        }))
      : [];

    const turnResponse = await voiceOrchestrator.processTurn({
      transcript,
      conversationHistory: sanitizedHistory,
      pendingToken: pendingToken || null,
      businessId: tenantContext.businessId,
      userId: tenantContext.userId,
      userRole: tenantContext.userRole,
      client: mcpClient,
    });

    return NextResponse.json({
      success: true,
      ...turnResponse,
    });
  } catch (error: unknown) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          spokenResponse: `Cannot confirm transaction: User role '${error.role ?? 'unknown'}' is not authorized to execute ledger writes. Only an owner or accountant can confirm.`,
        },
        { status: 403 },
      );
    }

    console.error('Voice API error:', error);
    const msg = error instanceof Error ? error.message : 'Internal Server Error';
    return NextResponse.json(
      {
        success: false,
        error: msg,
        spokenResponse: `I encountered an issue processing that: ${msg}`,
      },
      { status: 500 },
    );
  }
}
