/**
 * Database Seed Execution Script.
 * Populates PostgreSQL with deterministic 3-month Indian SMB seed data.
 */

import { getDatabase, closeDatabase } from '../client.js';
import * as schema from '../schema/index.js';
import { generateSeedDataset, type SeedOptions } from '../seed/index.js';

export async function runSeed(options?: SeedOptions): Promise<void> {
  const db = getDatabase();
  const seed = generateSeedDataset(options);

  console.log('Seeding Kanakku database for tenant:', seed.business.name);

  // 1. Business
  await db
    .insert(schema.businesses)
    .values(seed.business)
    .onConflictDoUpdate({
      target: schema.businesses.id,
      set: {
        name: seed.business.name,
        legalName: seed.business.legalName,
        gstin: seed.business.gstin,
      },
    });

  // 2. Users
  for (const user of seed.users) {
    await db
      .insert(schema.users)
      .values(user)
      .onConflictDoUpdate({
        target: schema.users.id,
        set: {
          apiKeyHash: user.apiKeyHash,
          name: user.name,
          role: user.role,
        },
      });
  }

  // 3. Customers
  for (const customer of seed.customers) {
    await db.insert(schema.customers).values(customer).onConflictDoNothing();
  }

  // 4. Chart of Accounts
  for (const account of seed.chartOfAccounts) {
    await db.insert(schema.chartOfAccounts).values(account).onConflictDoNothing();
  }

  // 5. Expense Categories
  for (const category of seed.expenseCategories) {
    await db.insert(schema.expenseCategories).values(category).onConflictDoNothing();
  }

  // 6. Invoices
  for (const invoice of seed.invoices) {
    await db.insert(schema.invoices).values(invoice).onConflictDoNothing();
  }

  // 7. Expenses
  for (const expense of seed.expenses) {
    await db.insert(schema.expenses).values(expense).onConflictDoNothing();
  }

  // 8. Payments
  for (const payment of seed.payments) {
    await db.insert(schema.payments).values(payment).onConflictDoNothing();
  }

  // 9. Journal Entries
  for (const entry of seed.journalEntries) {
    await db.insert(schema.journalEntries).values(entry).onConflictDoNothing();
  }

  // 10. Journal Lines
  for (const line of seed.journalLines) {
    await db.insert(schema.journalLines).values(line).onConflictDoNothing();
  }

  // 11. Business Memory
  for (const memory of seed.businessMemory) {
    await db.insert(schema.businessMemory).values(memory).onConflictDoNothing();
  }

  // 12. Audit Logs
  for (const log of seed.auditLogs) {
    await db.insert(schema.auditLogs).values(log).onConflictDoNothing();
  }

  console.log('Database seeded successfully with deterministic 3-month dataset.');
  await closeDatabase();
}

// Execute when run directly
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  runSeed().catch((err) => {
    console.error('Failed to seed database:', err);
    process.exit(1);
  });
}
