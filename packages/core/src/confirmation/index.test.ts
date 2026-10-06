import { describe, it, expect } from 'vitest';
import {
  generateConfirmationToken,
  hashToken,
  hashPayload,
  canonicalizeJson,
  validateConfirmationEligibility,
  checkIdempotency,
  computeAuditEntryHash,
  type PendingConfirmationRecord,
  type IdempotencyRecord,
} from './index.js';

describe('Confirmation Engine - Recursive Canonical JSON Hashing', () => {
  it('canonicalizes deeply nested objects consistently regardless of key order', () => {
    const payload1 = {
      action: 'create_invoice',
      customer: {
        name: 'Meena Textiles',
        address: { city: 'Coimbatore', state: 'Tamil Nadu', pincode: '641001' },
      },
      items: [
        { unitPrice: 1500, quantity: 40, description: 'Consulting' },
        { description: 'Documentation', quantity: 1, unitPrice: 10000 },
      ],
    };

    const payload2 = {
      items: [
        { description: 'Consulting', quantity: 40, unitPrice: 1500 },
        { unitPrice: 10000, quantity: 1, description: 'Documentation' },
      ],
      customer: {
        address: { pincode: '641001', city: 'Coimbatore', state: 'Tamil Nadu' },
        name: 'Meena Textiles',
      },
      action: 'create_invoice',
    };

    // Canonical representation must be identical
    expect(canonicalizeJson(payload1)).toBe(canonicalizeJson(payload2));
    expect(hashPayload(payload1)).toBe(hashPayload(payload2));
  });

  it('differentiates nested payloads with different nested values', () => {
    const basePayload = {
      invoice: {
        lineItems: [{ description: 'Printer Ink', amountPaise: 240000 }],
      },
    };

    const modifiedPayload = {
      invoice: {
        lineItems: [{ description: 'Printer Ink', amountPaise: 250000 }], // Different nested amount!
      },
    };

    expect(canonicalizeJson(basePayload)).not.toBe(canonicalizeJson(modifiedPayload));
    expect(hashPayload(basePayload)).not.toBe(hashPayload(modifiedPayload));
  });
});

describe('Confirmation Engine - Hashed Token Generation & Validation', () => {
  it('generates a 32-character secret and distinct SHA-256 hash', () => {
    const payload = { amountPaise: 240000, description: 'printer ink' };
    const token = generateConfirmationToken(payload);

    expect(token.tokenSecret).toHaveLength(32);
    expect(token.tokenHash).toHaveLength(64); // SHA-256 hex length
    expect(token.tokenSecret).not.toBe(token.tokenHash);
    expect(hashToken(token.tokenSecret)).toBe(token.tokenHash);
    expect(token.payloadHash).toBe(hashPayload(payload));
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('validates unexpired, unconsumed confirmation token successfully', () => {
    const record: PendingConfirmationRecord = {
      id: 'conf-1',
      businessId: 'biz-1',
      userId: 'user-1',
      tokenHash: 'hash-1',
      actionType: 'record_expense',
      payload: { amount: 2400 },
      payloadHash: 'phash-1',
      expiresAt: new Date(Date.now() + 60000), // 1 min in future
      consumedAt: null,
    };

    expect(() =>
      validateConfirmationEligibility({
        record,
        callerBusinessId: 'biz-1',
        callerUserId: 'user-1',
        callerRole: 'member',
      }),
    ).not.toThrow();
  });

  it('fails closed and rejects confirmation when user authentication is missing or skipped', () => {
    const record: PendingConfirmationRecord = {
      id: 'conf-1',
      businessId: 'biz-1',
      userId: 'user-1',
      tokenHash: 'hash-1',
      actionType: 'record_expense',
      payload: {},
      payloadHash: 'phash',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
    };

    // Missing callerUserId
    expect(() =>
      validateConfirmationEligibility({
        record,
        callerBusinessId: 'biz-1',
        callerUserId: '',
        callerRole: 'member',
      }),
    ).toThrow('UNAUTHENTICATED_CALLER');

    // Missing callerRole
    expect(() =>
      validateConfirmationEligibility({
        record,
        callerBusinessId: 'biz-1',
        callerUserId: 'user-1',
        callerRole: '' as unknown as UserRole,
      }),
    ).toThrow('UNAUTHENTICATED_CALLER');
  });

  it('allows confirmation by a business owner even if not the initiator', () => {
    const record: PendingConfirmationRecord = {
      id: 'conf-1',
      businessId: 'biz-1',
      userId: 'user-initiator',
      tokenHash: 'hash-1',
      actionType: 'record_expense',
      payload: {},
      payloadHash: 'phash',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
    };

    expect(() =>
      validateConfirmationEligibility({
        record,
        callerBusinessId: 'biz-1',
        callerUserId: 'user-owner', // Different user!
        callerRole: 'owner', // But has owner role!
      }),
    ).not.toThrow();
  });

  it('rejects confirmation by an unprivileged user who is not the initiator', () => {
    const record: PendingConfirmationRecord = {
      id: 'conf-1',
      businessId: 'biz-1',
      userId: 'user-initiator',
      tokenHash: 'hash-1',
      actionType: 'record_expense',
      payload: {},
      payloadHash: 'phash',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
    };

    expect(() =>
      validateConfirmationEligibility({
        record,
        callerBusinessId: 'biz-1',
        callerUserId: 'user-other',
        callerRole: 'member', // Not an owner!
      }),
    ).toThrow('USER_NOT_AUTHORIZED');
  });

  it('rejects confirmation with tenant mismatch', () => {
    const record: PendingConfirmationRecord = {
      id: 'conf-1',
      businessId: 'biz-1',
      userId: 'user-1',
      tokenHash: 'hash-1',
      actionType: 'record_expense',
      payload: {},
      payloadHash: 'phash',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
    };

    expect(() =>
      validateConfirmationEligibility({
        record,
        callerBusinessId: 'biz-2', // Different business!
        callerUserId: 'user-1',
        callerRole: 'owner',
      }),
    ).toThrow('TENANT_MISMATCH');
  });

  it('rejects already consumed confirmation token', () => {
    const record: PendingConfirmationRecord = {
      id: 'conf-1',
      businessId: 'biz-1',
      userId: 'user-1',
      tokenHash: 'hash-1',
      actionType: 'record_expense',
      payload: {},
      payloadHash: 'phash',
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: new Date(Date.now() - 5000), // Already consumed!
    };

    expect(() =>
      validateConfirmationEligibility({
        record,
        callerBusinessId: 'biz-1',
        callerUserId: 'user-1',
        callerRole: 'member',
      }),
    ).toThrow('CONFIRMATION_ALREADY_CONSUMED');
  });

  it('rejects expired confirmation token', () => {
    const record: PendingConfirmationRecord = {
      id: 'conf-1',
      businessId: 'biz-1',
      userId: 'user-1',
      tokenHash: 'hash-1',
      actionType: 'record_expense',
      payload: {},
      payloadHash: 'phash',
      expiresAt: new Date(Date.now() - 1000), // Expired 1s ago!
      consumedAt: null,
    };

    expect(() =>
      validateConfirmationEligibility({
        record,
        callerBusinessId: 'biz-1',
        callerUserId: 'user-1',
        callerRole: 'member',
      }),
    ).toThrow('CONFIRMATION_EXPIRED');
  });
});

describe('Confirmation Engine - Idempotency Binding & Conflict Rejection', () => {
  const samplePayloadHash = hashPayload({ amount: 2400 });

  it('returns NEW_REQUEST when no existing idempotency record exists', () => {
    const result = checkIdempotency({
      existingRecord: null,
      callerBusinessId: 'biz-1',
      actionType: 'record_expense',
      payloadHash: samplePayloadHash,
    });

    expect(result).toEqual({ state: 'NEW_REQUEST' });
  });

  it('returns REPLAY_CACHED when key is re-submitted with exact action and payload', () => {
    const record: IdempotencyRecord = {
      idempotencyKey: 'idem-key-1',
      businessId: 'biz-1',
      actionType: 'record_expense',
      payloadHash: samplePayloadHash,
      status: 'completed',
      responsePayload: { expenseId: 'exp-123', status: 'posted' },
      lockedUntil: new Date(),
    };

    const result = checkIdempotency({
      existingRecord: record,
      callerBusinessId: 'biz-1',
      actionType: 'record_expense',
      payloadHash: samplePayloadHash,
    });

    expect(result).toEqual({
      state: 'REPLAY_CACHED',
      responsePayload: { expenseId: 'exp-123', status: 'posted' },
    });
  });

  it('throws IDEMPOTENCY_CONFLICT when key is reused for a DIFFERENT action', () => {
    const record: IdempotencyRecord = {
      idempotencyKey: 'idem-key-1',
      businessId: 'biz-1',
      actionType: 'record_expense',
      payloadHash: samplePayloadHash,
      status: 'completed',
      responsePayload: {},
      lockedUntil: new Date(),
    };

    expect(() =>
      checkIdempotency({
        existingRecord: record,
        callerBusinessId: 'biz-1',
        actionType: 'create_invoice', // Different action!
        payloadHash: samplePayloadHash,
      }),
    ).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('throws IDEMPOTENCY_CONFLICT when key is reused for a DIFFERENT payload', () => {
    const record: IdempotencyRecord = {
      idempotencyKey: 'idem-key-1',
      businessId: 'biz-1',
      actionType: 'record_expense',
      payloadHash: samplePayloadHash,
      status: 'completed',
      responsePayload: {},
      lockedUntil: new Date(),
    };

    const differentPayloadHash = hashPayload({ amount: 5000, description: 'other' });

    expect(() =>
      checkIdempotency({
        existingRecord: record,
        callerBusinessId: 'biz-1',
        actionType: 'record_expense',
        payloadHash: differentPayloadHash, // Different payload!
      }),
    ).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('throws IDEMPOTENCY_IN_FLIGHT when identical request is currently processing', () => {
    const record: IdempotencyRecord = {
      idempotencyKey: 'idem-key-1',
      businessId: 'biz-1',
      actionType: 'record_expense',
      payloadHash: samplePayloadHash,
      status: 'pending',
      responsePayload: null,
      lockedUntil: new Date(Date.now() + 30000), // Locked for 30s
    };

    expect(() =>
      checkIdempotency({
        existingRecord: record,
        callerBusinessId: 'biz-1',
        actionType: 'record_expense',
        payloadHash: samplePayloadHash,
      }),
    ).toThrow('IDEMPOTENCY_IN_FLIGHT');
  });
});

describe('Audit Hash Engine - Verification', () => {
  it('produces deterministic SHA-256 audit entry hashes', () => {
    const timestamp = new Date('2026-09-25T01:00:00.000Z');
    const hash = computeAuditEntryHash({
      prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
      sequenceNumber: 1n,
      timestamp,
      action: 'record_expense',
      entityId: 'exp-123',
      payloadHash: 'hash-abc',
    });

    expect(hash).toHaveLength(64);
    // Same parameters produce identical hash
    const hash2 = computeAuditEntryHash({
      prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
      sequenceNumber: 1n,
      timestamp,
      action: 'record_expense',
      entityId: 'exp-123',
      payloadHash: 'hash-abc',
    });
    expect(hash).toBe(hash2);
  });
});
