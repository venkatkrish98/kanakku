'use client';

import React, { useState } from 'react';
import { Wrench, ChevronDown, ChevronRight, Check } from 'lucide-react';

export interface ToolExecutionChipProps {
  name: string;
  args: Record<string, unknown>;
  resultSummary?: string;
}

export function ToolExecutionChip({ name, args, resultSummary }: ToolExecutionChipProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        borderRadius: '8px',
        background: 'rgba(30, 41, 59, 0.7)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        margin: '0.25rem 0',
        fontSize: '0.8rem',
        maxWidth: '100%',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          padding: '0.35rem 0.65rem',
          background: 'none',
          border: 'none',
          color: '#cbd5e1',
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
        }}
      >
        <Wrench size={13} color="#38bdf8" />
        <span style={{ fontWeight: 600, color: '#38bdf8' }}>MCP Tool:</span>
        <code style={{ color: '#f1f5f9', background: 'rgba(0,0,0,0.3)', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>
          {name}
        </code>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <Check size={12} color="#10b981" />
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </button>

      {isExpanded && (
        <div
          style={{
            padding: '0.5rem 0.65rem',
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            background: 'rgba(15, 23, 42, 0.9)',
            fontSize: '0.75rem',
            color: '#94a3b8',
          }}
        >
          <div style={{ marginBottom: '0.25rem' }}>
            <strong style={{ color: '#cbd5e1' }}>Arguments:</strong>
            <pre style={{ margin: '0.2rem 0', color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
          {resultSummary && (
            <div>
              <strong style={{ color: '#cbd5e1' }}>Result:</strong>
              <div style={{ color: '#34d399', marginTop: '0.2rem' }}>{resultSummary}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
