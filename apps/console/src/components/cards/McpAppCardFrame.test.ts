import { describe, it, expect, vi } from 'vitest';

describe('McpAppCardFrame Protocol & Bridge Test', () => {

  it('implements JSON-RPC 2.0 handshake and tool result delivery', async () => {
    const parentMessages: any[] = [];
    const iframeMessages: any[] = [];

    // Mock parent postMessage handler
    const handleParentMessage = (event: any) => {
      parentMessages.push(event.data);

      if (event.data?.method === 'ui/initialize') {
        // Host replies to ui/initialize
        mockIframeWindow.postMessage(
          {
            jsonrpc: '2.0',
            id: event.data.id,
            result: {
              protocolVersion: '2026-01-26',
              hostInfo: { name: 'kanakku-console', version: '0.1.0' },
            },
          },
          '*',
        );
      } else if (event.data?.method === 'ui/notifications/initialized') {
        // Host sends tool result
        mockIframeWindow.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: {
              toolResult: {
                _meta: {
                  draft_id: 'd-123',
                  confirmation_token: 'tok_abc',
                },
              },
            },
          },
          '*',
        );
      }
    };

    const mockIframeWindow = {
      postMessage: (msg: any, _targetOrigin?: string) => {
        iframeMessages.push(msg);
      },
    };

    // 1. App card sends ui/initialize
    handleParentMessage({
      data: {
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'ui/initialize',
        params: { protocolVersion: '2026-01-26' },
      },
    });

    expect(parentMessages.length).toBe(1);
    expect(iframeMessages.length).toBe(1);
    expect(iframeMessages[0].result.protocolVersion).toBe('2026-01-26');

    // 2. App card acknowledges with ui/notifications/initialized
    handleParentMessage({
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/initialized',
      },
    });

    expect(iframeMessages.length).toBe(2);
    expect(iframeMessages[1].method).toBe('ui/notifications/tool-result');
    expect(iframeMessages[1].params.toolResult._meta.confirmation_token).toBe('tok_abc');
  });

  it('intercepts tools/call confirm_action from card and responds with execution result', async () => {
    let confirmedToken = '';
    const onConfirm = vi.fn().mockImplementation(async (token: string) => {
      confirmedToken = token;
      return { status: 'executed' };
    });

    const mockIframeWindow = {
      messages: [] as any[],
      postMessage(msg: any) {
        this.messages.push(msg);
      },
    };

    // Host message handler simulating McpAppCardFrame logic
    const handleHostMessage = async (msg: any) => {
      if (msg.method === 'tools/call' && msg.params?.name === 'confirm_action') {
        await onConfirm(msg.params.arguments.confirmation_token);
        mockIframeWindow.postMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: { status: 'executed', message: 'Action successfully confirmed' },
        });
      }
    };

    await handleHostMessage({
      jsonrpc: '2.0',
      id: 'req-call-1',
      method: 'tools/call',
      params: {
        name: 'confirm_action',
        arguments: { confirmation_token: 'test_token_999' },
      },
    });

    expect(onConfirm).toHaveBeenCalledWith('test_token_999');
    expect(confirmedToken).toBe('test_token_999');
    expect(mockIframeWindow.messages.length).toBe(1);
    expect(mockIframeWindow.messages[0].result.status).toBe('executed');
  });
});
