import { z } from 'zod';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { auditLogs, users } from '@kanakku/db';
import { getTenantContext } from '../auth/index.js';
import { verifyAuditChain } from '../audit/index.js';

export const getAuditHistorySchema = {
  from_date: z.string().optional().describe('Filter by start date in ISO format'),
  to_date: z.string().optional().describe('Filter by end date in ISO format'),
  entity_type: z.string().optional().describe('Filter by entity type (e.g. "invoice", "expense")'),
  action: z.string().optional().describe('Filter by action name (e.g. "confirm:create_invoice")'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of log entries to retrieve (default: 20)'),
};

export async function handleGetAuditHistory(
  args: z.infer<z.ZodObject<typeof getAuditHistorySchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;

  // 1. Build filter conditions
  const conditions = [eq(auditLogs.businessId, businessId)];

  if (args.from_date) {
    conditions.push(gte(auditLogs.createdAt, new Date(args.from_date)));
  }
  if (args.to_date) {
    conditions.push(lte(auditLogs.createdAt, new Date(args.to_date)));
  }
  if (args.entity_type) {
    conditions.push(eq(auditLogs.entityType, args.entity_type));
  }
  if (args.action) {
    conditions.push(eq(auditLogs.action, args.action));
  }

  // 2. Fetch Audit Logs with before/after state
  const logs = await db
    .select({
      id: auditLogs.id,
      sequenceNumber: auditLogs.sequenceNumber,
      requestId: auditLogs.requestId,
      userId: auditLogs.userId,
      userName: users.name,
      source: auditLogs.source,
      toolName: auditLogs.toolName,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      beforeState: auditLogs.beforeState,
      afterState: auditLogs.afterState,
      confirmationTokenHash: auditLogs.confirmationTokenHash,
      prevHash: auditLogs.prevHash,
      entryHash: auditLogs.entryHash,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.sequenceNumber))
    .limit(args.limit);

  // 3. Verify Chain Integrity
  const chainHealth = await verifyAuditChain(businessId, db);

  const formattedLogs = logs.map((log) => ({
    sequence_number: log.sequenceNumber.toString(),
    request_id: log.requestId,
    who: log.userName ?? log.userId ?? 'system',
    when: log.createdAt.toISOString(),
    source: log.source,
    tool: log.toolName,
    action: log.action,
    entity_type: log.entityType,
    entity_id: log.entityId,
    before: log.beforeState,
    after: log.afterState,
    confirmation_status: log.confirmationTokenHash ? 'confirmed' : 'system_direct',
    prev_hash: log.prevHash,
    entry_hash: log.entryHash,
  }));

  const voiceSummary = `Audit log contains ${formattedLogs.length} recent entry(s). Cryptographic chain verification is ${chainHealth.valid ? 'valid and intact' : 'compromised'}.`;

  const response = {
    voice_summary: voiceSummary,
    chain_integrity: {
      is_valid: chainHealth.valid,
      total_chain_entries: chainHealth.totalEntries,
      head_sequence: chainHealth.headSequence?.toString() ?? null,
      head_hash: chainHealth.headHash,
      error: chainHealth.error ?? null,
    },
    returned_entries_count: formattedLogs.length,
    logs: formattedLogs,
    ui_resource_uri: 'ui://cards/audit-activity',
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}
