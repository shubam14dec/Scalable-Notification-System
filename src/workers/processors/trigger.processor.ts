import { UnrecoverableError, type Job } from 'bullmq';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { getQueue, pipelineBacklog, QUEUE } from '../../shared/queues';
import {
  getEvent,
  pageSubscribers,
  setEventRecipientCount,
  setEventStatus,
  type EventRow,
  type RecipientInput,
  type Subscriber,
} from '../../db/repositories';
import { logExec } from '../../core/execution-log';
import { traceCarrier, withSpan, type TraceCarrier } from '../../shared/tracing';

const CHUNK_SIZE = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Stage 1: split one accepted event into subscriber batches. Splitting is
 * cheap and keeps fan-out jobs bounded — a 100k-recipient campaign becomes
 * 1000 independent fan-out jobs that spread across every fan-out worker
 * instead of one giant job pinning a single worker.
 */
export async function processTrigger(
  job: Job<{ eventId: string; replay?: string; _trace?: TraceCarrier }>,
): Promise<void> {
  const event = await getEvent(job.data.eventId);
  if (!event) {
    throw new UnrecoverableError(`event ${job.data.eventId} not found`);
  }

  if (event.is_broadcast) {
    await withSpan(
      'broadcast.fanout',
      { 'notif.transaction_id': event.transaction_id },
      () => broadcastFanout(event, job.data.replay),
      job.data._trace,
    );
    return;
  }

  await withSpan(
    'workflow.fanout',
    {
      'notif.transaction_id': event.transaction_id,
      'notif.recipients': event.recipients.length,
    },
    async () => {
      await setEventStatus(event.id, 'processing');

      const batches = chunk(event.recipients as RecipientInput[], CHUNK_SIZE);
      // jobId dedupes retried chunk adds (no ':' — BullMQ reserves it as its
      // Redis key delimiter). A reconciler replay carries a nonce so its
      // chunks get fresh jobIds — otherwise BullMQ would silently ignore
      // them while the original completed jobs are still retained.
      const replaySuffix = job.data.replay ? `-${job.data.replay}` : '';
      await getQueue(QUEUE.FANOUT).addBulk(
        batches.map((recipients, i) => ({
          name: `${event.transaction_id}:${i}`,
          data: { eventId: event.id, recipients, _trace: traceCarrier() },
          opts: { attempts: 3, jobId: `${event.id}-chunk-${i}${replaySuffix}` },
        })),
      );

      logExec({
        tenantId: event.tenant_id,
        transactionId: event.transaction_id,
        level: 'info',
        detail: `fan-out started: ${event.recipients.length} recipients in ${batches.length} batch(es)`,
      });
    },
    job.data._trace,
  );
}

function toRecipient(s: Subscriber): RecipientInput {
  return {
    subscriberId: s.external_id,
    email: s.email ?? undefined,
    phone: s.phone ?? undefined,
    pushToken: s.push_token ?? undefined,
  };
}

/**
 * Broadcast fan-out: stream the tenant's ENTIRE subscriber table into the
 * pipeline without ever holding it in memory or flooding Redis.
 *
 *  - Keyset pagination: constant-cost pages regardless of table size.
 *  - Backpressure: paging pauses while fanout + this tier's delivery queues
 *    hold more than FANOUT_HIGH_WATERMARK waiting jobs, and resumes as
 *    workers drain them — Redis memory stays flat for a 10M blast.
 *  - Crash-safe: if this job dies mid-page and is re-delivered, it repages
 *    from the start; message-level idempotency turns already-fanned pages
 *    into no-ops.
 */
async function broadcastFanout(event: EventRow, replay?: string): Promise<void> {
  await setEventStatus(event.id, 'processing');
  const replaySuffix = replay ? `-${replay}` : '';

  let cursor: string | null = null;
  let total = 0;
  let chunkIdx = 0;

  for (;;) {
    let backlog = await pipelineBacklog(event.priority);
    while (backlog > env.fanoutHighWatermark) {
      logger.info(
        { backlog, watermark: env.fanoutHighWatermark, transactionId: event.transaction_id },
        'broadcast paused: backlog above watermark',
      );
      await new Promise((r) => setTimeout(r, 2000));
      backlog = await pipelineBacklog(event.priority);
    }

    const subscribers = await pageSubscribers(event.tenant_id, cursor, env.broadcastBatchSize);
    if (subscribers.length === 0) break;
    cursor = subscribers[subscribers.length - 1].id;

    await getQueue(QUEUE.FANOUT).add(
      `${event.transaction_id}:${chunkIdx}`,
      { eventId: event.id, recipients: subscribers.map(toRecipient), _trace: traceCarrier() },
      { attempts: 3, jobId: `${event.id}-chunk-${chunkIdx}${replaySuffix}` },
    );
    total += subscribers.length;
    chunkIdx += 1;
  }

  await setEventRecipientCount(event.id, total);
  logExec({
    tenantId: event.tenant_id,
    transactionId: event.transaction_id,
    level: 'info',
    detail: `broadcast fanned out to ${total} subscribers in ${chunkIdx} batch(es)`,
  });
}
