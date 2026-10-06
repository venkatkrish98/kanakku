import { createHmac } from 'node:crypto';
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';
import type { KanakkuDatabase } from '@kanakku/db';
import { verifyAuditChain } from './index.js';

export interface AuditAnchorReceipt {
  businessId: string;
  sequenceNumber: string;
  headHash: string;
  anchoredAt: string;
  sinkType: 'cloudwatch_logs' | 'memory' | 'stdout';
  sinkIdentifier: string;
  receiptSignature: string;
}

export interface AuditAnchorSink {
  anchor(receipt: AuditAnchorReceipt): Promise<void>;
}

/**
 * Authentic Amazon CloudWatch Logs Sink (Phase 7 Production Requirement - ADR-005).
 * Dispatches structured anchor payloads directly to the specified CloudWatch Log Group using PutLogEvents.
 */
export class CloudWatchLogsSink implements AuditAnchorSink {
  private client: CloudWatchLogsClient;
  private logGroupName: string;

  constructor(
    logGroupName: string = process.env['CLOUDWATCH_AUDIT_LOG_GROUP'] ??
      '/kanakku/production/audit-anchors',
    client?: CloudWatchLogsClient,
  ) {
    this.logGroupName = logGroupName;
    this.client =
      client ?? new CloudWatchLogsClient({ region: process.env['AWS_REGION'] ?? 'ap-south-1' });
  }

  async anchor(receipt: AuditAnchorReceipt): Promise<void> {
    const streamName = `audit-stream-${receipt.businessId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`;
    const message = JSON.stringify({
      level: 'AUDIT_ANCHOR',
      businessId: receipt.businessId,
      sequenceNumber: receipt.sequenceNumber,
      headHash: receipt.headHash,
      anchoredAt: receipt.anchoredAt,
      sinkType: receipt.sinkType,
      sinkIdentifier: this.logGroupName,
      signature: receipt.receiptSignature,
    });

    try {
      await this.client.send(
        new CreateLogStreamCommand({
          logGroupName: this.logGroupName,
          logStreamName: streamName,
        }),
      );
    } catch (err: unknown) {
      if (
        !(err instanceof ResourceAlreadyExistsException) &&
        (err as { name?: string })?.name !== 'ResourceAlreadyExistsException'
      ) {
        // In local environments or if log group / stream doesn't exist, log warning or propagate
        if (process.env['NODE_ENV'] === 'production') {
          throw err;
        }
      }
    }

    await this.client.send(
      new PutLogEventsCommand({
        logGroupName: this.logGroupName,
        logStreamName: streamName,
        logEvents: [
          {
            timestamp: Date.now(),
            message,
          },
        ],
      }),
    );
  }
}

/**
 * In-memory sink for testing and local verification.
 */
export class MemoryAnchorSink implements AuditAnchorSink {
  public readonly receipts: AuditAnchorReceipt[] = [];

  async anchor(receipt: AuditAnchorReceipt): Promise<void> {
    this.receipts.push(receipt);
  }
}

/**
 * Formats a default anchor sink based on environment.
 */
export function getDefaultAnchorSink(): AuditAnchorSink {
  if (process.env['NODE_ENV'] === 'production' && process.env['AWS_REGION']) {
    return new CloudWatchLogsSink();
  }
  return new MemoryAnchorSink();
}

/**
 * Anchors the current head of the audit chain for a business to an external append-only sink.
 * Verifies that the internal cryptographic chain is completely valid before publishing.
 * (Phase 7 Production Requirement - ADR-005)
 *
 * NOTE: Explicit secretKey or AUDIT_ANCHOR_SECRET environment variable is mandatory.
 * Hardcoded fallbacks are strictly prohibited to avoid forgeable receipts.
 */
export async function anchorAuditHead(
  businessId: string,
  db: KanakkuDatabase,
  sink: AuditAnchorSink = getDefaultAnchorSink(),
  secretKey?: string,
): Promise<AuditAnchorReceipt> {
  const effectiveSecret = secretKey ?? process.env['AUDIT_ANCHOR_SECRET'];
  if (!effectiveSecret) {
    throw new Error(
      'AUDIT_ANCHOR_SECRET_REQUIRED: Cryptographic audit anchoring requires an explicit secretKey argument or the AUDIT_ANCHOR_SECRET environment variable. Hardcoded fallback secrets are forbidden.',
    );
  }

  const verification = await verifyAuditChain(businessId, db);
  if (!verification.valid || !verification.headHash || verification.headSequence === null) {
    throw new Error(
      `Cannot anchor corrupted or empty audit chain: ${verification.error ?? 'No audit entries found'}`,
    );
  }

  const anchoredAt = new Date().toISOString();
  const sequenceStr = verification.headSequence.toString();

  // Generate deterministic HMAC-SHA256 signature for receipt authenticity
  const signature = createHmac('sha256', effectiveSecret)
    .update(`${businessId}:${sequenceStr}:${verification.headHash}:${anchoredAt}`)
    .digest('hex');

  const receipt: AuditAnchorReceipt = {
    businessId,
    sequenceNumber: sequenceStr,
    headHash: verification.headHash,
    anchoredAt,
    sinkType: 'cloudwatch_logs',
    sinkIdentifier:
      process.env['CLOUDWATCH_AUDIT_LOG_GROUP'] ?? '/kanakku/production/audit-anchors',
    receiptSignature: signature,
  };

  await sink.anchor(receipt);
  return receipt;
}
