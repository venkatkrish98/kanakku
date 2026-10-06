import { eq, and, inArray, sql } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { auditAnchorOutbox, idempotencyRecords } from '@kanakku/db';
import { anchorAuditHead, type AuditAnchorReceipt, type AuditAnchorSink } from './anchor.js';

export interface CreateOutboxItemParams {
  businessId: string;
  targetEntityType: string;
  targetEntityId: string;
  auditSequenceNumber: bigint;
  headHash: string;
  idempotencyKey?: string | null;
}

export interface ProcessOutboxResult {
  outboxId: string;
  status: 'anchored' | 'failed';
  receipt?: AuditAnchorReceipt;
  error?: string;
}

export interface OutboxWorkerHandle {
  stop: () => void;
  triggerNow: () => Promise<{ total: number; succeeded: number; failed: number }>;
}

/**
 * Creates a durable transactional outbox record for an external audit anchor.
 * MUST be invoked inside the same database transaction as the entity mutation (e.g. month-end close).
 */
export async function createAuditAnchorOutboxItem(
  tx: KanakkuDatabase,
  params: CreateOutboxItemParams,
) {
  const [record] = await tx
    .insert(auditAnchorOutbox)
    .values({
      businessId: params.businessId,
      targetEntityType: params.targetEntityType,
      targetEntityId: params.targetEntityId,
      auditSequenceNumber: params.auditSequenceNumber,
      headHash: params.headHash,
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      idempotencyKey: params.idempotencyKey ?? null,
    })
    .onConflictDoUpdate({
      target: [
        auditAnchorOutbox.businessId,
        auditAnchorOutbox.targetEntityType,
        auditAnchorOutbox.targetEntityId,
      ],
      set: {
        auditSequenceNumber: params.auditSequenceNumber,
        headHash: params.headHash,
        status: 'pending',
        lockedUntil: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!record) {
    throw new Error('Failed to create or update audit anchor outbox record');
  }

  return record;
}

/**
 * Atomically claims up to `limit` outbox items using PostgreSQL's `FOR UPDATE SKIP LOCKED`.
 * Applies a `locked_until` lease (default 120s) so concurrent workers running on
 * multiple server replicas never process the same outbox row concurrently.
 */
export async function claimAuditAnchorOutboxBatch(
  db: KanakkuDatabase,
  limit: number = 10,
  lockDurationMs: number = 120_000,
): Promise<string[]> {
  const lockUntil = new Date(Date.now() + lockDurationMs);

  return await db.transaction(async (tx) => {
    // 1. Atomically query available pending or failed items with FOR UPDATE SKIP LOCKED
    const claimedRows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM audit_anchor_outbox
      WHERE status IN ('pending', 'failed')
        AND attempts < max_attempts
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);

    const claimedIds = claimedRows.rows.map((r) => r.id);
    if (claimedIds.length === 0) {
      return [];
    }

    // 2. Mark claimed rows with a locked_until lease
    await tx
      .update(auditAnchorOutbox)
      .set({
        lockedUntil: lockUntil,
        updatedAt: new Date(),
      })
      .where(inArray(auditAnchorOutbox.id, claimedIds));

    return claimedIds;
  });
}

/**
 * Processes a single audit anchor outbox item.
 * On success: updates outbox to 'anchored', records receipt, clears lease, and updates linked idempotency cache.
 * On failure: increments attempts, records error, clears lease, marks 'failed' for subsequent worker retry.
 */
export async function processAuditAnchorOutboxItem(
  outboxId: string,
  db: KanakkuDatabase,
  sink?: AuditAnchorSink,
  secretKey?: string,
): Promise<ProcessOutboxResult> {
  const [item] = await db
    .select()
    .from(auditAnchorOutbox)
    .where(eq(auditAnchorOutbox.id, outboxId))
    .limit(1);

  if (!item) {
    throw new Error(`AUDIT_OUTBOX_ITEM_NOT_FOUND: No outbox record for ID "${outboxId}"`);
  }

  if (item.status === 'anchored' && item.receiptPayload) {
    return {
      outboxId: item.id,
      status: 'anchored',
      receipt: item.receiptPayload as unknown as AuditAnchorReceipt,
    };
  }

  try {
    const receipt = await anchorAuditHead(item.businessId, db, sink, secretKey);

    // 1. Update outbox record with verified receipt and clear lock lease
    await db
      .update(auditAnchorOutbox)
      .set({
        status: 'anchored',
        anchoredAt: new Date(receipt.anchoredAt),
        sinkIdentifier: receipt.sinkIdentifier,
        receiptPayload: receipt,
        attempts: item.attempts + 1,
        lastError: null,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(auditAnchorOutbox.id, item.id));

    // 2. Synchronize Idempotency Cache: update stored response so replayed requests return completed anchor
    if (item.idempotencyKey) {
      const [idempotencyRow] = await db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.businessId, item.businessId),
            eq(idempotencyRecords.idempotencyKey, item.idempotencyKey),
          ),
        )
        .limit(1);

      if (idempotencyRow && idempotencyRow.responsePayload) {
        const payload = idempotencyRow.responsePayload as Record<string, unknown>;
        payload['audit_anchor'] = {
          anchored: true,
          status: 'anchored',
          sink: receipt.sinkIdentifier,
          head_hash: receipt.headHash,
          sequence: receipt.sequenceNumber,
          anchored_at: receipt.anchoredAt,
        };

        await db
          .update(idempotencyRecords)
          .set({ responsePayload: payload })
          .where(eq(idempotencyRecords.id, idempotencyRow.id));
      }
    }

    return {
      outboxId: item.id,
      status: 'anchored',
      receipt,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    await db
      .update(auditAnchorOutbox)
      .set({
        status: 'failed',
        attempts: item.attempts + 1,
        lastError: errorMessage,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(auditAnchorOutbox.id, item.id));

    return {
      outboxId: item.id,
      status: 'failed',
      error: errorMessage,
    };
  }
}

/**
 * Durable worker to process all pending or failed audit anchor outbox items.
 * Atomically claims items using PostgreSQL's FOR UPDATE SKIP LOCKED.
 */
export async function processPendingAuditOutbox(
  db: KanakkuDatabase,
  options?: {
    limit?: number;
    sink?: AuditAnchorSink;
    secretKey?: string;
    lockDurationMs?: number;
  },
): Promise<{ total: number; succeeded: number; failed: number; results: ProcessOutboxResult[] }> {
  const limit = options?.limit ?? 25;
  const lockDurationMs = options?.lockDurationMs ?? 120_000;

  // Atomically claim rows via FOR UPDATE SKIP LOCKED
  const claimedIds = await claimAuditAnchorOutboxBatch(db, limit, lockDurationMs);
  if (claimedIds.length === 0) {
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    };
  }

  const results: ProcessOutboxResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const id of claimedIds) {
    const result = await processAuditAnchorOutboxItem(
      id,
      db,
      options?.sink,
      options?.secretKey,
    );
    results.push(result);
    if (result.status === 'anchored') {
      succeeded++;
    } else {
      failed++;
    }
  }

  return {
    total: claimedIds.length,
    succeeded,
    failed,
    results,
  };
}

/**
 * Starts a background worker loop that periodically sweeps and processes
 * pending or failed audit outbox records.
 * Provides reentrancy protection, immediate startup sweep, and graceful shutdown.
 */
export function startAuditOutboxWorker(
  db: KanakkuDatabase,
  options?: {
    intervalMs?: number;
    limit?: number;
    sink?: AuditAnchorSink;
    secretKey?: string;
    onSweep?: (result: { total: number; succeeded: number; failed: number }) => void;
    onError?: (err: unknown) => void;
  },
): OutboxWorkerHandle {
  const intervalMs = options?.intervalMs ?? 30_000;
  let isRunning = false;
  let stopped = false;

  const runSweep = async () => {
    if (isRunning || stopped) return { total: 0, succeeded: 0, failed: 0 };
    isRunning = true;
    try {
      const result = await processPendingAuditOutbox(db, {
        limit: options?.limit,
        sink: options?.sink,
        secretKey: options?.secretKey,
      });
      options?.onSweep?.(result);
      return result;
    } catch (err) {
      options?.onError?.(err);
      return { total: 0, succeeded: 0, failed: 0 };
    } finally {
      isRunning = false;
    }
  };

  // Immediate sweep on startup
  void runSweep();

  // Periodic interval timer
  const timer = setInterval(() => {
    void runSweep();
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    triggerNow: async () => {
      while (isRunning) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return await runSweep();
    },
  };
}
