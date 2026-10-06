'use client';

import React from 'react';
import type { VoiceState } from '@/hooks/usePushToTalk';
import { Mic, Volume2, Loader2, AlertCircle } from 'lucide-react';

export interface PushToTalkButtonProps {
  state: VoiceState;
  onStart: () => void;
  onStop: () => void;
  onToggle: () => void;
  disabled?: boolean;
  compact?: boolean;
}

export function PushToTalkButton({
  state,
  onStart,
  onStop,
  onToggle,
  disabled = false,
  compact = false,
}: PushToTalkButtonProps) {
  const isListening = state === 'listening';
  const isProcessing = state === 'processing';
  const isSpeaking = state === 'speaking';
  const isError = state === 'error';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: compact ? 'row' : 'column',
        alignItems: 'center',
        gap: compact ? '0' : '0.75rem',
      }}
    >
      <button
        type="button"
        id="push-to-talk-button"
        disabled={disabled || isProcessing}
        aria-label={
          isListening
            ? 'Stop listening'
            : isSpeaking
              ? 'Stop speaking'
              : 'Hold or click to speak with Kanakku Voice Assistant'
        }
        aria-pressed={isListening}
        onMouseDown={(e) => {
          if (e.button === 0 && !disabled && !isProcessing && !isSpeaking) {
            onStart();
          }
        }}
        onMouseUp={(e) => {
          if (e.button === 0 && isListening) {
            onStop();
          }
        }}
        onClick={() => {
          if (isSpeaking) {
            onToggle();
          } else if (compact && !isProcessing) {
            if (isListening) onStop();
            else onStart();
          }
        }}
        style={{
          position: 'relative',
          width: compact ? '46px' : '76px',
          height: compact ? '46px' : '76px',
          borderRadius: '50%',
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          outline: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isListening
            ? 'linear-gradient(135deg, #10b981, #059669)'
            : isSpeaking
              ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
              : isError
                ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                : 'linear-gradient(135deg, #0ea5e9, #2563eb)',
          boxShadow: isListening
            ? '0 0 20px rgba(16, 185, 129, 0.6), inset 0 0 10px rgba(255, 255, 255, 0.4)'
            : isSpeaking
              ? '0 0 20px rgba(99, 102, 241, 0.6)'
              : '0 4px 16px rgba(14, 165, 233, 0.35)',
          transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          transform: isListening ? 'scale(1.08)' : 'scale(1)',
          flexShrink: 0,
        }}
      >
        {/* Pulsing ring animation for listening state */}
        {isListening && (
          <span
            style={{
              position: 'absolute',
              inset: '-6px',
              borderRadius: '50%',
              border: '2px solid #10b981',
              animation: 'pulseRing 1.5s infinite ease-out',
            }}
          />
        )}

        {/* Dynamic State Icons */}
        {isListening ? (
          <Mic
            size={compact ? 22 : 32}
            color="#ffffff"
            style={{ animation: 'bounce 1s infinite' }}
          />
        ) : isProcessing ? (
          <Loader2
            size={compact ? 22 : 32}
            color="#ffffff"
            style={{ animation: 'spin 1s linear infinite' }}
          />
        ) : isSpeaking ? (
          <Volume2
            size={compact ? 22 : 32}
            color="#ffffff"
            style={{ animation: 'pulse 1.2s infinite' }}
          />
        ) : isError ? (
          <AlertCircle size={compact ? 22 : 32} color="#ffffff" />
        ) : (
          <Mic size={compact ? 22 : 32} color="#ffffff" />
        )}
      </button>

      {!compact && (
        <div style={{ textAlign: 'center', fontSize: '0.875rem' }}>
          <span
            style={{
              fontWeight: 600,
              color: isListening
                ? '#34d399'
                : isSpeaking
                  ? '#a5b4fc'
                  : isProcessing
                    ? '#60a5fa'
                    : '#94a3b8',
            }}
          >
            {isListening
              ? 'Listening... (Release mouse or Space to send)'
              : isProcessing
                ? 'Reasoning with Bedrock & MCP...'
                : isSpeaking
                  ? 'Speaking response (Click to stop)'
                  : isError
                    ? 'Microphone issue — Click to retry'
                    : 'Hold Space or click to talk'}
          </span>
        </div>
      )}

      <style jsx global>{`
        @keyframes pulseRing {
          0% {
            transform: scale(0.95);
            opacity: 0.8;
          }
          50% {
            transform: scale(1.15);
            opacity: 0.3;
          }
          100% {
            transform: scale(1.25);
            opacity: 0;
          }
        }
        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
