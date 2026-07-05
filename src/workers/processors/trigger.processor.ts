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
import { getTopicByKey, pageTopicMembers } from '../../db/topics.repo';
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

      const direct = event.recipients.filter(
        (r): r is RecipientInput => 'subscriberId' in r,
      );
      const topicKeys = event.recipients
        .filter((r): r is { topic: string } => 'topic' in r)
        .map((r) => r.topic);

      const batches = chunk(direct, CHUNK_SIZE);
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

      // Topic recipients: stream each topic's membership through fan-out
      // with the same paging + backpressure as broadcast. Members who were
      // also direct recipients (or in multiple topics) are deduped by the
      // message unique key — nobody gets doubles.
      let topicTotal = 0;
      for (const [t, key] of topicKeys.entries()) {
        const topic = await getTopicByKey(event.tenant_id, key);
        if (!topic) continue; // deleted between accept and processing
        topicTotal += await streamMembers(
          event,
          (cursor, limit) => pageTopicMembers(topic.id, cursor, limit),
          `t${t}`,
          replaySuffix,
        );
      }

      if (topicKeys.length > 0) {
        await setEventRecipientCount(event.id, direct.length + topicTotal);
      }

      logExec({
        tenantId: event.tenant_id,
        transactionId: event.transaction_id,
        level: 'info',
        detail:
          `fan-out started: ${direct.length} direct recipient(s)` +
          (topicKeys.length > 0
            ? ` + ${topicTotal} via topic(s) ${topicKeys.join(', ')}`
            : '') +
          ` in ${batches.length + Math.ceil(topicTotal / env.broadcastBatchSize)} batch(es)`,
      });
    },
    job.data._trace,
  );
}

/** Pause while fanout + this tier's delivery queues are above the watermark. */
async function waitForCapacity(event: EventRow): Promise<void> {
  let backlog = await pipelineBacklog(event.priority);
  while (backlog > env.fanoutHighWatermark) {
    logger.info(
      { backlog, watermark: env.fanoutHighWatermark, transactionId: event.transaction_id },
      'fan-out paused: backlog above watermark',
    );
    await new Promise((r) => setTimeout(r, 2000));
    backlog = await pipelineBacklog(event.priority);
  }
}

/**
 * Stream a subscriber source (topic membership, or the whole environment
 * for broadcast) into fan-out batches under backpressure. Returns the
 * number of members streamed.
 */
async function streamMembers(
  event: EventRow,
  page: (cursor: string | null, limit: number) => Promise<Subscriber[]>,
  jobTag: string,
  replaySuffix: string,
): Promise<number> {
  let cursor: string | null = null;
  let total = 0;
  let chunkIdx = 0;

  for (;;) {
    await waitForCapacity(event);
    const subscribers = await page(cursor, env.broadcastBatchSize);
    if (subscribers.length === 0) break;
    cursor = subscribers[subscribers.length - 1].id;

    await getQueue(QUEUE.FANOUT).add(
      `${event.transaction_id}:${jobTag}:${chunkIdx}`,
      { eventId: event.id, recipients: subscribers.map(toRecipient), _trace: traceCarrier() },
      { attempts: 3, jobId: `${event.id}-${jobTag}-chunk-${chunkIdx}${replaySuffix}` },
    );
    total += subscribers.length;
    chunkIdx += 1;
  }
  return total;
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
  const total = await streamMembers(
    event,
    (cursor, limit) => pageSubscribers(event.tenant_id, cursor, limit),
    'b',
    replay ? `-${replay}` : '',
  );
  await setEventRecipientCount(event.id, total);
  logExec({
    tenantId: event.tenant_id,
    transactionId: event.transaction_id,
    level: 'info',
    detail: `broadcast fanned out to ${total} subscribers`,
  });
}
