import { fileURLToPath } from 'node:url';
import { createHttpServer } from './server.js';
import { getDatabase } from '@kanakku/db';

export * from './server.js';
export * from './auth/index.js';
export * from './audit/index.js';
export * from './tools/index.js';
export * from './resources/index.js';
export * from './prompts/index.js';
export * from './apps/index.js';

// If executed directly from CLI
let isDirectCli = false;
try {
  if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
    const currentFilePath = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (argv1) {
      if (argv1.endsWith('index.ts') || argv1.endsWith('index.js') || currentFilePath === argv1) {
        isDirectCli = true;
      }
    }
  }
} catch {
  isDirectCli = false;
}

if (isDirectCli) {
  const port = parseInt(process.env['PORT'] ?? '3001', 10);
  const db = getDatabase();
  const server = createHttpServer({ db, port });

  // Start background audit anchor outbox worker (ADR-005)
  // Sweeps pending/failed audit anchors on boot and periodically every 30s
  let outboxWorker: ReturnType<typeof import('./audit/outbox.js').startAuditOutboxWorker> | null =
    null;
  if (process.env['AUDIT_OUTBOX_WORKER_ENABLED'] !== 'false') {
    const pollIntervalMs = parseInt(process.env['AUDIT_OUTBOX_POLL_INTERVAL_MS'] ?? '30000', 10);
    const { startAuditOutboxWorker } = await import('./audit/outbox.js');
    outboxWorker = startAuditOutboxWorker(db, {
      intervalMs: pollIntervalMs,
      onSweep: (res) => {
        if (res.total > 0) {
          console.log(
            `[AuditOutboxWorker] Swept ${res.total} items: ${res.succeeded} anchored, ${res.failed} failed`,
          );
        }
      },
      onError: (err) => {
        console.error('[AuditOutboxWorker] Error during outbox sweep:', err);
      },
    });
  }

  const shutdown = async () => {
    if (outboxWorker) {
      outboxWorker.stop();
    }
    await server.close();
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  server.listen(port).then((actualPort) => {
    console.log(`
=================================================================
  KANAKKU MCP SERVER (Spec 2025-11-25+ Streamable HTTP)
=================================================================
  Endpoint:         http://localhost:${actualPort}/mcp
  Health Check:     http://localhost:${actualPort}/health
  Protocol:         Streamable HTTP (MCP 2025-11-25)
  Registered Tools: 13 canonical financial tools
  Resources:        5 tenant-scoped resources
  Prompts:          3 structured workflow prompts
  Audit Outbox:     ${outboxWorker ? 'Active (Background Worker Loop Enabled)' : 'Disabled'}
=================================================================
`);
  });
}
