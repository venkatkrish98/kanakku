import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

export type KanakkuDatabase = NodePgDatabase<typeof schema>;

let poolInstance: pg.Pool | null = null;
let dbInstance: KanakkuDatabase | null = null;

export function getDatabase(connectionString?: string): KanakkuDatabase {
  if (dbInstance) {
    return dbInstance;
  }

  const url =
    connectionString ||
    process.env['DATABASE_URL'] ||
    'postgres://kanakku_user:kanakku_dev_password@localhost:5433/kanakku_db';

  poolInstance = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
  });

  dbInstance = drizzle(poolInstance, { schema });
  return dbInstance;
}

export async function closeDatabase(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
    dbInstance = null;
  }
}

export * from './schema/index.js';
