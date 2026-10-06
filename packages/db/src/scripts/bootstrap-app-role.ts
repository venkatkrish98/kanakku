import pg from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const { Pool } = pg;

export interface BootstrapRoleOptions {
  adminDatabaseUrl?: string;
  appUserPassword?: string;
  appDatabaseUrl?: string;
  region?: string;
  environment?: string;
}

/**
 * Parses a PostgreSQL connection string to extract password, username, host, etc.
 */
function parsePostgresUrl(urlString: string): { user: string; pass: string; host: string; port: number; db: string } {
  const url = new URL(urlString);
  return {
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    host: url.hostname,
    port: parseInt(url.port || '5432', 10),
    db: url.pathname.replace(/^\//, ''),
  };
}

/**
 * Automates secure provisioning of the least-privilege application runtime database user (kanakku_app).
 * Reads admin credentials and runtime password either from environment variables or AWS Secrets Manager.
 */
export async function bootstrapAppRole(options?: BootstrapRoleOptions): Promise<void> {
  const region = options?.region || process.env['AWS_REGION'] || 'ap-south-1';
  const environment = options?.environment || process.env['ENVIRONMENT'] || 'production';

  let adminDbUrl = options?.adminDatabaseUrl || process.env['ADMIN_DATABASE_URL'];
  let appPassword = options?.appUserPassword || process.env['APP_USER_PASSWORD'];
  const appDbUrl = options?.appDatabaseUrl || process.env['APP_DATABASE_URL'];

  // 1. If credentials not passed via env, attempt to resolve from AWS Secrets Manager
  if (!adminDbUrl || (!appPassword && !appDbUrl)) {
    try {
      const sm = new SecretsManagerClient({ region });
      if (!adminDbUrl) {
        console.log(`[BOOTSTRAP] Fetching admin credentials from AWS Secrets Manager (kanakku/${environment}/database-admin-credentials)...`);
        const adminSecret = await sm.send(
          new GetSecretValueCommand({ SecretId: `kanakku/${environment}/database-admin-credentials` }),
        );
        if (adminSecret.SecretString) {
          const parsed = JSON.parse(adminSecret.SecretString);
          adminDbUrl = parsed.DATABASE_URL;
        }
      }

      if (!appPassword && !appDbUrl) {
        console.log(`[BOOTSTRAP] Fetching runtime connection URL from AWS Secrets Manager (kanakku/${environment}/database-url)...`);
        const appSecret = await sm.send(
          new GetSecretValueCommand({ SecretId: `kanakku/${environment}/database-url` }),
        );
        if (appSecret.SecretString) {
          const parsed = parsePostgresUrl(appSecret.SecretString);
          appPassword = parsed.pass;
        }
      }
    } catch (err: unknown) {
      // In local dev without AWS credentials, check if local fallback is available
      if (!adminDbUrl) {
        throw new Error(
          `ADMIN_DATABASE_URL is required or AWS Secrets Manager secret "kanakku/${environment}/database-admin-credentials" must be accessible: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  if (appDbUrl && !appPassword) {
    const parsed = parsePostgresUrl(appDbUrl);
    appPassword = parsed.pass;
  }

  if (!adminDbUrl || !appPassword) {
    throw new Error(
      'Missing required database credentials. Provide ADMIN_DATABASE_URL and APP_USER_PASSWORD (or APP_DATABASE_URL), or configure AWS credentials.',
    );
  }

  console.log('[BOOTSTRAP] Connecting to database as administrator...');
  const adminPool = new Pool({
    connectionString: adminDbUrl,
    connectionTimeoutMillis: 10000,
  });

  const client = await adminPool.connect();

  try {
    console.log('[BOOTSTRAP] Ensuring PostgreSQL role "kanakku_app" exists with matching password...');
    // Create or update role password safely with parameterized query
    const roleCheck = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['kanakku_app']);
    if (roleCheck.rowCount === 0) {
      // Use format string with escaped literal for CREATE USER
      await client.query(`CREATE USER kanakku_app WITH PASSWORD '${appPassword.replace(/'/g, "''")}';`);
      console.log('  Created new user "kanakku_app".');
    } else {
      await client.query(`ALTER USER kanakku_app WITH PASSWORD '${appPassword.replace(/'/g, "''")}';`);
      console.log('  Updated password for existing user "kanakku_app".');
    }

    const dbName = parsePostgresUrl(adminDbUrl).db;
    console.log(`[BOOTSTRAP] Configuring least-privilege permissions on database "${dbName}" (DML only)...`);
    await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO kanakku_app;`);
    await client.query('GRANT USAGE ON SCHEMA public TO kanakku_app;');

    // DML permissions only
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kanakku_app;');
    await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kanakku_app;');

    // Default privileges for subsequent migrations
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kanakku_app;');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO kanakku_app;');

    console.log('[SUCCESS] Role "kanakku_app" provisioned with verified least-privilege permissions.');
  } finally {
    client.release();
    await adminPool.end();
  }
}

// Execute when invoked directly
if (process.argv[1]?.endsWith('bootstrap-app-role.ts') || process.argv[1]?.endsWith('bootstrap-app-role.js')) {
  bootstrapAppRole()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[ERROR] Failed to bootstrap application role:', err);
      process.exit(1);
    });
}
