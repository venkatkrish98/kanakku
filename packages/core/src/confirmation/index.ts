/**
 * Universal Confirmation Lifecycle & Idempotency Engine.
 * Enforces hashed token storage at rest and binds idempotency keys to exact action and payload hash.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface GeneratedToken {
  tokenSecret: string;
  tokenHash: string;
  payloadHash: string;
  expiresAt: Date;
}

/**
 * Recursively canonicalizes any JSON-serializable value by sorting object keys at every level.
 * Guarantees that nested objects with the same keys and values yield the exact same string,
 * without dropping any nested properties.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serializedItems = value.map((item) => canonicalizeJson(item));
    return `[${serializedItems.join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map((key) => {
    return `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`;
  });

  return `{${entries.join(',')}}`;
}

/**
 * Computes canonical SHA-256 hash of a payload object.
 */
export function hashPayload(payload: unknown): string {
  const canonicalJson = canonicalizeJson(payload);
  return createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Computes SHA-256 hash of a confirmation token secret.
 */
export function hashToken(tokenSecret: string): string {
  return createHash('sha256').update(tokenSecret.trim()).digest('hex');
}

/**
 * Computes deterministic audit entry hash adhering to the architecture specification:
 * SHA256(prevHash:sequenceNumber:isoTimestamp:action:entityId:payloadHash)
 */
export function computeAuditEntryHash(params: {
  prevHash: string;
  sequenceNumber: bigint;
  timestamp: Date;
  action: string;
  entityId?: string | null;
  payloadHash: string;
}): string {
  const isoTimestamp = params.timestamp.toISOString();
  const entityIdStr = params.entityId ?? '';
  const data = `${params.prevHash}:${params.sequenceNumber.toString()}:${isoTimestamp}:${params.action}:${entityIdStr}:${params.payloadHash}`;
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Generates a cryptographically secure confirmation token and its corresponding hashes.
 * Standard TTL: 15 minutes.
 */
export function generateConfirmationToken(
  payload: unknown,
  ttlMs: number = 15 * 60 * 1000,
): GeneratedToken {
  const tokenSecret = randomBytes(16).toString('hex');
  const tokenHash = hashToken(tokenSecret);
  const payloadHash = hashPayload(payload);
  const expiresAt = new Date(Date.now() + ttlMs);

  return {
    tokenSecret,
    tokenHash,
    payloadHash,
    expiresAt,
  };
}

export interface PendingConfirmationRecord {
  id: string;
  businessId: string;
  userId: string;
  tokenHash: string;
  actionType: string;
  payload: unknown;
  payloadHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export type UserRole = 'owner' | 'accountant' | 'member';

/**
 * Validates that a pending confirmation record is eligible for consumption.
 * Checks tenant boundary, token expiration, single-use status, and user authorization.
 */
export function validateConfirmationEligibility(params: {
  record: PendingConfirmationRecord;
  callerBusinessId: string;
  callerUserId: string;
  callerRole: UserRole;
  now?: Date;
}): void {
  const { record, callerBusinessId, callerUserId, callerRole, now = new Date() } = params;

  if (!callerUserId || !callerRole) {
    throw new Error(
      'UNAUTHENTICATED_CALLER: Both callerUserId and callerRole are required to validate confirmation eligibility',
    );
  }

  if (record.businessId !== callerBusinessId) {
    throw new Error(
      'TENANT_MISMATCH: Confirmation token does not belong to the authenticated business',
    );
  }

  if (record.consumedAt !== null) {
    throw new Error(
      'CONFIRMATION_ALREADY_CONSUMED: This confirmation has already been executed or cancelled',
    );
  }

  if (now > record.expiresAt) {
    throw new Error(
      'CONFIRMATION_EXPIRED: Confirmation token has expired (15-minute TTL exceeded)',
    );
  }

  // User authorization check: allowed only if caller is the initiator or has 'owner' role
  if (callerUserId !== record.userId && callerRole !== 'owner') {
    throw new Error(
      'USER_NOT_AUTHORIZED: Only the initiating user or a business owner can confirm this action',
    );
  }
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  businessId: string;
  actionType: string;
  payloadHash: string;
  status: 'pending' | 'completed' | 'failed';
  responsePayload: unknown | null;
  lockedUntil: Date;
}

export type IdempotencyCheckResult =
  | { state: 'NEW_REQUEST' }
  | { state: 'REPLAY_CACHED'; responsePayload: unknown }
  | { state: 'IN_FLIGHT' };

/**
 * Validates an existing idempotency record against a requested execution.
 * Enforces strict binding: rejects reuse of an idempotency key for a different action or payload.
 */
export function checkIdempotency(params: {
  existingRecord: IdempotencyRecord | null;
  callerBusinessId: string;
  actionType: string;
  payloadHash: string;
  now?: Date;
}): IdempotencyCheckResult {
  const { existingRecord, callerBusinessId, actionType, payloadHash, now = new Date() } = params;

  if (!existingRecord) {
    return { state: 'NEW_REQUEST' };
  }

  if (existingRecord.businessId !== callerBusinessId) {
    throw new Error('TENANT_MISMATCH: Idempotency key belongs to a different business');
  }

  // Strict binding check: reject reuse for different action or payload
  if (existingRecord.actionType !== actionType || existingRecord.payloadHash !== payloadHash) {
    throw new Error(
      `IDEMPOTENCY_CONFLICT: Idempotency key "${existingRecord.idempotencyKey}" was previously used for a different action or payload`,
    );
  }

  if (existingRecord.status === 'completed') {
    return {
      state: 'REPLAY_CACHED',
      responsePayload: existingRecord.responsePayload,
    };
  }

  if (existingRecord.status === 'pending') {
    if (now < existingRecord.lockedUntil) {
      throw new Error(
        `IDEMPOTENCY_IN_FLIGHT: A request with idempotency key "${existingRecord.idempotencyKey}" is currently in progress`,
      );
    }
    // Expired lock, allow retry
    return { state: 'NEW_REQUEST' };
  }

  // Failed status allows fresh retry
  return { state: 'NEW_REQUEST' };
}
