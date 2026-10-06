import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { KanakkuDatabase } from '@kanakku/db';
import { getDatabase, pendingConfirmations } from '@kanakku/db';
import { eq, and } from 'drizzle-orm';
import {
  authenticateToken,
  tenantContextStorage,
  type AuthenticatedTenantContext,
} from './auth/index.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { McpAppsHostBridge, BROWSER_HOST_LISTENER_SCRIPT, safeJsonForHtml } from './apps/index.js';
import { renderInvoiceCardHtml, renderExpenseCardHtml } from './resources/cards.js';

export interface McpSession {
  sessionId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  tenantContext: AuthenticatedTenantContext;
  createdAt: number;
  lastActiveAt: number;
}

export class McpSessionManager {
  private sessions = new Map<string, McpSession>();

  constructor(private db: KanakkuDatabase) { }

  public createSession(tenantContext: AuthenticatedTenantContext): McpSession {
    const sessionId = randomUUID();
    const server = new McpServer({
      name: 'kanakku',
      version: '0.1.0',
    });

    registerTools(server, this.db);
    registerResources(server, this.db);
    registerPrompts(server, this.db);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
      onsessionclosed: (closedId) => {
        this.sessions.delete(closedId);
      },
    });

    server.connect(transport);

    const session: McpSession = {
      sessionId,
      server,
      transport,
      tenantContext,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  public getSession(sessionId: string): McpSession | undefined {
    // Cleanup expired sessions (30-minute TTL)
    this.cleanupExpiredSessions();

    const session = this.sessions.get(sessionId);
    if (session) {
      if (Date.now() - session.lastActiveAt > 30 * 60 * 1000) {
        this.closeSession(sessionId);
        return undefined;
      }
      session.lastActiveAt = Date.now();
    }
    return session;
  }

  public cleanupExpiredSessions(ttlMs: number = 30 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActiveAt > ttlMs) {
        session.transport.close().catch(() => { });
        this.sessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  public closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.transport.close().catch(() => { });
      this.sessions.delete(sessionId);
    }
  }

  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  public findSessionForUser(businessId: string, userId: string): McpSession | undefined {
    this.cleanupExpiredSessions();
    for (const session of this.sessions.values()) {
      if (
        session.tenantContext.businessId === businessId &&
        session.tenantContext.userId === userId
      ) {
        session.lastActiveAt = Date.now();
        return session;
      }
    }
    return undefined;
  }
}

export interface HttpServerOptions {
  db?: KanakkuDatabase;
  port?: number;
  serverUrl?: string;
  allowedOrigins?: string[];
}

/**
 * Creates and configures the self-hosted Kanakku MCP HTTP Server.
 * Implements Streamable HTTP endpoint at /mcp adhering to MCP 2025-11-25+.
 */
export function createHttpServer(options: HttpServerOptions = {}) {
  const db = options.db ?? getDatabase();
  const sessionManager = new McpSessionManager(db);
  const allowedOrigins = options.allowedOrigins ?? (
    process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000'
  ).split(',').map((s) => s.trim());

  const server = http.createServer(async (req, res) => {
    // 1. CORS Headers with origin restriction
    const origin = req.headers['origin'];
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Authorization, X-Tenant-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Mcp-Ui-Support',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, X-Mcp-Ui-Support');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // 2. Health Check Endpoint
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'kanakku-mcp-server',
          protocol_version: '2025-11-25',
          active_sessions: sessionManager.getActiveSessionCount(),
          capabilities: {
            tools: true,
            resources: true,
            prompts: true,
            mcp_apps_ui: true,
            app_bridge: true,
            extensions: {
              'io.modelcontextprotocol/ui': {},
            },
          },
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // 3. MCP Streamable HTTP Endpoint (/mcp)
    if (url.pathname === '/mcp') {
      try {
        // Extract Authentication Token strictly from Authorization or X-Tenant-Key
        const authHeader = req.headers['authorization'] ?? (req.headers['x-tenant-key'] as string);

        let tokenToVerify = '';
        if (authHeader) {
          tokenToVerify = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
        }

        if (!tokenToVerify) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'UNAUTHENTICATED',
              message: 'Authentication required. Provide "Authorization: Bearer <secretKey>" or "X-Tenant-Key" header.',
            }),
          );
          return;
        }

        // Authenticate Tenant Context
        let tenantContext: AuthenticatedTenantContext;
        try {
          tenantContext = await authenticateToken(tokenToVerify, db);
        } catch (authErr: unknown) {
          const authMsg = authErr instanceof Error ? authErr.message : 'Invalid credentials';
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'INVALID_CREDENTIALS',
              message: authMsg,
            }),
          );
          return;
        }

        // Handle Session Routing
        const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;

        // Graceful Session Termination via DELETE /mcp
        if (req.method === 'DELETE') {
          if (sessionIdHeader) {
            sessionManager.closeSession(sessionIdHeader);
          }
          res.writeHead(204);
          res.end();
          return;
        }

        let session: McpSession | undefined;
        if (sessionIdHeader) {
          session = sessionManager.getSession(sessionIdHeader);
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32001,
                  message: `Session not found: "${sessionIdHeader}". It may have expired.`,
                },
                id: null,
              }),
            );
            return;
          }

          // Enforce Tenant AND User Isolation on Session: session must match current caller's business AND user
          if (
            session.tenantContext.businessId !== tenantContext.businessId ||
            session.tenantContext.userId !== tenantContext.userId
          ) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'FORBIDDEN',
                message: 'Cross-user or cross-tenant session access denied',
              }),
            );
            return;
          }
        } else {
          // New session creation
          session = sessionManager.createSession(tenantContext);
        }

        // Attach Auth info for SDK compatibility
        const reqWithAuth = req as http.IncomingMessage & { auth?: unknown };
        reqWithAuth.auth = {
          token: tokenToVerify,
          clientId: tenantContext.userId,
          scopes: [tenantContext.userRole],
          extra: tenantContext,
        };

        // Attach sessionId to tenantContext for durable workflow tracking
        tenantContext.sessionId = session!.sessionId;

        // Execute request inside AsyncLocalStorage tenant context
        await tenantContextStorage.run(tenantContext, async () => {
          await session!.transport.handleRequest(req, res);
        });
      } catch (err: unknown) {
        if (!res.headersSent) {
          const errMsg = err instanceof Error ? err.message : 'Internal Server Error';
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: errMsg,
              },
              id: null,
            }),
          );
        }
      }
      return;
    }

    // 4. MCP Apps Host Bridge Endpoint (/mcp/app-bridge)
    if (url.pathname === '/mcp/app-bridge' || url.pathname === '/apps/message') {
      try {
        const authHeader = req.headers['authorization'] ?? (req.headers['x-tenant-key'] as string);
        let tokenToVerify = '';
        if (authHeader) {
          tokenToVerify = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
        }

        const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;
        const activeSession = sessionIdHeader ? sessionManager.getSession(sessionIdHeader) : undefined;
        let tenantContext: AuthenticatedTenantContext | undefined = activeSession?.tenantContext;

        if (!tenantContext && tokenToVerify) {
          tenantContext = await authenticateToken(tokenToVerify, db);
        }

        if (!tenantContext) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32000,
                message: 'Authentication required. Provide "Authorization: Bearer <secretKey>", "X-Tenant-Key", or valid "mcp-session-id" header.',
              },
            }),
          );
          return;
        }

        // SECURITY (SSRF Prevention):
        // Enforce trusted loopback address; NEVER forward credentials to a URL derived from request headers.
        const addr = server.address();
        const activePort =
          options.port ?? (addr && typeof addr === 'object' ? addr.port : 3001);
        const serverUrl = options.serverUrl ?? `http://127.0.0.1:${activePort}`;

        let activeSessionId = sessionIdHeader;
        if (!activeSessionId) {
          const userSession = sessionManager.findSessionForUser(tenantContext.businessId, tenantContext.userId);
          if (userSession) {
            activeSessionId = userSession.sessionId;
          }
        }

        const hostBridge = new McpAppsHostBridge({
          db,
          tenantContext,
          serverUrl,
          authToken: tokenToVerify || undefined,
          sessionId: activeSessionId,
        });

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const bodyStr = Buffer.concat(chunks).toString('utf-8');
        const parsedMessage = bodyStr ? JSON.parse(bodyStr) : {};

        const bridgeResponse = await hostBridge.handleAppMessage(parsedMessage);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bridgeResponse));
        return;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Internal Server Error';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: errMsg },
          }),
        );
        return;
      }
    }

    // 5. MCP Apps Host Harness, Card Viewer & SDK Endpoint
    if (url.pathname === '/apps/sdk.js') {
      try {
        const require = createRequire(import.meta.url);
        const sdkPath = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
        const content = fs.readFileSync(sdkPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(content);
        return;
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('SDK not found');
        return;
      }
    }

    if (url.pathname === '/apps/harness') {
      // 1. Authenticate request:
      // SECURITY: Credentials and secrets MUST come from protected headers, NEVER from URL query parameters.
      const authHeader = req.headers['authorization'] ?? (req.headers['x-tenant-key'] as string);
      let tokenToVerify = '';
      if (authHeader) {
        tokenToVerify = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
      }

      const sessionIdHeader = (req.headers['mcp-session-id'] as string) || '';
      let tenantContext: AuthenticatedTenantContext | undefined;
      let activeSession: McpSession | undefined;

      if (sessionIdHeader) {
        activeSession = sessionManager.getSession(sessionIdHeader);
        if (activeSession) {
          tenantContext = activeSession.tenantContext;
        }
      }

      if (!tenantContext && tokenToVerify) {
        try {
          tenantContext = await authenticateToken(tokenToVerify, db);
        } catch {
          // invalid credentials
        }
      }

      if (!tenantContext) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'UNAUTHENTICATED',
            message: 'Authentication required to access host harness. Provide "Authorization: Bearer <token>" or "mcp-session-id" header.',
          }),
        );
        return;
      }

      // Establish or reuse active ephemeral session for this user (never exposing secret API key in HTML)
      if (!activeSession) {
        activeSession = sessionManager.findSessionForUser(tenantContext.businessId, tenantContext.userId);
        if (!activeSession) {
          activeSession = sessionManager.createSession(tenantContext);
        }
      }
      const harnessSessionId = activeSession.sessionId;

      const resourceUri = url.searchParams.get('resource') || 'ui://cards/invoice-draft';
      const draftId = url.searchParams.get('draft_id');
      // SECURITY: Confirmation tokens authorize critical actions and MUST NEVER be accepted in URL query parameters.
      // Accept confirmation token strictly via protected header.
      const confirmationToken = (
        (req.headers['x-confirmation-token'] ?? req.headers['confirmation-token']) as string
      )?.trim() || '';

      let initialToolResult: Record<string, unknown> | null = null;
      if (draftId || confirmationToken) {
        try {
          const conditions = [
            eq(pendingConfirmations.businessId, tenantContext.businessId),
            eq(pendingConfirmations.userId, tenantContext.userId),
          ];
          if (confirmationToken) {
            const tokenHash = createHash('sha256').update(confirmationToken).digest('hex');
            conditions.push(eq(pendingConfirmations.tokenHash, tokenHash));
          } else if (draftId) {
            conditions.push(eq(pendingConfirmations.id, draftId));
          }

          const query = await db.query.pendingConfirmations.findFirst({
            where: and(...conditions),
          });

          if (query) {
            const draftPayload = (query.payload && typeof query.payload === 'object') ? (query.payload as Record<string, unknown>) : {};
            initialToolResult = {
              draft_id: query.id,
              confirmation_token: confirmationToken || undefined,
              status: 'pending_confirmation',
              ...draftPayload,
              draft: query.payload,
            };
          }
        } catch {
          // ignore db lookup failure for harness
        }
      }

      const harnessConfig = {
        serverUrl: '/mcp/app-bridge',
        sessionId: harnessSessionId,
        initialToolResult: initialToolResult,
      };

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Kanakku MCP Apps Host Harness</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #f8fafc; }
    .container { max-width: 600px; margin: 0 auto; }
    iframe { width: 100%; height: 640px; border: 1px solid #334155; border-radius: 12px; background: #1e293b; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 16px; color: #38bdf8; }
  </style>
</head>
<body>
  <div class="container">
    <h1>MCP Apps Host Harness</h1>
    <iframe id="mcp-app-frame" src="/apps/render?uri=${encodeURIComponent(resourceUri)}" sandbox="allow-scripts allow-forms"></iframe>
  </div>
  <script type="application/json" id="mcp-harness-config">${safeJsonForHtml(harnessConfig)}</script>
  ${BROWSER_HOST_LISTENER_SCRIPT}
</body>
</html>`);
      return;
    }

    if (url.pathname === '/apps/render') {
      const resourceUri = url.searchParams.get('uri') || 'ui://cards/invoice-draft';
      let cardHtml = '';
      if (resourceUri.includes('expense')) {
        cardHtml = renderExpenseCardHtml({
          title: 'Draft Expense Record',
          vendorName: 'Awaiting Vendor...',
          description: 'Awaiting Expense Description...',
          amountFormatted: '₹0.00',
          category: 'Uncategorized',
          paymentMethod: 'UPI',
          expenseDate: new Date().toISOString().split('T')[0] ?? '2026-03-31',
          isItcEligible: true,
          status: 'Draft Pending',
        });
      } else {
        cardHtml = renderInvoiceCardHtml({
          title: 'Draft Invoice Preview',
          invoiceNumber: 'INV-DRAFT',
          customerName: 'Awaiting Draft Details...',
          customerGstin: null,
          placeOfSupply: '—',
          issueDate: '—',
          dueDate: '—',
          items: [],
          subtotalFormatted: '₹0.00',
          totalFormatted: '₹0.00',
          status: 'Draft Pending',
        });
      }
      res.writeHead(200, { 'Content-Type': 'text/html;profile=mcp-app; charset=utf-8' });
      res.end(cardHtml);
      return;
    }

    // 404 for other endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND', path: url.pathname }));
  });

  return {
    httpServer: server,
    sessionManager,
    listen: (port?: number) => {
      const listenPort = port ?? options.port ?? parseInt(process.env['PORT'] ?? '3001', 10);
      return new Promise<number>((resolve) => {
        server.listen(listenPort, () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
          resolve(actualPort);
        });
      });
    },
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
