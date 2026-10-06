import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDatabase, closeDatabase, type KanakkuDatabase, businesses, auditLogs, auditAnchorOutbox, idempotencyRecords } from '@kanakku/db';
import {
  appendAuditLog,
  verifyAuditChain,
  anchorAuditHead,
  createAuditAnchorOutboxItem,
  processAuditAnchorOutboxItem,
  processPendingAuditOutbox,
  claimAuditAnchorOutboxBatch,
  startAuditOutboxWorker,
  MemoryAnchorSink,
  GENESIS_PREV_HASH,
} from './index.js';

describe('Serialized Hash-Chained Audit Engine', () => {
  let db: KanakkuDatabase;
  const testBizId = 'b0000000-0000-0000-0000-000000000099';

  beforeAll(async () => {
    db = getDatabase();

    // Create a temporary isolated business for audit testing
    await db
      .insert(businesses)
      .values({
        id: testBizId,
        name: 'Audit Test Corp',
        legalName: 'Audit Test Corp Pvt Ltd',
        gstin: '33TESTB1234A1Z1',
        stateCode: '33',
        pan: 'TESTB1234A',
      })
      .onConflictDoNothing();

    // Clean any prior test audit logs
    await db.delete(auditLogs).where(eq(auditLogs.businessId, testBizId));
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(eq(auditLogs.businessId, testBizId));
    await db.delete(businesses).where(eq(businesses.id, testBizId));
    await closeDatabase();
  });

  it('verifies empty chain as valid with 0 entries', async () => {
    const health = await verifyAuditChain(testBizId, db);
    expect(health.valid).toBe(true);
    expect(health.totalEntries).toBe(0);
    expect(health.headSequence).toBeNull();
  });

  it('appends sequence 1 entry with genesis prev_hash', async () => {
    const entry = await db.transaction(async (tx) => {
      return appendAuditLog(tx, {
        businessId: testBizId,
        source: 'mcp_client',
        toolName: 'test_tool',
        action: 'test:create',
        entityType: 'test_entity',
        payload: { testKey: 'value1' },
      });
    });

    expect(entry.sequenceNumber).toBe(1n);
    expect(entry.prevHash).toBe(GENESIS_PREV_HASH);
    expect(entry.entryHash).toHaveLength(64);

    const health = await verifyAuditChain(testBizId, db);
    expect(health.valid).toBe(true);
    expect(health.totalEntries).toBe(1);
    expect(health.headSequence).toBe(1n);
    expect(health.headHash).toBe(entry.entryHash);
  });

  it('appends sequence 2 with prev_hash chained to sequence 1 entry_hash', async () => {
    const entry2 = await db.transaction(async (tx) => {
      return appendAuditLog(tx, {
        businessId: testBizId,
        source: 'mcp_client',
        toolName: 'test_tool',
        action: 'test:update',
        entityType: 'test_entity',
        payload: { testKey: 'value2' },
      });
    });

    expect(entry2.sequenceNumber).toBe(2n);

    // Verify it chained to seq 1
    const [seq1] = await db
      .select({ entryHash: auditLogs.entryHash })
      .from(auditLogs)
      .where(sql`${auditLogs.businessId} = ${testBizId} AND ${auditLogs.sequenceNumber} = 1`);

    expect(entry2.prevHash).toBe(seq1!.entryHash);

    const health = await verifyAuditChain(testBizId, db);
    expect(health.valid).toBe(true);
    expect(health.totalEntries).toBe(2);
    expect(health.headSequence).toBe(2n);
  });

  it('appends sequence 3 and maintains uninterrupted chain', async () => {
    const entry3 = await db.transaction(async (tx) => {
      return appendAuditLog(tx, {
        businessId: testBizId,
        source: 'mcp_client',
        toolName: 'test_tool',
        action: 'test:confirm',
        entityType: 'test_entity',
        payload: { testKey: 'value3' },
      });
    });

    expect(entry3.sequenceNumber).toBe(3n);

    const health = await verifyAuditChain(testBizId, db);
    expect(health.valid).toBe(true);
    expect(health.totalEntries).toBe(3);
    expect(health.headSequence).toBe(3n);
  });

  it('detects tampering when an audit log row is maliciously altered', async () => {
    try {
      // Maliciously tamper with sequence 2's action
      await db
        .update(auditLogs)
        .set({ action: 'tampered_action_mutation' })
        .where(sql`${auditLogs.businessId} = ${testBizId} AND ${auditLogs.sequenceNumber} = 2`);

      const health = await verifyAuditChain(testBizId, db);
      expect(health.valid).toBe(false);
      expect(health.error).toContain('Cryptographic hash corruption');
      expect(health.tamperedSequence).toBe(2n);
    } finally {
      // Restore valid action so subsequent tests on testBizId have a valid chain
      await db
        .update(auditLogs)
        .set({ action: 'test:update' })
        .where(sql`${auditLogs.businessId} = ${testBizId} AND ${auditLogs.sequenceNumber} = 2`);
    }
  });

  it('covers afterState in cryptographic hash chain and detects tampering', async () => {
    const bizId = 'b0000000-0000-0000-0000-000000000098';
    await db
      .insert(businesses)
      .values({
        id: bizId,
        name: 'State Audit Corp',
        legalName: 'State Audit Corp Pvt Ltd',
        gstin: '33TESTS1234A1Z1',
        stateCode: '33',
        pan: 'TESTS1234A',
      })
      .onConflictDoNothing();

    await db.delete(auditLogs).where(eq(auditLogs.businessId, bizId));

    try {
      // Append entry with beforeState and afterState
      const entry = await db.transaction(async (tx) => {
        return appendAuditLog(tx, {
          businessId: bizId,
          source: 'mcp_client',
          toolName: 'close_month',
          action: 'reclassify_expense',
          entityType: 'expense',
          entityId: 'e0000000-0000-0000-0000-000000000001',
          beforeState: { category_id: 'cat-old', gl_account_id: 'gl-old' },
          afterState: { category_id: 'cat-new', gl_account_id: 'gl-new' },
        });
      });

      expect(entry.sequenceNumber).toBe(1n);

      // Verify chain is valid initially
      const initialHealth = await verifyAuditChain(bizId, db);
      expect(initialHealth.valid).toBe(true);

      // Maliciously tamper with afterState directly in DB
      await db
        .update(auditLogs)
        .set({ afterState: { category_id: 'cat-malicious', gl_account_id: 'gl-malicious' } })
        .where(eq(auditLogs.businessId, bizId));

      const tamperedHealth = await verifyAuditChain(bizId, db);
      expect(tamperedHealth.valid).toBe(false);
      expect(tamperedHealth.error).toContain('beforeState or afterState tampered');
      expect(tamperedHealth.tamperedSequence).toBe(1n);
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.businessId, bizId));
      await db.delete(businesses).where(eq(businesses.id, bizId));
    }
  });

  it('Phase 7 production: anchorAuditHead anchors valid chain to external sink with cryptographic receipt', async () => {
    const anchorBizId = 'b0000000-0000-0000-0000-000000000097';
    await db
      .insert(businesses)
      .values({
        id: anchorBizId,
        name: 'Anchor Test Corp',
        legalName: 'Anchor Test Corp Pvt Ltd',
        gstin: '33TESTA1234A1Z1',
        stateCode: '33',
        pan: 'TESTA1234A',
      })
      .onConflictDoNothing();

    await db.delete(auditLogs).where(eq(auditLogs.businessId, anchorBizId));

    try {
      await db.transaction(async (tx) => {
        return appendAuditLog(tx, {
          businessId: anchorBizId,
          source: 'mcp_client',
          toolName: 'record_expense',
          action: 'record_expense',
          entityType: 'expense',
          payload: { amountPaise: 500000 },
        });
      });

      let capturedReceipt: any = null;
      const mockSink = {
        async anchor(receipt: any) {
          capturedReceipt = receipt;
        },
      };

      const receipt = await anchorAuditHead(anchorBizId, db, mockSink, 'test-secret-key');

      expect(receipt.businessId).toBe(anchorBizId);
      expect(receipt.headHash).toHaveLength(64);
      expect(receipt.receiptSignature).toHaveLength(64);
      expect(receipt.sinkType).toBe('cloudwatch_logs');
      expect(capturedReceipt).toEqual(receipt);
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.businessId, anchorBizId));
      await db.delete(businesses).where(eq(businesses.id, anchorBizId));
    }
  });

  it('Phase 7 production: anchorAuditHead refuses to anchor corrupted chain', async () => {
    const corruptBizId = 'b0000000-0000-0000-0000-000000000088';
    await db
      .insert(businesses)
      .values({
        id: corruptBizId,
        name: 'Corrupt Corp',
        legalName: 'Corrupt Corp Pvt Ltd',
        gstin: '33TESTB9999A1Z1',
        stateCode: '33',
        pan: 'TESTB9999A',
      })
      .onConflictDoNothing();

    try {
      // Append an entry
      await db.transaction(async (tx) => {
        return appendAuditLog(tx, {
          businessId: corruptBizId,
          source: 'mcp_client',
          toolName: 'test',
          action: 'test',
          entityType: 'test',
          payload: { ok: true },
        });
      });

      // Tamper with entryHash directly
      await db
        .update(auditLogs)
        .set({ entryHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
        .where(eq(auditLogs.businessId, corruptBizId));

      await expect(
        anchorAuditHead(corruptBizId, db, { anchor: async () => {} }, 'test-secret-key'),
      ).rejects.toThrow(/Cannot anchor corrupted or empty audit chain/);
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.businessId, corruptBizId));
      await db.delete(businesses).where(eq(businesses.id, corruptBizId));
    }
  });

  it('Phase 7 security: anchorAuditHead strictly throws if no secret key is provided (no hardcoded fallback)', async () => {
    const origSecret = process.env['AUDIT_ANCHOR_SECRET'];
    delete process.env['AUDIT_ANCHOR_SECRET'];

    try {
      await expect(
        anchorAuditHead(testBizId, db, { anchor: async () => {} }),
      ).rejects.toThrow(/AUDIT_ANCHOR_SECRET_REQUIRED/);
    } finally {
      if (origSecret) {
        process.env['AUDIT_ANCHOR_SECRET'] = origSecret;
      }
    }
  });

  it('Phase 7 security: enforces fail-closed policy by rejecting unanchored execution', async () => {
    const origSecret = process.env['AUDIT_ANCHOR_SECRET'];
    delete process.env['AUDIT_ANCHOR_SECRET'];

    try {
      await expect(anchorAuditHead(testBizId, db)).rejects.toThrow(
        /AUDIT_ANCHOR_SECRET_REQUIRED/,
      );
    } finally {
      if (origSecret) {
        process.env['AUDIT_ANCHOR_SECRET'] = origSecret;
      }
    }
  });

  it('Phase 7 outbox: createAuditAnchorOutboxItem persists pending outbox record atomically', async () => {
    const fakeEntityId = '00000000-0000-0000-0000-000000000001';
    const outbox = await db.transaction(async (tx) => {
      return await createAuditAnchorOutboxItem(tx, {
        businessId: testBizId,
        targetEntityType: 'month_end_report',
        targetEntityId: fakeEntityId,
        auditSequenceNumber: 1n,
        headHash: 'hash123',
        idempotencyKey: 'idem-test-1',
      });
    });

    expect(outbox.status).toBe('pending');
    expect(outbox.attempts).toBe(0);

    const [found] = await db
      .select()
      .from(auditAnchorOutbox)
      .where(eq(auditAnchorOutbox.id, outbox.id));
    expect(found).toBeDefined();
    expect(found!.status).toBe('pending');

    await db.delete(auditAnchorOutbox).where(eq(auditAnchorOutbox.id, outbox.id));
  });

  it('Phase 7 outbox: processAuditAnchorOutboxItem anchors outbox and synchronizes idempotency cache', async () => {
    const fakeEntityId = '00000000-0000-0000-0000-000000000002';
    const idempotencyKey = 'idem-test-sync-1';

    // Insert fake idempotency row with pending anchor
    await db
      .insert(idempotencyRecords)
      .values({
        businessId: testBizId,
        idempotencyKey,
        actionType: 'close_month',
        payloadHash: 'hash',
        status: 'completed',
        lockedUntil: new Date(),
        responsePayload: {
          status: 'executed',
          audit_anchor: { anchored: false, status: 'pending' },
        },
      })
      .onConflictDoNothing();

    // Create outbox item
    const outbox = await db.transaction(async (tx) => {
      return await createAuditAnchorOutboxItem(tx, {
        businessId: testBizId,
        targetEntityType: 'month_end_report',
        targetEntityId: fakeEntityId,
        auditSequenceNumber: 1n,
        headHash: 'hash123',
        idempotencyKey,
      });
    });

    const sink = new MemoryAnchorSink();
    const result = await processAuditAnchorOutboxItem(outbox.id, db, sink, 'test-secret-key-32-chars-length!!');
    expect(result.status).toBe('anchored');
    expect(result.receipt).toBeDefined();
    expect(sink.receipts.length).toBe(1);

    // Verify outbox record updated in DB
    const [updatedOutbox] = await db
      .select()
      .from(auditAnchorOutbox)
      .where(eq(auditAnchorOutbox.id, outbox.id));
    expect(updatedOutbox!.status).toBe('anchored');
    expect(updatedOutbox!.anchoredAt).toBeDefined();

    // Verify idempotency record responsePayload was updated with completed anchor
    const [updatedIdem] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
    const payload = updatedIdem!.responsePayload as { audit_anchor: { anchored: boolean; status: string } };
    expect(payload.audit_anchor.anchored).toBe(true);
    expect(payload.audit_anchor.status).toBe('anchored');

    // Clean up
    await db.delete(auditAnchorOutbox).where(eq(auditAnchorOutbox.id, outbox.id));
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));
  });

  it('Phase 7 outbox worker: processPendingAuditOutbox retries failed outbox items and recovers', async () => {
    const fakeEntityId = '00000000-0000-0000-0000-000000000003';

    const outbox = await db.transaction(async (tx) => {
      return await createAuditAnchorOutboxItem(tx, {
        businessId: testBizId,
        targetEntityType: 'month_end_report',
        targetEntityId: fakeEntityId,
        auditSequenceNumber: 1n,
        headHash: 'hash123',
      });
    });

    // Process with missing secret to simulate failure
    const origSecret = process.env['AUDIT_ANCHOR_SECRET'];
    delete process.env['AUDIT_ANCHOR_SECRET'];

    try {
      const failResult = await processAuditAnchorOutboxItem(outbox.id, db);
      expect(failResult.status).toBe('failed');
      expect(failResult.error).toContain('AUDIT_ANCHOR_SECRET_REQUIRED');

      const [failedRecord] = await db
        .select()
        .from(auditAnchorOutbox)
        .where(eq(auditAnchorOutbox.id, outbox.id));
      expect(failedRecord!.status).toBe('failed');
      expect(failedRecord!.attempts).toBe(1);

      // Now restore secret and run worker to recover
      process.env['AUDIT_ANCHOR_SECRET'] = 'recovery-test-secret-key-32b!!';
      const workerResult = await processPendingAuditOutbox(db, { limit: 10 });
      expect(workerResult.succeeded).toBeGreaterThanOrEqual(1);

      const [recoveredRecord] = await db
        .select()
        .from(auditAnchorOutbox)
        .where(eq(auditAnchorOutbox.id, outbox.id));
      expect(recoveredRecord!.status).toBe('anchored');
    } finally {
      if (origSecret) {
        process.env['AUDIT_ANCHOR_SECRET'] = origSecret;
      }
      await db.delete(auditAnchorOutbox).where(eq(auditAnchorOutbox.id, outbox.id));
    }
  });

  it('Phase 7 concurrency: claimAuditAnchorOutboxBatch atomically claims items and prevents concurrent workers from duplicate processing', async () => {
    const fakeEntityId = '00000000-0000-0000-0000-000000000004';
    const outbox = await db.transaction(async (tx) => {
      return await createAuditAnchorOutboxItem(tx, {
        businessId: testBizId,
        targetEntityType: 'month_end_report',
        targetEntityId: fakeEntityId,
        auditSequenceNumber: 1n,
        headHash: 'hash123',
      });
    });

    try {
      // Worker 1 claims batch with a 60s lease
      const worker1Claimed = await claimAuditAnchorOutboxBatch(db, 10, 60_000);
      expect(worker1Claimed).toContain(outbox.id);

      // Concurrent Worker 2 attempts to claim batch simultaneously
      const worker2Claimed = await claimAuditAnchorOutboxBatch(db, 10, 60_000);
      // Because Worker 1 holds active lease (and SKIP LOCKED excludes locked rows), Worker 2 must NOT claim it
      expect(worker2Claimed).not.toContain(outbox.id);
    } finally {
      await db.delete(auditAnchorOutbox).where(eq(auditAnchorOutbox.id, outbox.id));
    }
  });

  it('Phase 7 worker lifecycle: startAuditOutboxWorker executes background sweeps and terminates cleanly on stop()', async () => {
    let sweepsTriggered = 0;
    const worker = startAuditOutboxWorker(db, {
      intervalMs: 50,
      onSweep: () => {
        sweepsTriggered++;
      },
    });

    try {
      // Trigger immediate manual sweep
      const manualRes = await worker.triggerNow();
      expect(manualRes).toBeDefined();
      expect(sweepsTriggered).toBeGreaterThanOrEqual(1);
    } finally {
      worker.stop();
    }
  });
});
