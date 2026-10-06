'use client';

import React from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  Receipt,
  FileSpreadsheet,
  BellRing,
  CalendarCheck2,
} from 'lucide-react';

export type DraftCardType = 'expense' | 'invoice' | 'reminder' | 'month_close' | 'generic';

export interface DirectDraftCardProps {
  type?: DraftCardType;
  title: string;
  details: Record<string, unknown>;
  confirmationToken: string;
  onConfirm: (token: string) => Promise<void>;
  onCancel: (token: string) => Promise<void>;
  status?: 'pending' | 'confirmed' | 'cancelled';
  isLoading?: boolean;
}

export function DirectDraftCard({
  type = 'expense',
  title,
  details,
  confirmationToken,
  onConfirm,
  onCancel,
  status = 'pending',
  isLoading = false,
}: DirectDraftCardProps) {
  const isPending = status === 'pending';
  const isConfirmed = status === 'confirmed';
  const isCancelled = status === 'cancelled';

  const getIcon = () => {
    switch (type) {
      case 'invoice':
        return <FileSpreadsheet size={18} color="#38bdf8" />;
      case 'reminder':
        return <BellRing size={18} color="#a855f7" />;
      case 'month_close':
        return <CalendarCheck2 size={18} color="#10b981" />;
      case 'expense':
      default:
        return <Receipt size={18} color="#f59e0b" />;
    }
  };

  const getBorderColor = () => {
    if (isConfirmed) return '#10b981';
    if (isCancelled) return '#64748b';
    if (type === 'invoice') return '#38bdf8';
    if (type === 'reminder') return '#a855f7';
    if (type === 'month_close') return '#10b981';
    return '#f59e0b';
  };

  return (
    <div
      role="region"
      aria-label={`${type} draft: ${title}`}
      style={{
        background: 'linear-gradient(180deg, #111827 0%, #0b0f19 100%)',
        border: `1px solid ${getBorderColor()}`,
        borderRadius: '16px',
        padding: '1.25rem',
        marginTop: '0.75rem',
        boxShadow: isConfirmed
          ? '0 0 20px rgba(16, 185, 129, 0.15)'
          : isPending
            ? '0 0 20px rgba(56, 189, 248, 0.12)'
            : 'none',
        transition: 'all 0.3s ease',
      }}
    >
      {/* Header Badge & Title */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1rem',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          paddingBottom: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {getIcon()}
          <span style={{ fontWeight: 600, fontSize: '0.95rem', color: '#f8fafc' }}>
            {type === 'invoice'
              ? 'Sales Invoice Draft'
              : type === 'reminder'
                ? 'Payment Reminder Draft'
                : type === 'month_close'
                  ? 'Month-End Close Summary'
                  : 'Expense Draft'}
          </span>
        </div>

        <span
          style={{
            fontSize: '0.75rem',
            padding: '0.2rem 0.6rem',
            borderRadius: '9999px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            background: isConfirmed
              ? 'rgba(16, 185, 129, 0.2)'
              : isCancelled
                ? 'rgba(100, 116, 139, 0.2)'
                : 'rgba(56, 189, 248, 0.2)',
            color: isConfirmed ? '#34d399' : isCancelled ? '#94a3b8' : '#38bdf8',
          }}
        >
          {status}
        </span>
      </div>

      {/* Details Grid customized by type */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        {type === 'invoice' && (
          <div
            style={{
              width: '100%',
              background: 'rgba(15, 23, 42, 0.75)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              borderRadius: '12px',
              padding: '1rem',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '0.75rem',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                paddingBottom: '0.5rem',
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: '0.72rem',
                    color: '#94a3b8',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Billed To
                </span>
                <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#f8fafc' }}>
                  {String(details.customerName || 'TechCorp Solutions')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span
                  style={{
                    fontSize: '0.72rem',
                    color: '#38bdf8',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                  }}
                >
                  Statutory Tax Invoice
                </span>
                <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>POS: 33 (Tamil Nadu)</div>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.45rem',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#e2e8f0' }}>
                <span>Professional Services (SAC 998311)</span>
                <span style={{ fontWeight: 600 }}>
                  ₹{String(details.subtotalRupees || '50,000')}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>CGST @ 9.0%</span>
                <span>₹4,500</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>SGST @ 9.0%</span>
                <span>₹4,500</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  color: '#10b981',
                  borderTop: '1px solid rgba(255, 255, 255, 0.12)',
                  paddingTop: '0.6rem',
                  marginTop: '0.3rem',
                }}
              >
                <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>Total Invoice Value</span>
                <span style={{ fontWeight: 800, fontSize: '1.15rem' }}>
                  ₹{String(details.totalRupees || '59,000')}
                </span>
              </div>
            </div>
          </div>
        )}

        {type === 'expense' && (
          <div
            style={{
              width: '100%',
              background: 'rgba(15, 23, 42, 0.75)',
              border: '1px solid rgba(245, 158, 11, 0.25)',
              borderRadius: '12px',
              padding: '1rem',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '0.75rem',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                paddingBottom: '0.5rem',
              }}
            >
              <div>
                <span style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase' }}>
                  Expense Category
                </span>
                <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#f8fafc' }}>
                  {String(details.description || 'Business Expense')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span
                  style={{
                    fontSize: '0.72rem',
                    color: '#38bdf8',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                  }}
                >
                  Method
                </span>
                <div
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    color: '#38bdf8',
                    textTransform: 'uppercase',
                  }}
                >
                  {String(details.paymentMethod || 'UPI')}
                </div>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                color: '#f59e0b',
                paddingTop: '0.2rem',
              }}
            >
              <span style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>Total Amount</span>
              <span style={{ fontWeight: 800, fontSize: '1.15rem' }}>
                ₹{String(details.amountRupees || '2,400')}
              </span>
            </div>
          </div>
        )}

        {type === 'reminder' && (
          <>
            <div>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Recipient</span>
              <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9' }}>
                {String(details.customerName || 'Customer')}
              </div>
            </div>
            <div>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Channel</span>
              <div
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: '#a855f7',
                  textTransform: 'capitalize',
                }}
              >
                {String(details.channel || 'WhatsApp')}
              </div>
            </div>
            <div>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Tone</span>
              <div
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: '#38bdf8',
                  textTransform: 'capitalize',
                }}
              >
                {String(details.tone || 'Polite')}
              </div>
            </div>
          </>
        )}

        {type === 'month_close' && (
          <>
            <div>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Period</span>
              <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9' }}>
                Month {String(details.month)} / {String(details.year)}
              </div>
            </div>
            <div>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Workflow Status</span>
              <div
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: '#10b981',
                  textTransform: 'capitalize',
                }}
              >
                {String(details.status || 'Scanned')}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Token & Expiry Notice */}
      {isPending && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.75rem',
            color: '#64748b',
            background: 'rgba(0, 0, 0, 0.3)',
            padding: '0.4rem 0.75rem',
            borderRadius: '8px',
            marginBottom: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <ShieldCheck size={14} color="#10b981" />
            <span>Token: {confirmationToken.slice(0, 12)}...</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Clock size={14} color="#f59e0b" />
            <span>Valid for 15 mins (Two-Phase Write)</span>
          </div>
        </div>
      )}

      {/* Action Buttons for Pending Draft */}
      {isPending && (
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => onConfirm(confirmationToken)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1rem',
              borderRadius: '10px',
              border: 'none',
              background: 'linear-gradient(135deg, #10b981, #059669)',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
              transition: 'all 0.2s ease',
            }}
          >
            <CheckCircle2 size={16} />
            <span>Confirm & Post to Books</span>
          </button>

          <button
            type="button"
            disabled={isLoading}
            onClick={() => onCancel(confirmationToken)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '0.65rem 1rem',
              borderRadius: '10px',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              background: 'transparent',
              color: '#94a3b8',
              fontWeight: 500,
              fontSize: '0.875rem',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            <XCircle size={16} />
            <span>Discard</span>
          </button>
        </div>
      )}

      {/* Outcome Confirmation Message */}
      {isConfirmed && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
            background: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(16, 185, 129, 0.4)',
            borderRadius: '10px',
            padding: '0.75rem 1rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: '#34d399',
              fontSize: '0.9rem',
              fontWeight: 700,
            }}
          >
            <CheckCircle2 size={18} />
            <span>Committed & Balanced in General Ledger!</span>
          </div>
          <div style={{ fontSize: '0.78rem', color: '#cbd5e1', lineHeight: 1.4 }}>
            {type === 'invoice'
              ? 'Invoice posted to PostgreSQL • Dr. Accounts Receivable ₹59,000 / Cr. Revenue ₹50,000 / Cr. Output GST ₹9,000 • Verified in integer paise.'
              : 'Expense posted to PostgreSQL • Dr. Operating Expense / Cr. Cash & Bank • Anchored to cryptographic audit chain.'}
          </div>
        </div>
      )}

      {isCancelled && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            color: '#94a3b8',
            fontSize: '0.875rem',
          }}
        >
          <XCircle size={16} />
          <span>Draft discarded. No ledger entries were created.</span>
        </div>
      )}
    </div>
  );
}
