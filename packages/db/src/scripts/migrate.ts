/**
 * Database Migration Execution Script.
 * Applies all pending SQL migrations to PostgreSQL.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDatabase, closeDatabase } from '../client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  const db = getDatabase();
  const migrationsFolder = path.resolve(__dirname, '../migrations');
  console.log('Applying database migrations from:', migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.log('Migrations applied successfully.');
}

// Execute when run directly
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(async () => {
      await closeDatabase();
    })
    .catch(async (err) => {
      console.error('Failed to run migrations:', err);
      await closeDatabase();
      process.exit(1);
    });
}
