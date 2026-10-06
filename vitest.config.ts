import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './apps/console/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    env: {
      AUDIT_ANCHOR_SECRET: 'test-cryptographic-audit-secret-48-chars-long-secure-key',
    },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/core/src/**/*.ts'],
    },
  },
});
