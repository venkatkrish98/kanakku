/**
 * Streamable HTTP MCP Client for Kanakku Console
 * Connects to Kanakku MCP Server (/mcp) adhering to MCP 2025-11-25+ specification
 */

export interface McpClientConfig {
  baseUrl?: string;
  token?: string;
  sessionId?: string;
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  _meta?: {
    'ui/resourceUri'?: string;
    draft_id?: string;
    confirmation_token?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class McpHttpClient {
  private baseUrl: string;
  private token: string;
  private sessionId: string | null = null;
  private messageCounter = 1;

  constructor(config: McpClientConfig = {}) {
    this.baseUrl = (config.baseUrl || process.env.MCP_SERVER_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
    this.token = config.token || process.env.KANAKKU_API_KEY || '';
    if (config.sessionId) {
      this.sessionId = config.sessionId;
    }
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public setSessionId(id: string | null) {
    this.sessionId = id;
  }

  /**
   * Initializes MCP session with the server
   */
  async initialize(): Promise<{ serverInfo: unknown; capabilities: unknown }> {
    const res = await this.postJsonRpc('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: {
        name: 'kanakku-console',
        version: '0.1.0',
      },
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
    });

    if (res.error) {
      throw new Error(`MCP initialize failed: ${JSON.stringify(res.error)}`);
    }

    return (res.result as { serverInfo: unknown; capabilities: unknown }) || { serverInfo: {}, capabilities: {} };
  }

  /**
   * Lists all 13 tools registered on the MCP server
   */
  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const res = await this.postJsonRpc('tools/list', {});
    if (res.error) {
      throw new Error(`tools/list failed: ${JSON.stringify(res.error)}`);
    }
    const result = res.result as { tools?: Array<{ name: string; description: string; inputSchema: unknown }> };
    return result?.tools || [];
  }

  /**
   * Calls an MCP tool by name with arguments
   */
  async callTool(name: string, args: Record<string, unknown> = {}, extraHeaders?: Record<string, string>): Promise<McpToolCallResult> {
    const res = await this.postJsonRpc(
      'tools/call',
      {
        name,
        arguments: args,
      },
      extraHeaders,
    );

    if (res.error) {
      const err = res.error as { code?: number; message?: string; data?: unknown };
      throw new Error(err.message || `Tool call failed with code ${err.code}`);
    }

    return (res.result as McpToolCallResult) || { content: [] };
  }

  /**
   * Reads an MCP Resource, including ui://cards/* App cards
   */
  async readResource(uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text?: string; blob?: string }> }> {
    const res = await this.postJsonRpc('resources/read', { uri });
    if (res.error) {
      throw new Error(`resources/read failed: ${JSON.stringify(res.error)}`);
    }
    return (res.result as { contents: Array<{ uri: string; mimeType: string; text?: string; blob?: string }> }) || { contents: [] };
  }

  /**
   * Universal executor for pending confirmation tokens
   */
  async confirmAction(confirmationToken: string, idempotencyKey?: string): Promise<McpToolCallResult> {
    return this.callTool('confirm_action', {
      confirmation_token: confirmationToken,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    });
  }

  /**
   * Aborts a pending draft
   */
  async cancelAction(confirmationToken: string, reason?: string): Promise<McpToolCallResult> {
    return this.callTool('cancel_action', {
      confirmation_token: confirmationToken,
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Internal JSON-RPC 2.0 POST dispatcher over HTTP transport
   */
  private async postJsonRpc(
    method: string,
    params: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<{ result?: unknown; error?: unknown; id?: number | string }> {
    if (!this.token) {
      throw new Error('MCP_CLIENT_UNAUTHENTICATED: Authentication token is required to invoke MCP server');
    }

    if (!this.sessionId && method !== 'initialize') {
      await this.initialize();
    }

    const id = this.messageCounter++;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
      ...extraHeaders,
    };

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const endpoint = `${this.baseUrl}/mcp`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }),
    });

    const newSession = response.headers.get('mcp-session-id');
    if (newSession) {
      this.sessionId = newSession;
    }

    const text = await response.text();
    let json: { result?: unknown; error?: unknown; id?: number | string };

    try {
      json = JSON.parse(text);
    } catch {
      // SSE event or empty response handling
      const match = text.match(/data:\s*({.+})/);
      if (match && match[1]) {
        json = JSON.parse(match[1]);
      } else {
        throw new Error(`Invalid JSON-RPC response from MCP server: ${text.slice(0, 200)}`);
      }
    }

    return json;
  }
}

