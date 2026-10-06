import { randomUUID } from 'node:crypto';
import { sql, eq, desc, asc } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { auditLogs } from '@kanakku/db';
import { computeAuditEntryHash, hashPayload } from '@kanakku/core';

export const GENESIS_PREV_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000';

export interface AppendAuditLogParams {
  businessId: string;
  userId?: string | null;
  requestId?: string;
  source: 'voice' | 'console_web' | 'mcp_client';
  toolName: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  confirmationTokenHash?: string | null;
  payload?: unknown;
  timestamp?: Date;
}

export interface AuditLogResult {
  id: string;
  businessId: string;
  sequenceNumber: bigint;
  requestId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  prevHash: string;
  entryHash: string;
  createdAt: Date;
}

/**
 * Appends a serialized, hash-chained audit log entry within a transaction.
 * Serializes writes per-tenant using PostgreSQL transaction-level advisory locks.
 */
export async function appendAuditLog(
  tx: KanakkuDatabase,
  params: AppendAuditLogParams,
): Promise<AuditLogResult> {
  const {
    businessId,
    userId = null,
    requestId = randomUUID(),
    source,
    toolName,
    action,
    entityType,
    entityId = null,
    beforeState = null,
    afterState = null,
    confirmationTokenHash = null,
    payload = null,
    timestamp = new Date(),
  } = params;

  // 1. Acquire transaction-level advisory lock on businessId to serialize audit insertions
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('audit_lock_' || ${businessId}::text))`,
  );

  // 2. Fetch the current head audit log entry for this business
  const headEntries = await tx
    .select({
      sequenceNumber: auditLogs.sequenceNumber,
      entryHash: auditLogs.entryHash,
    })
    .from(auditLogs)
    .where(eq(auditLogs.businessId, businessId))
    .orderBy(desc(auditLogs.sequenceNumber))
    .limit(1);

  const head = headEntries[0];
  const sequenceNumber = head ? head.sequenceNumber + 1n : 1n;
  const prevHash = head ? head.entryHash : GENESIS_PREV_HASH;

  // 3. Compute deterministic payload hash and entry hash
  const payloadToHash =
    payload !== null && payload !== undefined
      ? beforeState !== null || afterState !== null
        ? { payload, beforeState, afterState }
        : payload
      : beforeState !== null || afterState !== null
        ? { action, entityId, beforeState, afterState }
        : { action, entityId };
  const payloadHash = hashPayload(payloadToHash);
  const entryHash = computeAuditEntryHash({
    prevHash,
    sequenceNumber,
    timestamp,
    action,
    entityId,
    payloadHash,
  });

  // 4. Insert audit log row
  const [inserted] = await tx
    .insert(auditLogs)
    .values({
      businessId,
      sequenceNumber,
      requestId,
      userId,
      source,
      toolName,
      action,
      entityType,
      entityId,
      beforeState,
      afterState,
      confirmationTokenHash,
      payloadHash,
      prevHash,
      entryHash,
      createdAt: timestamp,
    })
    .returning();

  if (!inserted) {
    throw new Error('AUDIT_APPEND_FAILED: Failed to insert audit log entry');
  }

  return {
    id: inserted.id,
    businessId: inserted.businessId,
    sequenceNumber: inserted.sequenceNumber,
    requestId: inserted.requestId,
    action: inserted.action,
    entityType: inserted.entityType,
    entityId: inserted.entityId,
    prevHash: inserted.prevHash,
    entryHash: inserted.entryHash,
    createdAt: inserted.createdAt,
  };
}

export interface AuditVerificationResult {
  valid: boolean;
  totalEntries: number;
  headSequence: bigint | null;
  headHash: string | null;
  error?: string;
  tamperedSequence?: bigint;
}

/**
 * Validates the cryptographic integrity of the entire audit chain for a business.
 * Detects any deleted, altered, or out-of-order records.
 */
export async function verifyAuditChain(
  businessId: string,
  db: KanakkuDatabase,
): Promise<AuditVerificationResult> {
  const entries = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.businessId, businessId))
    .orderBy(asc(auditLogs.sequenceNumber));

  if (entries.length === 0) {
    return {
      valid: true,
      totalEntries: 0,
      headSequence: null,
      headHash: null,
    };
  }

  let expectedPrevHash = GENESIS_PREV_HASH;
  let expectedSeq = 1n;

  for (const entry of entries) {
    // Check sequential ordering
    if (entry.sequenceNumber !== expectedSeq) {
      return {
        valid: false,
        totalEntries: entries.length,
        headSequence: null,
        headHash: null,
        error: `Sequence gap detected: expected ${expectedSeq.toString()}, found ${entry.sequenceNumber.toString()}`,
        tamperedSequence: entry.sequenceNumber,
      };
    }

    // Check previous hash pointer
    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        totalEntries: entries.length,
        headSequence: null,
        headHash: null,
        error: `Previous hash mismatch at sequence ${entry.sequenceNumber.toString()}`,
        tamperedSequence: entry.sequenceNumber,
      };
    }

    // Verify before/after state integrity against payloadHash when state was captured
    if (entry.beforeState !== null || entry.afterState !== null) {
      const expectedStatePayloadHash = hashPayload({
        action: entry.action,
        entityId: entry.entityId,
        beforeState: entry.beforeState,
        afterState: entry.afterState,
      });

      if (entry.payloadHash !== expectedStatePayloadHash) {
        return {
          valid: false,
          totalEntries: entries.length,
          headSequence: null,
          headHash: null,
          error: `Cryptographic state corruption at sequence ${entry.sequenceNumber.toString()}: beforeState or afterState tampered`,
          tamperedSequence: entry.sequenceNumber,
        };
      }
    }

    // Recompute entry hash
    const computedHash = computeAuditEntryHash({
      prevHash: entry.prevHash,
      sequenceNumber: entry.sequenceNumber,
      timestamp: entry.createdAt,
      action: entry.action,
      entityId: entry.entityId,
      payloadHash: entry.payloadHash,
    });

    if (computedHash !== entry.entryHash) {
      return {
        valid: false,
        totalEntries: entries.length,
        headSequence: null,
        headHash: null,
        error: `Cryptographic hash corruption at sequence ${entry.sequenceNumber.toString()}`,
        tamperedSequence: entry.sequenceNumber,
      };
    }

    expectedPrevHash = entry.entryHash;
    expectedSeq += 1n;
  }

  const lastEntry = entries[entries.length - 1]!;
  return {
    valid: true,
    totalEntries: entries.length,
    headSequence: lastEntry.sequenceNumber,
    headHash: lastEntry.entryHash,
  };
}

export * from './anchor.js';
export * from './outbox.js';

