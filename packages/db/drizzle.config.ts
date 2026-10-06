import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env['DATABASE_URL'] ||
      'postgres://kanakku_user:kanakku_dev_password@localhost:5433/kanakku_db',
  },
});
