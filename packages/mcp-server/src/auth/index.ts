import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { KanakkuDatabase } from '@kanakku/db';
import { users, businesses } from '@kanakku/db';
import type { UserRole } from '@kanakku/core';

export interface AuthenticatedTenantContext {
  businessId: string;
  userId: string;
  userRole: UserRole;
  business: {
    id: string;
    name: string;
    legalName: string;
    gstin: string;
    stateCode: string;
    currency: string;
    financialYearStartMonth: number;
  };
  sessionId?: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  };
}

export const tenantContextStorage = new AsyncLocalStorage<AuthenticatedTenantContext>();

/**
 * Returns the current authenticated tenant context from the active async execution context.
 * Throws if called outside an authenticated request scope.
 */
export function getTenantContext(): AuthenticatedTenantContext {
  const context = tenantContextStorage.getStore();
  if (!context) {
    throw new Error('UNAUTHENTICATED_TENANT_CONTEXT: No active authenticated tenant session found');
  }
  return context;
}

/**
 * Resolves authentication token against database users and businesses.
 * Strictly verifies API keys via SHA-256 hash match against users.apiKeyHash.
 * All client-supplied identity shortcuts (such as user IDs or email addresses)
 * are rejected to prevent authentication bypass.
 */
export async function authenticateToken(
  token: string,
  db: KanakkuDatabase,
): Promise<AuthenticatedTenantContext> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    throw new Error('UNAUTHENTICATED: Authentication token is empty');
  }

  // Explicitly reject insecure client identity shortcuts
  if (cleanToken.startsWith('user:') || cleanToken.includes('@')) {
    throw new Error('INVALID_CREDENTIALS: User ID and email shortcuts are not permitted as credentials');
  }

  // API Key lookup strictly via SHA-256 hash match against users table
  const tokenHash = createHash('sha256').update(cleanToken).digest('hex');
  const foundUsers = await db
    .select()
    .from(users)
    .where(eq(users.apiKeyHash, tokenHash))
    .limit(1);

  if (foundUsers.length > 0 && foundUsers[0]) {
    return resolveUserContextById(foundUsers[0].id, db);
  }

  throw new Error('INVALID_CREDENTIALS: Provided authentication token does not match any valid tenant');
}

/**
 * Loads user and their business profile, asserting tenant existence and role validity.
 */
export async function resolveUserContextById(
  userId: string,
  db: KanakkuDatabase,
): Promise<AuthenticatedTenantContext> {
  const foundUsers = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = foundUsers[0];
  if (!user) {
    throw new Error(`USER_NOT_FOUND: User with ID "${userId}" does not exist`);
  }

  const foundBusinesses = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, user.businessId))
    .limit(1);

  const business = foundBusinesses[0];
  if (!business) {
    throw new Error(
      `BUSINESS_NOT_FOUND: Business with ID "${user.businessId}" for user "${user.id}" does not exist`,
    );
  }

  const userRole = (user.role as UserRole) || 'member';

  return {
    businessId: business.id,
    userId: user.id,
    userRole,
    business: {
      id: business.id,
      name: business.name,
      legalName: business.legalName,
      gstin: business.gstin,
      stateCode: business.stateCode,
      currency: business.currency,
      financialYearStartMonth: business.financialYearStartMonth,
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: userRole,
    },
  };
}
