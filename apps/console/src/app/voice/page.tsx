'use client';

import React, { useState, useRef, useEffect } from 'react';
import { usePushToTalk } from '@/hooks/usePushToTalk';
import { WaveformVisualizer } from '@/components/voice/WaveformVisualizer';
import { PushToTalkButton } from '@/components/voice/PushToTalkButton';
import { ToolExecutionChip } from '@/components/voice/ToolExecutionChip';
import { QuickPromptList } from '@/components/voice/QuickPromptList';
import { DirectDraftCard } from '@/components/cards/DirectDraftCard';
import type { McpToolCallResult } from '@/lib/mcp-client/client';
import { Send, Volume2, Bot, User, ShieldCheck, RefreshCw, Key, AlertTriangle } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result: McpToolCallResult;
  }>;
  cardResourceUri?: string;
  confirmationToken?: string;
  draftType?: 'expense' | 'invoice' | 'reminder' | 'month_close';
  actionRequired?: 'confirm' | 'clarify' | 'none';
  draftSummary?: Record<string, unknown>;
  draftStatus?: 'pending' | 'confirmed' | 'cancelled';
}

export default function VoiceSimulatorPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init-1',
      role: 'assistant',
      content:
        'Vanakkam! I am your Kanakku voice financial copilot. Hold Spacebar or tap the microphone to record expenses, draft GST invoices, or ask about your books.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const [textInput, setTextInput] = useState('');
  const [pendingDraftToken, setPendingDraftToken] = useState<string | null>(null);
  const [isProcessingAction, setIsProcessingAction] = useState(false);
  const [apiKey, setApiKey] = useState('26a60a29f0cf1dc3ddf6e6b34ee1189bee5c24522e21d058');
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Load API key from local storage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('kanakku_api_key');
      if (stored) {
        setApiKey(stored);
      } else {
        localStorage.setItem('kanakku_api_key', '26a60a29f0cf1dc3ddf6e6b34ee1189bee5c24522e21d058');
      }
    }
  }, []);

  // Initialize Push-to-Talk hook
  const {
    state,
    setState,
    isSupported,
    interimTranscript,
    errorMessage,
    analyserNode,
    startListening,
    stopListening,
    toggleListening,
    speak,
  } = usePushToTalk({
    onTranscriptComplete: (transcript) => {
      handleUserTurn(transcript);
    },
  });

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, interimTranscript]);

  const saveApiKey = (key: string) => {
    const trimmed = key.trim();
    setApiKey(trimmed);
    if (typeof window !== 'undefined') {
      localStorage.setItem('kanakku_api_key', trimmed);
    }
    setShowKeyModal(false);
    setAuthError(null);
  };

  /**
   * Handle user voice or text input turn
   */
  const handleUserTurn = async (transcript: string) => {
    if (!transcript.trim()) return;

    if (!apiKey) {
      setShowKeyModal(true);
      setAuthError('Authentication required: Please enter your Kanakku API Key');
      return;
    }

    const userMsgId = `msg-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: transcript,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setTextInput('');
    setState('processing');

    try {
      // Call authenticated voice API endpoint
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          transcript,
          conversationHistory: messages.map((m) => ({ role: m.role, content: m.content })),
          pendingToken: pendingDraftToken,
        }),
      });

      const data = await res.json();
      if (res.status === 401) {
        setAuthError('Invalid API Key. Please re-enter your credential.');
        setShowKeyModal(true);
        throw new Error('Authentication failed');
      }

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to process voice turn');
      }

      // Handle token state changes
      if (data.confirmationToken) {
        setPendingDraftToken(data.confirmationToken);
      } else if (data.actionRequired === 'none') {
        // If an action was just confirmed or cancelled, clear pending draft
        setPendingDraftToken(null);
        // Also update any previous pending draft card status in message thread
        if (data.toolCalls?.some((t: { name: string }) => t.name === 'confirm_action')) {
          setMessages((prev) =>
            prev.map((m) => (m.draftStatus === 'pending' ? { ...m, draftStatus: 'confirmed' } : m)),
          );
        } else if (data.toolCalls?.some((t: { name: string }) => t.name === 'cancel_action')) {
          setMessages((prev) =>
            prev.map((m) => (m.draftStatus === 'pending' ? { ...m, draftStatus: 'cancelled' } : m)),
          );
        }
      }

      const assistantMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        content: data.spokenResponse || 'Understood.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        toolCalls: data.toolCalls,
        cardResourceUri: data.cardResourceUri,
        confirmationToken: data.confirmationToken,
        draftType: data.draftType,
        actionRequired: data.actionRequired,
        draftSummary: data.draftSummary,
        draftStatus: data.confirmationToken ? 'pending' : undefined,
      };

      setMessages((prev) => [...prev, assistantMsg]);

      // Speak response aloud using Web Speech API Synthesis
      if (data.spokenResponse) {
        speak(data.spokenResponse);
      } else {
        setState('idle');
      }
    } catch (err: unknown) {
      console.error('Turn handling failed:', err);
      const errMsg = err instanceof Error ? err.message : 'Error processing request';
      const errorAssistantMsg: ChatMessage = {
        id: `asst-err-${Date.now()}`,
        role: 'assistant',
        content: `Sorry, I encountered an issue: ${errMsg}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errorAssistantMsg]);
      setState('error');
    }
  };

  /**
   * Handle Confirm Button action on Draft Cards
   */
  const handleConfirmDraft = async (token: string) => {
    setIsProcessingAction(true);
    try {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          action: 'confirm',
          confirmationToken: token,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setPendingDraftToken(null);
      setMessages((prev) =>
        prev.map((m) => (m.confirmationToken === token ? { ...m, draftStatus: 'confirmed' } : m)),
      );

      const confirmMsg: ChatMessage = {
        id: `asst-conf-${Date.now()}`,
        role: 'assistant',
        content: 'Transaction confirmed and posted to the double-entry books.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        toolCalls: data.toolCalls,
      };
      setMessages((prev) => [...prev, confirmMsg]);
      speak('Transaction confirmed and posted to the double-entry books.');
    } catch (err: unknown) {
      console.error('Confirmation error:', err);
      alert(`Confirmation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessingAction(false);
    }
  };

  /**
   * Handle Cancel Button action on Draft Cards
   */
  const handleCancelDraft = async (token: string) => {
    setIsProcessingAction(true);
    try {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          action: 'cancel',
          confirmationToken: token,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setPendingDraftToken(null);
      setMessages((prev) =>
        prev.map((m) => (m.confirmationToken === token ? { ...m, draftStatus: 'cancelled' } : m)),
      );

      const cancelMsg: ChatMessage = {
        id: `asst-canc-${Date.now()}`,
        role: 'assistant',
        content: 'Draft cancelled and discarded. Your books remain untouched.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        toolCalls: data.toolCalls,
      };
      setMessages((prev) => [...prev, cancelMsg]);
      speak('Draft cancelled. No changes were made to your books.');
    } catch (err: unknown) {
      console.error('Cancellation error:', err);
      alert(`Cancellation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessingAction(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: '#090d16',
        color: '#f8fafc',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Top Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1rem 2rem',
          background: 'rgba(15, 23, 42, 0.8)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          position: 'sticky',
          top: 0,
          zIndex: 40,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              width: '38px',
              height: '38px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, #f59e0b 0%, #10b981 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '1.25rem',
              color: '#090d16',
            }}
          >
            ₹
          </div>
          <div>
            <h1 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>
              Kanakku <span style={{ color: '#38bdf8' }}>Voice Simulator</span>
            </h1>
            <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: 0 }}>
              Alexa+-Style Copilot for Indian Small Businesses
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {/* Auth Key Badge / Button */}
          <button
            type="button"
            onClick={() => setShowKeyModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.78rem',
              background: apiKey ? 'rgba(56, 189, 248, 0.1)' : 'rgba(239, 68, 68, 0.15)',
              border: apiKey ? '1px solid rgba(56, 189, 248, 0.3)' : '1px solid rgba(239, 68, 68, 0.4)',
              color: apiKey ? '#38bdf8' : '#f87171',
              padding: '0.3rem 0.75rem',
              borderRadius: '9999px',
              cursor: 'pointer',
            }}
          >
            <Key size={13} />
            <span>{apiKey ? `Auth: ${apiKey.slice(0, 10)}...` : 'Set API Key'}</span>
          </button>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.78rem',
              background: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: '#34d399',
              padding: '0.3rem 0.75rem',
              borderRadius: '9999px',
            }}
          >
            <ShieldCheck size={14} />
            <span>MCP Server Active (13 Tools)</span>
          </div>

          <button
            type="button"
            onClick={() => {
              setMessages([
                {
                  id: 'init-1',
                  role: 'assistant',
                  content:
                    'Vanakkam! Session reset. How can I help with your accounting or GST today?',
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                },
              ]);
              setPendingDraftToken(null);
            }}
            title="Reset Conversation"
            style={{
              background: 'transparent',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '8px',
              padding: '0.4rem',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      {/* Unsupported Browser Warning Banner */}
      {!isSupported && (
        <div
          role="alert"
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            borderBottom: '1px solid rgba(239, 68, 68, 0.3)',
            padding: '0.6rem 1.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            color: '#f87171',
            fontSize: '0.85rem',
            justifyContent: 'center',
          }}
        >
          <AlertTriangle size={16} />
          <span>
            Web Speech Recognition is not supported by your browser. You can still use the text input below.
          </span>
        </div>
      )}

      {/* Microphone Error Alert Banner */}
      {errorMessage && (
        <div
          role="alert"
          style={{
            background: 'rgba(239, 68, 68, 0.2)',
            borderBottom: '1px solid rgba(239, 68, 68, 0.4)',
            padding: '0.6rem 1.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            color: '#fca5a5',
            fontSize: '0.85rem',
            justifyContent: 'center',
          }}
        >
          <AlertTriangle size={16} />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Main Conversational Feed Area */}
      <main
        style={{
          flex: 1,
          maxWidth: '860px',
          width: '100%',
          margin: '0 auto',
          padding: '1.5rem 1.5rem 7.5rem 1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
        }}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              gap: '0.4rem',
            }}
          >
            {/* Sender Tag & Timestamp */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.75rem',
                color: '#64748b',
                padding: '0 0.5rem',
              }}
            >
              {msg.role === 'user' ? (
                <>
                  <span>You</span>
                  <User size={12} />
                  <span>• {msg.timestamp}</span>
                </>
              ) : (
                <>
                  <Bot size={12} color="#38bdf8" />
                  <span style={{ color: '#38bdf8', fontWeight: 600 }}>Kanakku AI</span>
                  <span>• {msg.timestamp}</span>
                </>
              )}
            </div>

            {/* Bubble Content */}
            <div
              style={{
                maxWidth: '85%',
                padding: '1rem 1.25rem',
                borderRadius:
                  msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                background:
                  msg.role === 'user'
                    ? 'linear-gradient(135deg, #1d4ed8, #2563eb)'
                    : 'rgba(30, 41, 59, 0.75)',
                border:
                  msg.role === 'user'
                    ? '1px solid rgba(59, 130, 246, 0.4)'
                    : '1px solid rgba(255, 255, 255, 0.08)',
                color: '#ffffff',
                fontSize: '0.95rem',
                lineHeight: 1.5,
                boxShadow:
                  msg.role === 'user'
                    ? '0 4px 14px rgba(37, 99, 235, 0.25)'
                    : '0 4px 14px rgba(0, 0, 0, 0.3)',
              }}
            >
              <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>

              {/* Spoken Audio Replay for Assistant Messages */}
              {msg.role === 'assistant' && msg.content && (
                <div style={{ marginTop: '0.5rem', display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => speak(msg.content)}
                    title="Speak aloud"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      background: 'none',
                      border: 'none',
                      color: '#94a3b8',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      padding: '0.2rem 0.4rem',
                      borderRadius: '4px',
                    }}
                  >
                    <Volume2 size={14} />
                    <span>Play Voice</span>
                  </button>
                </div>
              )}

              {/* Tool Execution Chips */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div style={{ marginTop: '0.5rem' }}>
                  {msg.toolCalls.map((tc, idx) => (
                    <ToolExecutionChip
                      key={idx}
                      name={tc.name}
                      args={tc.args}
                      resultSummary={tc.result?.content?.[0]?.text?.slice(0, 140)}
                    />
                  ))}
                </div>
              )}

              {/* Interactive Multi-Type Draft Card */}
              {msg.confirmationToken && msg.draftSummary && (
                <DirectDraftCard
                  type={msg.draftType || 'expense'}
                  title={
                    msg.draftType === 'invoice'
                      ? 'Sales Invoice Draft'
                      : msg.draftType === 'reminder'
                        ? 'Payment Reminder Draft'
                        : msg.draftType === 'month_close'
                          ? 'Month-End Close Summary'
                          : 'Expense Draft'
                  }
                  details={msg.draftSummary}
                  confirmationToken={msg.confirmationToken}
                  status={msg.draftStatus || 'pending'}
                  isLoading={isProcessingAction}
                  onConfirm={handleConfirmDraft}
                  onCancel={handleCancelDraft}
                />
              )}
            </div>
          </div>
        ))}

        {/* Interim Speech Transcript while listening */}
        {state === 'listening' && interimTranscript && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: '0.4rem',
            }}
          >
            <div
              style={{
                maxWidth: '80%',
                padding: '0.75rem 1.25rem',
                borderRadius: '18px 18px 4px 18px',
                background: 'rgba(59, 130, 246, 0.2)',
                border: '1px dashed #3b82f6',
                color: '#93c5fd',
                fontSize: '0.95rem',
                fontStyle: 'italic',
              }}
            >
              &ldquo;{interimTranscript}...&rdquo;
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* Bottom Sleek Non-Intrusive Floating Control Dock */}
      <footer
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'linear-gradient(180deg, rgba(9, 13, 22, 0) 0%, rgba(9, 13, 22, 0.95) 40%, #090d16 100%)',
          backdropFilter: 'blur(16px)',
          padding: '0.5rem 1.5rem 0.85rem 1.5rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          zIndex: 50,
        }}
      >
        <div style={{ maxWidth: '820px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {/* Active Audio Waveform (Visible only when speaking or listening) */}
          {(state === 'listening' || state === 'speaking') && (
            <div style={{ marginBottom: '0.4rem' }}>
              <WaveformVisualizer analyserNode={analyserNode} state={state} width={260} height={28} />
            </div>
          )}

          {/* Unified Compact Action Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%' }}>
            {/* Inline Compact Push-to-Talk Mic Button */}
            <PushToTalkButton
              state={state}
              onStart={startListening}
              onStop={stopListening}
              onToggle={toggleListening}
              compact={true}
            />

            {/* Text Input Command Bar */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (textInput.trim()) {
                  handleUserTurn(textInput);
                }
              }}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                background: 'rgba(30, 41, 59, 0.75)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '9999px',
                padding: '0.35rem 0.5rem 0.35rem 1.1rem',
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.35)',
              }}
            >
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Speak via mic or type a command... (e.g. 'Record 2,400 for client dinner')"
                disabled={state === 'processing'}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#f8fafc',
                  fontSize: '0.88rem',
                }}
              />
              <button
                type="submit"
                disabled={!textInput.trim() || state === 'processing'}
                aria-label="Send command"
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '50%',
                  border: 'none',
                  background: textInput.trim() ? '#38bdf8' : 'rgba(255, 255, 255, 0.1)',
                  color: textInput.trim() ? '#090d16' : '#64748b',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: textInput.trim() ? 'pointer' : 'not-allowed',
                  transition: 'all 0.2s ease',
                  flexShrink: 0,
                }}
              >
                <Send size={15} />
              </button>
            </form>
          </div>

          {/* Quick SMB Prompt Pills (shown only at start so content is never blocked) */}
          {messages.length <= 1 && (
            <div style={{ marginTop: '0.5rem', width: '100%' }}>
              <QuickPromptList onSelectPrompt={(prompt) => handleUserTurn(prompt)} disabled={state === 'processing'} />
            </div>
          )}
        </div>
      </footer>

      {/* Authentication Modal */}
      {showKeyModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="auth-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#0f172a',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '16px',
              padding: '1.75rem',
              maxWidth: '440px',
              width: '100%',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <Key size={20} color="#38bdf8" />
              <h2 id="auth-modal-title" style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>
                Kanakku Tenant Authentication
              </h2>
            </div>

            <p style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.5, marginBottom: '1rem' }}>
              Enter your business API Key to authenticate your voice console session. Requests will be strictly
              scoped to your tenant.
            </p>

            {authError && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.2)',
                  border: '1px solid #ef4444',
                  borderRadius: '8px',
                  padding: '0.5rem 0.75rem',
                  color: '#fca5a5',
                  fontSize: '0.8rem',
                  marginBottom: '1rem',
                }}
              >
                {authError}
              </div>
            )}

            <input
              type="password"
              placeholder="e.g. kanakku_test_secret_ramesh_2026"
              defaultValue={apiKey}
              id="api-key-input"
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                background: 'rgba(30, 41, 59, 0.8)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '8px',
                color: '#ffffff',
                fontSize: '0.9rem',
                outline: 'none',
                marginBottom: '1.25rem',
                boxSizing: 'border-box',
              }}
            />

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => {
                  const input = document.getElementById('api-key-input') as HTMLInputElement;
                  if (input && input.value) {
                    saveApiKey(input.value);
                  }
                }}
                style={{
                  padding: '0.65rem 1.25rem',
                  borderRadius: '8px',
                  border: 'none',
                  background: '#38bdf8',
                  color: '#090d16',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Save & Authenticate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
