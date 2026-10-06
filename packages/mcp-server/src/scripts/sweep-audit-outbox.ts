/**
 * Standalone Audit Anchor Outbox Sweep Script.
 * Sweeps pending and failed audit anchor outbox items using atomic SKIP LOCKED.
 *
 * Usage:
 *   pnpm --filter @kanakku/mcp-server outbox:sweep
 *   pnpm --filter @kanakku/mcp-server outbox:sweep --continuous
 */
import { getDatabase, closeDatabase } from '@kanakku/db';
import { processPendingAuditOutbox, startAuditOutboxWorker } from '../audit/outbox.js';

async function main() {
  const db = getDatabase();
  const isContinuous = process.argv.includes('--continuous');

  if (isContinuous) {
    console.log('[AuditOutboxWorker] Starting continuous worker (poll interval: 30s)...');
    const worker = startAuditOutboxWorker(db, {
      intervalMs: 30_000,
      onSweep: (res) => {
        if (res.total > 0) {
          console.log(`[AuditOutboxWorker] Swept ${res.total} items: ${res.succeeded} anchored, ${res.failed} failed`);
        }
      },
      onError: (err) => {
        console.error('[AuditOutboxWorker] Error during sweep:', err);
      },
    });

    const shutdown = async () => {
      console.log('[AuditOutboxWorker] Shutting down...');
      worker.stop();
      await closeDatabase();
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
  } else {
    console.log('[AuditOutbox] Running one-shot sweep of pending/failed audit anchors...');
    const result = await processPendingAuditOutbox(db);
    console.log(`[AuditOutbox] Sweep complete. Processed: ${result.total}, Succeeded: ${result.succeeded}, Failed: ${result.failed}`);
    await closeDatabase();
    process.exit(result.failed > 0 ? 1 : 0);
  }
}

void main();
