import Link from 'next/link';
import { Mic, ArrowRight, BookOpen, ShieldCheck, Sparkles } from 'lucide-react';

export default function HomePage() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '2rem',
        textAlign: 'center',
        background: 'radial-gradient(circle at 50% 20%, #1e1b4b 0%, #090d16 70%)',
      }}
    >
      <div
        style={{
          width: '64px',
          height: '64px',
          borderRadius: '16px',
          background: 'linear-gradient(135deg, #f59e0b 0%, #10b981 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '2rem',
          fontWeight: 800,
          color: '#090d16',
          marginBottom: '1.5rem',
          boxShadow: '0 0 30px rgba(245, 158, 11, 0.3)',
        }}
      >
        ₹
      </div>

      <h1
        style={{
          fontSize: '2.5rem',
          fontWeight: 800,
          letterSpacing: '-0.03em',
          marginBottom: '0.75rem',
          color: '#ffffff',
        }}
      >
        Kanakku <span style={{ color: '#38bdf8' }}>Console</span>
      </h1>

      <p
        style={{
          maxWidth: '560px',
          fontSize: '1.1rem',
          color: '#94a3b8',
          lineHeight: 1.6,
          marginBottom: '2rem',
        }}
      >
        Voice-first conversational accounting copilot and Books management console for Indian SMBs.
        Built with Amazon Bedrock, Model Context Protocol, and deterministic GST engines.
      </p>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/voice"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.6rem',
            background: 'linear-gradient(135deg, #38bdf8 0%, #2563eb 100%)',
            color: '#ffffff',
            fontWeight: 600,
            padding: '0.85rem 1.75rem',
            borderRadius: '12px',
            textDecoration: 'none',
            boxShadow: '0 4px 20px rgba(56, 189, 248, 0.4)',
            transition: 'transform 0.2s ease',
          }}
        >
          <Mic size={20} />
          <span>Launch Voice Simulator</span>
          <ArrowRight size={18} />
        </Link>
      </div>

      <div
        style={{
          marginTop: '3.5rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1.25rem',
          maxWidth: '760px',
          width: '100%',
          textAlign: 'left',
        }}
      >
        <div
          style={{
            padding: '1.25rem',
            borderRadius: '12px',
            background: 'rgba(30, 41, 59, 0.5)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <Sparkles size={20} color="#f59e0b" style={{ marginBottom: '0.5rem' }} />
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '0.25rem' }}>
            Push-to-Talk (PTT)
          </h3>
          <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
            Web Speech API + Web Audio API waveform visualization with Indian English speech recognition.
          </p>
        </div>

        <div
          style={{
            padding: '1.25rem',
            borderRadius: '12px',
            background: 'rgba(30, 41, 59, 0.5)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <ShieldCheck size={20} color="#10b981" style={{ marginBottom: '0.5rem' }} />
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '0.25rem' }}>
            Two-Phase Financial Writes
          </h3>
          <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
            Voice commands draft transactions and yield cryptographically secured confirmation tokens.
          </p>
        </div>

        <div
          style={{
            padding: '1.25rem',
            borderRadius: '12px',
            background: 'rgba(30, 41, 59, 0.5)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <BookOpen size={20} color="#38bdf8" style={{ marginBottom: '0.5rem' }} />
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '0.25rem' }}>
            13 Strict MCP Tools
          </h3>
          <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
            Streamable HTTP client connecting Bedrock reasoning to deterministic accounting ledgers.
          </p>
        </div>
      </div>
    </div>
  );
}
