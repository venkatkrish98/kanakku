import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { pendingConfirmations } from '@kanakku/db';
import { hashToken } from '@kanakku/core';
import { getTenantContext } from '../auth/index.js';
import { appendAuditLog } from '../audit/index.js';
import { saveActiveWorkflowState } from './session-helper.js';

export const cancelActionSchema = {
  confirmation_token: z
    .string()
    .min(32)
    .describe('The confirmation token of the pending draft to cancel'),
  reason: z.string().optional().describe('Optional cancellation reason'),
};

export async function handleCancelAction(
  args: z.infer<z.ZodObject<typeof cancelActionSchema>>,
  db: KanakkuDatabase,
) {
  const tenant = getTenantContext();
  const businessId = tenant.businessId;
  const tokenHash = hashToken(args.confirmation_token);

  return await db.transaction(async (tx) => {
    const foundRecords = await tx
      .select()
      .from(pendingConfirmations)
      .where(eq(pendingConfirmations.tokenHash, tokenHash))
      .for('update');

    const pending = foundRecords[0];
    if (!pending) {
      throw new Error('INVALID_CONFIRMATION_TOKEN: No pending action matches this confirmation token');
    }

    if (pending.businessId !== businessId) {
      throw new Error('TENANT_MISMATCH: Confirmation token does not belong to the authenticated business');
    }

    if (pending.consumedAt !== null) {
      throw new Error('CONFIRMATION_ALREADY_CONSUMED: This confirmation has already been executed or cancelled');
    }

    // Mark as consumed / voided
    await tx
      .update(pendingConfirmations)
      .set({ consumedAt: new Date() })
      .where(eq(pendingConfirmations.id, pending.id));

    // Append audit log for the cancellation
    await appendAuditLog(tx, {
      businessId,
      userId: tenant.userId,
      source: 'mcp_client',
      toolName: 'cancel_action',
      action: `cancel:${pending.actionType}`,
      entityType: 'draft_action',
      entityId: pending.id,
      confirmationTokenHash: pending.tokenHash,
      payload: {
        cancelled_action: pending.actionType,
        reason: args.reason ?? 'User requested cancellation',
      },
    });

    if (pending.actionType === 'close_month') {
      const payload = pending.payload as Record<string, unknown> | null;
      await saveActiveWorkflowState(
        tx,
        businessId,
        null,
        {
          month: payload?.['month'],
          year: payload?.['year'],
          step: 'cancelled',
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
        },
        tenant.sessionId,
      );
    }

    const response = {
      status: 'cancelled',
      action_type: pending.actionType,
      draft_id: pending.id,
      message: `Pending draft ${pending.actionType} successfully cancelled. Books remain untouched.`,
      cancelled_at: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  });
}
