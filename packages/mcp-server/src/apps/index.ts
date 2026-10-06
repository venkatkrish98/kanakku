import type { KanakkuDatabase } from '@kanakku/db';
import { handleConfirmAction } from '../tools/confirm-action.js';
import { handleCancelAction } from '../tools/cancel-action.js';
import { tenantContextStorage, type AuthenticatedTenantContext } from '../auth/index.js';
import {
  App,
  RESOURCE_MIME_TYPE,
  LATEST_PROTOCOL_VERSION,
  RESOURCE_URI_META_KEY,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps';
import {
  AppBridge,
  getToolUiResourceUri,
} from '@modelcontextprotocol/ext-apps/app-bridge';

export {
  App,
  RESOURCE_MIME_TYPE,
  LATEST_PROTOCOL_VERSION,
  RESOURCE_URI_META_KEY,
  PostMessageTransport,
  AppBridge,
  getToolUiResourceUri,
};

/**
 * Escapes characters that have syntactic meaning in HTML script tags
 * (such as </script>) so that data can be safely embedded in an HTML document
 * within <script type="application/json"> without risking script injection.
 */
export function safeJsonForHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME_TYPE = RESOURCE_MIME_TYPE;

/**
 * Standard client-side script embedded into MCP Apps HTML cards.
 * Implements the official MCP Apps lifecycle:
 * 1. Handshake: ui/initialize -> host response -> ui/notifications/initialized
 * 2. Data Delivery: listens for ui/notifications/tool-result to dynamically hydrate draft details & token
 * 3. Interactive Actions: dispatches tools/call for confirm_action & cancel_action
 */
export const APP_BRIDGE_SCRIPT = `
<script>
(function() {
  var reqCounter = 1;
  var pendingHandlers = {};
  var initId = 'init-' + Date.now();
  window.currentToken = null;

  // Official MCP Apps App instance registration
  window.mcpApp = {
    name: 'kanakku-ui-card',
    version: '0.1.0',
    protocolVersion: '2026-01-26',
    ontoolresult: function(params) {
      if (window.handleToolResult) window.handleToolResult(params);
    },
    callServerTool: function(nameOrParams, args) {
      var name = typeof nameOrParams === 'object' && nameOrParams ? nameOrParams.name : nameOrParams;
      var toolArgs = (typeof nameOrParams === 'object' && nameOrParams ? nameOrParams.arguments : args) || {};
      return window.callHostTool ? window.callHostTool(name, toolArgs) : Promise.reject(new Error('callHostTool not ready'));
    }
  };

  function log(msg) {
    if (window.console && window.console.log) {
      window.console.log('[MCP-App]', msg);
    }
  }

  // 1. Send initial handshake request to Host
  try {
    window.parent.postMessage({
      jsonrpc: '2.0',
      id: initId,
      method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'kanakku-ui-card', version: '0.1.0' },
        appCapabilities: {}
      }
    }, '*');
  } catch (err) {
    log('Failed to post ui/initialize: ' + err.message);
  }

  window.callHostTool = function(nameOrParams, args) {
    var toolName = typeof nameOrParams === 'object' && nameOrParams ? nameOrParams.name : nameOrParams;
    var toolArgs = (typeof nameOrParams === 'object' && nameOrParams ? nameOrParams.arguments : args) || {};
    return new Promise(function(resolve, reject) {
      var id = 'mcp-app-req-' + (reqCounter++);
      var message = {
        jsonrpc: '2.0',
        id: id,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs
        }
      };
      pendingHandlers[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage(message, '*');
    });
  };

  window.handleToolResult = function(params) {
    if (!params) return;
    var data = params.structuredContent;
    if (!data && params.content && params.content[0] && params.content[0].text) {
      try {
        data = JSON.parse(params.content[0].text);
      } catch (e) {
        // non-json text content
      }
    }
    if (!data && typeof params === 'object') {
      data = Object.assign({}, params, params.draft || {});
    }
    if (!data) return;

    // 1. Exact Token Binding
    var token = data.confirmation_token || data.token;
    if (token) {
      window.currentToken = token;
    }

    // 2. Invoice / Draft Number
    var invNumEl = document.getElementById('card-invoice-number');
    if (invNumEl) {
      invNumEl.textContent = data.invoice_number || data.invoiceNumber || 'INV-DRAFT';
    }

    // 3. Recipient (Customer / Vendor)
    var recipientEl = document.getElementById('card-recipient');
    if (recipientEl) {
      var recipientName = data.customer_name || data.customerName || data.vendor_name || data.vendorName || data.description;
      if (recipientName) recipientEl.textContent = recipientName;
    }

    // 4. Issue Date & Due Date
    var issueDateEl = document.getElementById('card-issue-date');
    if (issueDateEl && (data.issue_date || data.issueDate)) {
      issueDateEl.textContent = data.issue_date || data.issueDate;
    }
    var dueDateEl = document.getElementById('card-due-date');
    if (dueDateEl && (data.due_date || data.dueDate)) {
      dueDateEl.textContent = data.due_date || data.dueDate;
    }

    // 5. Place of Supply
    var posEl = document.getElementById('card-place-of-supply');
    if (posEl && (data.place_of_supply || data.placeOfSupply)) {
      posEl.textContent = data.place_of_supply || data.placeOfSupply;
    }

    // 6. Expense-specific fields
    var catEl = document.getElementById('card-category');
    if (catEl && (data.suggested_category || data.category_name || data.category)) {
      catEl.textContent = data.suggested_category || data.category_name || data.category;
    }
    var expDateEl = document.getElementById('card-date');
    if (expDateEl && (data.expense_date || data.expenseDate)) {
      expDateEl.textContent = data.expense_date || data.expenseDate;
    }
    var payEl = document.getElementById('card-payment-mode');
    if (payEl && (data.payment_method || data.paymentMethod)) {
      payEl.textContent = (data.payment_method || data.paymentMethod).toUpperCase();
    }
    var itcEl = document.getElementById('card-itc-container');
    if (itcEl && data.is_itc_eligible !== undefined) {
      while (itcEl.firstChild) itcEl.removeChild(itcEl.firstChild);
      var badgeSpan = document.createElement('span');
      if (data.is_itc_eligible) {
        badgeSpan.className = 'badge badge-success';
        badgeSpan.textContent = 'ITC Eligible';
      } else {
        badgeSpan.className = 'badge badge-danger';
        badgeSpan.textContent = 'Blocked ITC: ' + (data.itc_block_reason || 'Sec 17(5)');
      }
      itcEl.appendChild(badgeSpan);
    }

    // 7. Complete Line Items Table Hydration (replaces any previous draft rows)
    var itemsEl = document.getElementById('card-items');
    var rawItems = data.line_items || data.items || [];
    if (itemsEl) {
      while (itemsEl.firstChild) itemsEl.removeChild(itemsEl.firstChild);
      if (Array.isArray(rawItems) && rawItems.length > 0) {
        for (var i = 0; i < rawItems.length; i++) {
          var itm = rawItems[i];
          var desc = itm.description || 'Line Item ' + (i + 1);
          var qty = itm.quantity !== undefined ? itm.quantity : 1;
          var itemTotal = itm.total_formatted || itm.totalFormatted;
          if (!itemTotal && itm.total_paise !== undefined) {
            itemTotal = '₹' + (Number(itm.total_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
          } else if (!itemTotal && itm.amount_paise !== undefined) {
            itemTotal = '₹' + (Number(itm.amount_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
          } else if (!itemTotal) {
            itemTotal = '₹0.00';
          }
          var tr = document.createElement('tr');
          var tdDesc = document.createElement('td');
          tdDesc.textContent = desc;
          var tdQty = document.createElement('td');
          tdQty.style.textAlign = 'center';
          tdQty.textContent = String(qty);
          var tdTotal = document.createElement('td');
          tdTotal.style.textAlign = 'right';
          tdTotal.textContent = String(itemTotal);
          tr.appendChild(tdDesc);
          tr.appendChild(tdQty);
          tr.appendChild(tdTotal);
          itemsEl.appendChild(tr);
        }
      } else if (data.description) {
        var trSingle = document.createElement('tr');
        var tdSingleDesc = document.createElement('td');
        tdSingleDesc.setAttribute('colspan', '2');
        tdSingleDesc.textContent = data.description;
        var tdSingleTotal = document.createElement('td');
        tdSingleTotal.style.textAlign = 'right';
        tdSingleTotal.textContent = data.total_formatted || data.amount_formatted || '—';
        trSingle.appendChild(tdSingleDesc);
        trSingle.appendChild(tdSingleTotal);
        itemsEl.appendChild(trSingle);
      }
    }

    // 8. Tax Breakdown Hydration (replaces any previous draft tax rows)
    var taxesEl = document.getElementById('card-taxes');
    if (taxesEl) {
      while (taxesEl.firstChild) taxesEl.removeChild(taxesEl.firstChild);
      var taxEntries = [];
      var gstBd = data.gst_breakdown;
      if (gstBd) {
        if (gstBd.cgst_paise) {
          taxEntries.push({ label: 'CGST:', value: '₹' + (Number(gstBd.cgst_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) });
        }
        if (gstBd.sgst_paise) {
          taxEntries.push({ label: 'SGST:', value: '₹' + (Number(gstBd.sgst_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) });
        }
        if (gstBd.igst_paise) {
          taxEntries.push({ label: 'IGST:', value: '₹' + (Number(gstBd.igst_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) });
        }
      }
      if (taxEntries.length === 0) {
        if (data.cgst_formatted || data.cgstFormatted) {
          taxEntries.push({ label: 'CGST:', value: String(data.cgst_formatted || data.cgstFormatted) });
        } else if (data.cgst_paise) {
          taxEntries.push({ label: 'CGST:', value: '₹' + (Number(data.cgst_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) });
        }
        if (data.sgst_formatted || data.sgstFormatted) {
          taxEntries.push({ label: 'SGST:', value: String(data.sgst_formatted || data.sgstFormatted) });
        } else if (data.sgst_paise) {
          taxEntries.push({ label: 'SGST:', value: '₹' + (Number(data.sgst_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) });
        }
        if (data.igst_formatted || data.igstFormatted) {
          taxEntries.push({ label: 'IGST:', value: String(data.igst_formatted || data.igstFormatted) });
        } else if (data.igst_paise) {
          taxEntries.push({ label: 'IGST:', value: '₹' + (Number(data.igst_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) });
        }
      }
      for (var t = 0; t < taxEntries.length; t++) {
        var entry = taxEntries[t];
        var div = document.createElement('div');
        var span = document.createElement('span');
        span.textContent = entry.label + ' ';
        var strong = document.createElement('strong');
        strong.textContent = entry.value;
        div.appendChild(span);
        div.appendChild(strong);
        taxesEl.appendChild(div);
      }
    }

    // 9. Total Amount Due Hydration
    var totalEl = document.getElementById('card-total');
    if (totalEl) {
      if (data.total_formatted) {
        totalEl.textContent = data.total_formatted;
      } else if (data.amount_formatted) {
        totalEl.textContent = data.amount_formatted;
      } else if (data.total_paise !== undefined) {
        totalEl.textContent = '₹' + (Number(data.total_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      } else if (data.amount_paise !== undefined) {
        totalEl.textContent = '₹' + (Number(data.amount_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      }
    }

    // 10. Status Badge
    var badgeEl = document.getElementById('card-badge');
    if (badgeEl) {
      badgeEl.className = 'badge badge-pending';
      badgeEl.textContent = 'Ready for confirmation';
    }

    // 11. Disclaimer & Token Binding
    var discEl = document.getElementById('card-disclaimer');
    if (discEl && window.currentToken) {
      discEl.textContent = 'Valid for 15 minutes. Token: ' + window.currentToken.slice(0, 10) + '...';
    }

    // 12. Enable Action Buttons strictly bound to the confirmed token
    if (window.currentToken) {
      var confirmBtn = document.getElementById('btn-confirm');
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.onclick = function() { window.handleConfirm(window.currentToken); };
      }
      var cancelBtn = document.getElementById('btn-cancel');
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.onclick = function() { window.handleCancel(window.currentToken); };
      }
    }
  };

  window.handleConfirm = async function(token) {
    var activeToken = token || window.currentToken;
    var btn = document.getElementById('btn-confirm');
    var cancelBtn = document.getElementById('btn-cancel');
    if (btn) btn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    try {
      var res = await window.callHostTool('confirm_action', { confirmation_token: activeToken, token: activeToken });
      var badge = document.getElementById('card-badge') || document.querySelector('.badge');
      if (badge) {
        badge.className = 'badge badge-success';
        badge.textContent = 'Confirmed & Posted';
      }
      var actions = document.querySelector('.actions');
      if (actions) {
        while (actions.firstChild) actions.removeChild(actions.firstChild);
        var msgDiv = document.createElement('div');
        msgDiv.style.color = '#10b981';
        msgDiv.style.fontWeight = '600';
        msgDiv.style.textAlign = 'center';
        msgDiv.style.padding = '10px';
        msgDiv.style.background = 'rgba(16, 185, 129, 0.1)';
        msgDiv.style.borderRadius = '8px';
        msgDiv.textContent = 'Transaction confirmed and posted to general ledger.';
        actions.appendChild(msgDiv);
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      alert('Action confirmation failed: ' + (err.message || JSON.stringify(err)));
    }
  };

  window.handleCancel = async function(token) {
    var activeToken = token || window.currentToken;
    var btn = document.getElementById('btn-cancel');
    var confirmBtn = document.getElementById('btn-confirm');
    if (btn) btn.disabled = true;
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      var res = await window.callHostTool('cancel_action', { confirmation_token: activeToken, token: activeToken });
      var badge = document.getElementById('card-badge') || document.querySelector('.badge');
      if (badge) {
        badge.className = 'badge badge-danger';
        badge.textContent = 'Cancelled';
      }
      var actions = document.querySelector('.actions');
      if (actions) {
        while (actions.firstChild) actions.removeChild(actions.firstChild);
        var cancelDiv = document.createElement('div');
        cancelDiv.style.color = '#ef4444';
        cancelDiv.style.fontWeight = '600';
        cancelDiv.style.textAlign = 'center';
        cancelDiv.style.padding = '10px';
        cancelDiv.style.background = 'rgba(239, 68, 68, 0.1)';
        cancelDiv.style.borderRadius = '8px';
        cancelDiv.textContent = 'Draft cancelled and voided.';
        actions.appendChild(cancelDiv);
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      if (confirmBtn) confirmBtn.disabled = false;
      alert('Draft cancellation failed: ' + (err.message || JSON.stringify(err)));
    }
  };

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    // A. Handshake acknowledgment from host
    if (data.id === initId && data.result) {
      try {
        window.parent.postMessage({
          jsonrpc: '2.0',
          method: 'ui/notifications/initialized',
          params: {}
        }, '*');
      } catch (e) {}
      return;
    }

    // B. Host delivers tool result notification
    if (data.method === 'ui/notifications/tool-result') {
      window.handleToolResult(data.params);
      return;
    }

    // C. Host responds to tools/call or other requests
    if (data.jsonrpc === '2.0' && data.id && pendingHandlers[data.id]) {
      var handler = pendingHandlers[data.id];
      delete pendingHandlers[data.id];
      if (data.error) {
        handler.reject(data.error);
      } else {
        handler.resolve(data.result);
      }
    }
  });
})();
</script>
`;

export interface McpAppsHostBridgeConfig {
  db?: KanakkuDatabase;
  tenantContext?: AuthenticatedTenantContext;
  serverUrl?: string;
  sessionId?: string;
  authToken?: string;
}

/**
 * Host-side MCP Apps bridge that processes JSON-RPC 2.0 messages sent by
 * an embedded app card via postMessage and routes them to server actions.
 * Supports executing directly or forwarding over HTTP to the running MCP server.
 */
export class McpAppsHostBridge {
  private db?: KanakkuDatabase;
  private tenantContext?: AuthenticatedTenantContext;
  private serverUrl?: string;
  private sessionId?: string;
  private authToken?: string;

  constructor(
    configOrDb: KanakkuDatabase | McpAppsHostBridgeConfig,
    tenantContext?: AuthenticatedTenantContext,
  ) {
    if (
      configOrDb &&
      typeof configOrDb === 'object' &&
      !('select' in configOrDb) &&
      !('transaction' in configOrDb)
    ) {
      const config = configOrDb as McpAppsHostBridgeConfig;
      this.db = config.db;
      this.tenantContext = config.tenantContext;
      this.serverUrl = config.serverUrl;
      this.sessionId = config.sessionId;
      this.authToken = config.authToken;
    } else {
      this.db = configOrDb as KanakkuDatabase;
      this.tenantContext = tenantContext;
    }
  }

  /**
   * Helper to format a tool result notification to deliver to an MCP App card.
   */
  createToolResultNotification(toolResult: unknown): {
    jsonrpc: '2.0';
    method: 'ui/notifications/tool-result';
    params: unknown;
  } {
    return {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: toolResult,
    };
  }

  /**
   * Process a JSON-RPC message from an MCP App iframe and return the JSON-RPC response.
   */
  async handleAppMessage(
    message: unknown,
    contextOverride?: AuthenticatedTenantContext,
  ): Promise<{
    jsonrpc: '2.0';
    id: string | number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  }> {
    if (!message || typeof message !== 'object') {
      return {
        jsonrpc: '2.0',
        id: (message as { id?: string | number })?.id ?? (null as unknown as string),
        error: { code: -32600, message: 'Invalid Request: message must be an object' },
      };
    }

    const req = message as {
      jsonrpc?: string;
      id?: string | number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    const id = req.id ?? (null as unknown as string);

    if (req.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      };
    }

    // 1. Handle official MCP Apps initialization handshake
    if (req.method === 'ui/initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'kanakku-mcp-apps-host', version: '0.1.0' },
          hostCapabilities: {
            serverTools: {},
          },
        },
      };
    }

    if (req.method === 'ui/notifications/initialized') {
      // Notification acknowledgment
      return {
        jsonrpc: '2.0',
        id,
        result: {},
      };
    }

    if (req.method !== 'tools/call') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
    }

    // 2. If configured with running serverUrl, forward request to running MCP HTTP server
    if (this.serverUrl) {
      try {
        const parsedUrl = new URL(this.serverUrl);
        const hostname = parsedUrl.hostname;
        const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
        if (!isLoopback) {
          throw new Error(`Untrusted serverUrl target rejected for SSRF protection: ${hostname}`);
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Mcp-Ui-Support': 'true',
        };
        if (this.authToken) {
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        if (this.sessionId) {
          headers['mcp-session-id'] = this.sessionId;
        }

        const serverRes = await fetch(`${this.serverUrl}/mcp`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: req.params,
          }),
        });

        const rawText = await serverRes.text();
        let json: {
          jsonrpc?: string;
          id?: string | number | null;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        } | null = null;

        try {
          json = JSON.parse(rawText);
        } catch {
          const match = rawText.match(/data:\s*({.+})/);
          if (match && match[1]) {
            try {
              json = JSON.parse(match[1]);
            } catch {
              /* ignore non-json SSE event payload */
            }
          }
        }

        if (!json) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: `Failed to parse server response: ${rawText.slice(0, 200)}` },
          };
        }

        if (json.error) {
          if (
            (json.error.code === -32002 || json.error.message?.includes('not initialized')) &&
            this.db &&
            (contextOverride || this.tenantContext || tenantContextStorage.getStore())
          ) {
            // fall through to direct execution fallback below
          } else {
            return {
              jsonrpc: '2.0',
              id,
              error: json.error,
            };
          }
        } else {
          if (json.result && typeof json.result === 'object') {
            const textContent = (json.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
            let parsed: Record<string, unknown> = {};
            if (textContent) {
              try {
                parsed = JSON.parse(textContent);
              } catch {
                // ignore
              }
            }
            return {
              jsonrpc: '2.0',
              id,
              result: {
                ...(json.result as object),
                structuredContent: parsed,
                ...parsed,
              },
            };
          }

          return {
            jsonrpc: '2.0',
            id,
            result: json.result ?? {},
          };
        }
      } catch (fetchErr: unknown) {
        if (!this.db || (!contextOverride && !this.tenantContext && !tenantContextStorage.getStore())) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: `Server HTTP forward failed: ${msg}` },
          };
        }
        // If fetch failed and DB is available, fall through to fallback
      }
    }

    // 3. Fallback: Direct Database / Tenant execution
    const activeContext =
      contextOverride ?? this.tenantContext ?? tenantContextStorage.getStore();

    if (!activeContext || !this.db) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: 'UNAUTHENTICATED_TENANT_CONTEXT: Host bridge requires an active tenant context or serverUrl',
        },
      };
    }

    const toolName = req.params?.name;
    const args = req.params?.arguments ?? {};

    return tenantContextStorage.run(activeContext, async () => {
      try {
        let toolResult: unknown;

        if (toolName === 'confirm_action') {
          const token = String(args['confirmation_token'] ?? args['token'] ?? '');
          if (!token) throw new Error('Missing required argument: confirmation_token');
          toolResult = await handleConfirmAction(
            {
              confirmation_token: token,
              idempotency_key: args['idempotency_key'] as string | undefined,
            },
            this.db!,
          );
        } else if (toolName === 'cancel_action') {
          const token = String(args['confirmation_token'] ?? args['token'] ?? '');
          if (!token) throw new Error('Missing required argument: confirmation_token');
          toolResult = await handleCancelAction(
            {
              confirmation_token: token,
              reason: args['reason'] as string | undefined,
            },
            this.db!,
          );
        } else {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Tool not supported by app bridge: ${toolName}`,
            },
          };
        }

        const textContent = (toolResult as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
        let parsed: Record<string, unknown> = {};
        if (textContent) {
          try {
            parsed = JSON.parse(textContent);
          } catch {
            // ignore non-json content
          }
        }

        return {
          jsonrpc: '2.0',
          id,
          result: {
            ...(toolResult as object),
            structuredContent: parsed,
            ...parsed,
          },
        };
      } catch (err: unknown) {
        console.error('App bridge error stack:', err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: errorMessage,
          },
        };
      }
    });
  }
}

/**
 * Standard browser-side script embedded in MCP Apps Host pages.
 * Listens for window 'message' events from app iframes, replies to handshake,
 * and proxies tools/call JSON-RPC messages to the MCP server endpoint over HTTP.
 */
export const BROWSER_HOST_LISTENER_SCRIPT = `
<script>
(function() {
  function getHarnessConfig() {
    try {
      var el = document.getElementById('mcp-harness-config');
      if (el && el.textContent) {
        return JSON.parse(el.textContent);
      }
    } catch(e) {}
    return {};
  }

  window.addEventListener('message', async function(event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;
    var iframe = event.source;
    if (!iframe || typeof iframe.postMessage !== 'function') return;

    if (data.method === 'ui/initialize') {
      iframe.postMessage({
        jsonrpc: '2.0',
        id: data.id,
        result: {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'kanakku-browser-host', version: '0.1.0' },
          hostCapabilities: { serverTools: {} }
        }
      }, '*');
      return;
    }

    if (data.method === 'ui/notifications/initialized') {
      var config = getHarnessConfig();
      var toolResult = config.initialToolResult;
      if (toolResult && iframe && typeof iframe.postMessage === 'function') {
        iframe.postMessage({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: toolResult
        }, '*');
      }
      return;
    }

    if (data.method === 'tools/call') {
      try {
        var config = getHarnessConfig();
        var serverUrl = config.serverUrl || '';
        var sessionId = config.sessionId || '';
        var targetUrl = serverUrl;
        if (!targetUrl) {
          targetUrl = '/mcp/app-bridge';
        } else if (targetUrl.endsWith('/mcp') && !sessionId) {
          targetUrl = targetUrl + '/app-bridge';
        } else if (!targetUrl.endsWith('/mcp/app-bridge') && !targetUrl.endsWith('/mcp')) {
          targetUrl = sessionId ? (targetUrl + '/mcp') : (targetUrl + '/mcp/app-bridge');
        }
        if (targetUrl.startsWith('/') && window.location && window.location.origin) {
          targetUrl = window.location.origin + targetUrl;
        }

        var headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'X-Mcp-Ui-Support': 'true'
        };
        if (sessionId) {
          headers['mcp-session-id'] = sessionId;
        } else if (config.bearerToken) {
          headers['Authorization'] = 'Bearer ' + config.bearerToken;
        }

        var res = await fetch(targetUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(data)
        });
        var text = await res.text();
        var json;
        try {
          json = JSON.parse(text);
        } catch(e) {
          var match = text.match(/data:\\s*({.+})/);
          if (match && match[1]) json = JSON.parse(match[1]);
        }
        if (json) {
          iframe.postMessage(json, '*');
        } else {
          iframe.postMessage({
            jsonrpc: '2.0',
            id: data.id,
            error: { code: -32000, message: 'Invalid response from MCP server' }
          }, '*');
        }
      } catch (err) {
        iframe.postMessage({
          jsonrpc: '2.0',
          id: data.id,
          error: { code: -32000, message: err.message || 'Host network error' }
        }, '*');
      }
    }
  });

  window.sendToolResult = function(result) {
    var config = getHarnessConfig();
    var payload = result !== undefined ? result : config.initialToolResult;
    var iframeEl = document.getElementById('mcp-app-frame');
    var target = (iframeEl && iframeEl.contentWindow) ? iframeEl.contentWindow : null;
    if (target && typeof target.postMessage === 'function') {
      target.postMessage({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: payload
      }, '*');
    }
  };
})();
</script>
`;

export interface McpAppsBrowserHostOptions {
  serverUrl: string;
  authToken?: string;
  sessionId?: string;
  targetWindow?: { postMessage: (message: unknown, targetOrigin: string) => void };
  bridgeEndpoint?: string;
}

/**
 * Genuine MCP Apps Browser Host implementation.
 * Connects an iframe View to a running MCP Server through browser postMessage and window message events.
 * Fully compatible with @modelcontextprotocol/ext-apps host specifications.
 */
export class McpAppsBrowserHost {
  public readonly serverUrl: string;
  public readonly authToken?: string;
  public readonly sessionId?: string;
  public targetWindow?: { postMessage: (message: unknown, targetOrigin: string) => void };
  public bridgeEndpoint: string;
  private messageListener?: (event: { data: unknown; source?: unknown }) => void;
  private attachedTarget?: {
    addEventListener: (type: string, listener: (event: { data: unknown; source?: unknown }) => void) => void;
    removeEventListener: (type: string, listener: (event: { data: unknown; source?: unknown }) => void) => void;
  };

  constructor(options: McpAppsBrowserHostOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.authToken = options.authToken;
    this.sessionId = options.sessionId;
    this.targetWindow = options.targetWindow;
    this.bridgeEndpoint = options.bridgeEndpoint ?? '/mcp';
  }

  attach(target: {
    addEventListener: (type: string, listener: (event: { data: unknown; source?: unknown }) => void) => void;
    removeEventListener: (type: string, listener: (event: { data: unknown; source?: unknown }) => void) => void;
  }): void {
    this.attachedTarget = target;
    this.messageListener = async (event: { data: unknown; source?: unknown }) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const targetWin =
        (event.source as { postMessage: (msg: unknown, origin: string) => void } | undefined) ??
        this.targetWindow;
      if (!targetWin || typeof targetWin.postMessage !== 'function') return;

      const response = await this.handleMessage(data);
      if (response) {
        targetWin.postMessage(response, '*');
      }
    };
    target.addEventListener('message', this.messageListener);
  }

  detach(): void {
    if (this.attachedTarget && this.messageListener) {
      this.attachedTarget.removeEventListener('message', this.messageListener);
      this.messageListener = undefined;
      this.attachedTarget = undefined;
    }
  }

  sendToolResult(
    toolResult: unknown,
    customTarget?: { postMessage: (msg: unknown, origin: string) => void },
  ): void {
    const targetWin = customTarget ?? this.targetWindow;
    if (targetWin && typeof targetWin.postMessage === 'function') {
      targetWin.postMessage(
        {
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: toolResult,
        },
        '*',
      );
    }
  }

  async handleMessage(message: unknown): Promise<{
    jsonrpc: '2.0';
    id: string | number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  } | null> {
    if (!message || typeof message !== 'object') return null;
    const req = message as {
      jsonrpc?: string;
      id?: string | number;
      method?: string;
      params?: unknown;
    };
    if (req.jsonrpc !== '2.0') return null;

    const id = req.id ?? null;

    // 1. Handshake: ui/initialize
    if (req.method === 'ui/initialize') {
      return {
        jsonrpc: '2.0',
        id: id as string | number,
        result: {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'kanakku-browser-host', version: '0.1.0' },
          hostCapabilities: {
            serverTools: {},
          },
        },
      };
    }

    // 2. Handshake complete notification
    if (req.method === 'ui/notifications/initialized') {
      return null;
    }

    // 3. Action execution: tools/call forwarded over HTTP to the running MCP server
    if (req.method === 'tools/call') {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Mcp-Ui-Support': 'true',
        };
        if (this.authToken) {
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        if (this.sessionId) {
          headers['mcp-session-id'] = this.sessionId;
        }

        const endpoint = `${this.serverUrl}${this.bridgeEndpoint}`;
        const serverRes = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(req),
        });

        const rawText = await serverRes.text();
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(rawText);
        } catch {
          const match = rawText.match(/data:\s*({.+})/);
          if (match && match[1]) {
            try {
              json = JSON.parse(match[1]);
            } catch {
              /* ignore non-json SSE event payload */
            }
          }
        }

        if (!json) {
          return {
            jsonrpc: '2.0',
            id: id as string | number,
            error: { code: -32000, message: `Failed to parse MCP server response: ${rawText.slice(0, 200)}` },
          };
        }

        return json as {
          jsonrpc: '2.0';
          id: string | number;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: '2.0',
          id: id as string | number,
          error: { code: -32000, message: `Host HTTP proxy error: ${errMsg}` },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id: id as string | number,
      error: { code: -32601, message: `Method not supported: ${req.method}` },
    };
  }
}

