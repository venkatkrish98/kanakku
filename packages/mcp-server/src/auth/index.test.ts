import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDatabase, closeDatabase, type KanakkuDatabase, users } from '@kanakku/db';
import { authenticateToken, getTenantContext, tenantContextStorage } from './index.js';

describe('Auth & Tenant Context Provider', () => {
  let db: KanakkuDatabase;
  const testOwnerKey = 'kanakku_test_secret_ramesh_2026';
  const testOwnerKeyHash = createHash('sha256').update(testOwnerKey).digest('hex');

  beforeAll(async () => {
    db = getDatabase();
    // Explicitly provision test API key hash in test fixtures
    await db
      .update(users)
      .set({ apiKeyHash: testOwnerKeyHash })
      .where(eq(users.id, '10000000-0000-0000-0000-000000000001'));
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('authenticates valid seed token for Ramesh Kumar', async () => {
    const context = await authenticateToken('kanakku_test_secret_ramesh_2026', db);
    expect(context.businessId).toBe('b0000000-0000-0000-0000-000000000001');
    expect(context.userId).toBe('10000000-0000-0000-0000-000000000001');
    expect(context.userRole).toBe('owner');
    expect(context.business.name).toBe('Kanakku Creative Services');
    expect(context.business.gstin).toBe('33AAAAK1234A1Z5');
    expect(context.business.stateCode).toBe('33');
    expect(context.user.email).toBe('ramesh@kanakku.in');
  });

  it('rejects direct user ID shortcut with INVALID_CREDENTIALS', async () => {
    await expect(
      authenticateToken('user:10000000-0000-0000-0000-000000000001', db),
    ).rejects.toThrow('INVALID_CREDENTIALS');
  });

  it('rejects registered user email shortcut with INVALID_CREDENTIALS', async () => {
    await expect(authenticateToken('ramesh@kanakku.in', db)).rejects.toThrow('INVALID_CREDENTIALS');
  });

  it('rejects empty authentication token', async () => {
    await expect(authenticateToken('   ', db)).rejects.toThrow('UNAUTHENTICATED');
  });

  it('rejects unknown authentication token', async () => {
    await expect(authenticateToken('invalid_secret_token_12345', db)).rejects.toThrow(
      'INVALID_CREDENTIALS',
    );
  });

  it('fails closed when getTenantContext() is invoked outside active context', () => {
    expect(() => getTenantContext()).toThrow('UNAUTHENTICATED_TENANT_CONTEXT');
  });

  it('provides immutable context within tenantContextStorage.run()', async () => {
    const testContext = await authenticateToken('kanakku_test_secret_ramesh_2026', db);

    await tenantContextStorage.run(testContext, async () => {
      const active = getTenantContext();
      expect(active.businessId).toBe(testContext.businessId);
      expect(active.userId).toBe(testContext.userId);
      expect(active.userRole).toBe('owner');
    });
  });
});
