'use client';

import React from 'react';
import { Sparkles } from 'lucide-react';

export interface QuickPromptListProps {
  onSelectPrompt: (prompt: string) => void;
  disabled?: boolean;
}

const QUICK_PROMPTS = [
  'Record 2,400 expense for Swiggy client dinner',
  'Who owes me money?',
  'What is my GST liability for this month?',
  'Create invoice for TechCorp for 50,000 INR with 18% GST',
  'Send polite WhatsApp payment reminder to Ravi',
  'Give me a daily business briefing',
  'Show cashflow summary for this month',
];

export function QuickPromptList({ onSelectPrompt, disabled }: QuickPromptListProps) {
  return (
    <div style={{ marginTop: '1rem', width: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.8rem',
          color: '#94a3b8',
          marginBottom: '0.5rem',
        }}
      >
        <Sparkles size={14} color="#f59e0b" />
        <span>Try asking Kanakku:</span>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => onSelectPrompt(prompt)}
            style={{
              fontSize: '0.78rem',
              padding: '0.4rem 0.75rem',
              borderRadius: '9999px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              background: 'rgba(30, 41, 59, 0.6)',
              color: '#cbd5e1',
              cursor: disabled ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s ease',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              if (!disabled) {
                e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.5)';
                e.currentTarget.style.background = 'rgba(56, 189, 248, 0.1)';
                e.currentTarget.style.color = '#38bdf8';
              }
            }}
            onMouseLeave={(e) => {
              if (!disabled) {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                e.currentTarget.style.background = 'rgba(30, 41, 59, 0.6)';
                e.currentTarget.style.color = '#cbd5e1';
              }
            }}
          >
            &ldquo;{prompt}&rdquo;
          </button>
        ))}
      </div>
    </div>
  );
}
