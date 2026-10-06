import { randomUUID } from 'node:crypto';
import { eq, or, desc } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { conversationSessions, sessionContext } from '@kanakku/db';

type DbExecutor = KanakkuDatabase | Parameters<Parameters<KanakkuDatabase['transaction']>[0]>[0];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves or creates a durable conversation session and its attached sessionContext record.
 * Strictly guarantees tenant isolation: caller-supplied session keys that collide with
 * another business are rejected with CROSS_TENANT_SESSION_COLLISION and never adopted.
 */
export async function resolveSessionContext(
  db: DbExecutor,
  businessId: string,
  sessionIdentifier?: string,
) {
  let matchedSession: { id: string; sessionKey: string } | undefined;

  if (sessionIdentifier) {
    // 1. Check globally if the session identifier exists across ANY business
    const existingGlobal = await db
      .select({
        id: conversationSessions.id,
        businessId: conversationSessions.businessId,
        sessionKey: conversationSessions.sessionKey,
      })
      .from(conversationSessions)
      .where(
        UUID_REGEX.test(sessionIdentifier)
          ? or(
              eq(conversationSessions.id, sessionIdentifier),
              eq(conversationSessions.sessionKey, sessionIdentifier),
            )
          : eq(conversationSessions.sessionKey, sessionIdentifier),
      )
      .limit(1);

    if (existingGlobal[0]) {
      // Cross-tenant collision check: reject if session belongs to another business
      if (existingGlobal[0].businessId !== businessId) {
        throw new Error(
          `CROSS_TENANT_SESSION_COLLISION: Session identifier '${sessionIdentifier}' belongs to another business. Access denied.`,
        );
      }
      matchedSession = {
        id: existingGlobal[0].id,
        sessionKey: existingGlobal[0].sessionKey,
      };
    } else {
      // 2. Safe insertion: insert for this tenant without onConflict update
      try {
        const [inserted] = await db
          .insert(conversationSessions)
          .values({
            businessId,
            sessionKey: sessionIdentifier,
            lastActiveAt: new Date(),
          })
          .returning({ id: conversationSessions.id, sessionKey: conversationSessions.sessionKey });
        matchedSession = inserted;
      } catch (insertErr: unknown) {
        // Concurrency handling: check if concurrent insertion belongs to caller
        const [conflicted] = await db
          .select({
            id: conversationSessions.id,
            businessId: conversationSessions.businessId,
            sessionKey: conversationSessions.sessionKey,
          })
          .from(conversationSessions)
          .where(eq(conversationSessions.sessionKey, sessionIdentifier))
          .limit(1);

        if (conflicted) {
          if (conflicted.businessId !== businessId) {
            throw new Error(
              `CROSS_TENANT_SESSION_COLLISION: Session identifier '${sessionIdentifier}' belongs to another business. Access denied.`,
            );
          }
          matchedSession = {
            id: conflicted.id,
            sessionKey: conflicted.sessionKey,
          };
        } else {
          throw insertErr;
        }
      }
    }
  }

  // If no session identifier provided, look for the most recent active session for this business
  if (!matchedSession) {
    const recent = await db
      .select({ id: conversationSessions.id, sessionKey: conversationSessions.sessionKey })
      .from(conversationSessions)
      .where(eq(conversationSessions.businessId, businessId))
      .orderBy(desc(conversationSessions.lastActiveAt))
      .limit(1);

    if (recent[0]) {
      matchedSession = recent[0];
    } else {
      // Create default session for this business
      const defaultKey = `session-${businessId}-${randomUUID().slice(0, 8)}`;
      const [inserted] = await db
        .insert(conversationSessions)
        .values({
          businessId,
          sessionKey: defaultKey,
          lastActiveAt: new Date(),
        })
        .returning({ id: conversationSessions.id, sessionKey: conversationSessions.sessionKey });
      matchedSession = inserted;
    }
  }

  if (!matchedSession) {
    throw new Error('FAILED_TO_RESOLVE_SESSION: Could not initialize conversation session');
  }

  // Update session lastActiveAt
  await db
    .update(conversationSessions)
    .set({ lastActiveAt: new Date() })
    .where(eq(conversationSessions.id, matchedSession.id));

  // Find or create session_context record attached to this conversation session
  const existingContext = await db
    .select()
    .from(sessionContext)
    .where(eq(sessionContext.sessionId, matchedSession.id))
    .limit(1);

  if (existingContext[0]) {
    return {
      session: matchedSession,
      context: existingContext[0],
    };
  }

  const [newContext] = await db
    .insert(sessionContext)
    .values({
      sessionId: matchedSession.id,
      updatedAt: new Date(),
    })
    .returning();

  return {
    session: matchedSession,
    context: newContext!,
  };
}

/**
 * Persists active multi-step workflow state into the sessionContext table.
 */
export async function saveActiveWorkflowState(
  db: DbExecutor,
  businessId: string,
  workflowName: string | null,
  workflowState: Record<string, unknown> | null,
  sessionIdentifier?: string,
) {
  try {
    const { context } = await resolveSessionContext(db, businessId, sessionIdentifier);
    await db
      .update(sessionContext)
      .set({
        activeWorkflowName: workflowName,
        activeWorkflowState: workflowState,
        updatedAt: new Date(),
      })
      .where(eq(sessionContext.id, context.id));
  } catch (err) {
    if (err instanceof Error && err.message.includes('CROSS_TENANT_SESSION_COLLISION')) {
      throw err;
    }
    console.warn('Could not persist session workflow state to database:', err);
  }
}

/**
 * Loads the active multi-step workflow state from the sessionContext table.
 */
export async function loadActiveWorkflowState(
  db: DbExecutor,
  businessId: string,
  workflowName?: string,
  sessionIdentifier?: string,
): Promise<{ workflowName: string | null; workflowState: Record<string, unknown> | null } | null> {
  try {
    const { context } = await resolveSessionContext(db, businessId, sessionIdentifier);
    if (!context.activeWorkflowName) {
      return null;
    }
    if (workflowName && context.activeWorkflowName !== workflowName) {
      return null;
    }
    return {
      workflowName: context.activeWorkflowName,
      workflowState: (context.activeWorkflowState as Record<string, unknown>) ?? null,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('CROSS_TENANT_SESSION_COLLISION')) {
      throw err;
    }
    console.warn('Could not load session workflow state from database:', err);
    return null;
  }
}

/**
 * Clears the active workflow state when a workflow completes, is confirmed, or is cancelled.
 */
export async function clearActiveWorkflowState(
  db: DbExecutor,
  businessId: string,
  sessionIdentifier?: string,
) {
  try {
    const { context } = await resolveSessionContext(db, businessId, sessionIdentifier);
    await db
      .update(sessionContext)
      .set({
        activeWorkflowName: null,
        activeWorkflowState: null,
        updatedAt: new Date(),
      })
      .where(eq(sessionContext.id, context.id));
  } catch (err) {
    if (err instanceof Error && err.message.includes('CROSS_TENANT_SESSION_COLLISION')) {
      throw err;
    }
    console.warn('Could not clear session workflow state from database:', err);
  }
}
