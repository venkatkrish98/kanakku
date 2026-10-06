'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface McpAppCardFrameProps {
  cardHtml: string;
  toolResult: Record<string, unknown>;
  onConfirm: (token: string) => Promise<void>;
  onCancel: (token: string) => Promise<void>;
}

/**
 * Embedded MCP App Card Frame conforming to io.modelcontextprotocol/ui extension.
 * Connects the card's vanilla postMessage JSON-RPC client to the console host bridge.
 */
export function McpAppCardFrame({
  cardHtml,
  toolResult,
  onConfirm,
  onCancel,
}: McpAppCardFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [_isHandshakeComplete, setIsHandshakeComplete] = useState(false);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleMessage = async (event: MessageEvent) => {
      // Ensure message comes from our iframe
      if (event.source !== iframe.contentWindow) return;

      const data = event.data;
      if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;

      // 1. Handshake request from card: ui/initialize
      if (data.method === 'ui/initialize') {
        iframe.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            id: data.id,
            result: {
              protocolVersion: '2026-01-26',
              hostInfo: { name: 'kanakku-console', version: '0.1.0' },
              hostCapabilities: {
                tools: { listChanged: true },
              },
            },
          },
          '*',
        );
        return;
      }

      // 2. Handshake ack from card: ui/notifications/initialized
      if (data.method === 'ui/notifications/initialized') {
        setIsHandshakeComplete(true);
        // Deliver tool result to card
        iframe.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: {
              toolResult,
            },
          },
          '*',
        );
        return;
      }

      // 3. Card-initiated tool call: tools/call (confirm_action / cancel_action)
      if (data.method === 'tools/call') {
        const { name, arguments: args } = data.params || {};
        const reqId = data.id;

        try {
          if (name === 'confirm_action') {
            await onConfirm(args.confirmation_token);
            iframe.contentWindow?.postMessage(
              {
                jsonrpc: '2.0',
                id: reqId,
                result: { status: 'executed', message: 'Action successfully confirmed' },
              },
              '*',
            );
          } else if (name === 'cancel_action') {
            await onCancel(args.confirmation_token);
            iframe.contentWindow?.postMessage(
              {
                jsonrpc: '2.0',
                id: reqId,
                result: { status: 'cancelled', message: 'Action discarded' },
              },
              '*',
            );
          } else {
            iframe.contentWindow?.postMessage(
              {
                jsonrpc: '2.0',
                id: reqId,
                error: { code: -32601, message: `Unknown tool: ${name}` },
              },
              '*',
            );
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          iframe.contentWindow?.postMessage(
            {
              jsonrpc: '2.0',
              id: reqId,
              error: { code: -32000, message: msg },
            },
            '*',
          );
        }
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [cardHtml, toolResult, onConfirm, onCancel]);

  return (
    <div
      style={{
        borderRadius: '12px',
        overflow: 'hidden',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        background: '#090d16',
        marginTop: '0.75rem',
      }}
    >
      <iframe
        ref={iframeRef}
        srcDoc={cardHtml}
        title="Interactive MCP UI Card"
        sandbox="allow-scripts allow-forms"
        style={{
          width: '100%',
          minHeight: '260px',
          border: 'none',
          display: 'block',
        }}
      />
    </div>
  );
}
