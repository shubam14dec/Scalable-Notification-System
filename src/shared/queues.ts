import { Queue, type JobsOptions } from 'bullmq';
import { redis } from './redis';

export const CHANNELS = ['email', 'sms', 'push', 'inapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Priority tiers (Razorpay's P0/P1/P2 pattern), implemented as physically
 * separate queues per channel so bulk traffic can never starve transactional
 * traffic — each tier has its own dedicated worker pool.
 *
 *  p0 = business-critical / transactional (OTP, payment receipts)
 *  p1 = default
 *  p2 = bulk / marketing / digests
 */
export const PRIORITIES = ['p0', 'p1', 'p2'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const QUEUE = {
  /** Raw accepted trigger events (API -> pipeline). */
  TRIGGER: 'trigger',
  /** Subscriber batches to expand into per-channel messages. */
  FANOUT: 'fanout',
  /** Provider delivery-status callbacks (delivered/bounced/...). */
  STATUS: 'status-events',
  /**
   * Tenant burst isolation (Razorpay pattern): triggers above a tenant's
   * rate limit land here and are trickled back into `trigger` as budget
   * frees up, so one tenant's burst can't clog the main pipeline.
   */
  OVERFLOW: 'overflow',
  /** Jobs that exhausted retries or hit a permanent error, kept for replay. */
  DLQ: 'dead-letter',
} as const;

export function deliveryQueueName(channel: Channel, priority: Priority): string {
  return `deliver.${channel}.${priority}`;
}

export const ALL_QUEUE_NAMES: string[] = [
  QUEUE.TRIGGER,
  QUEUE.FANOUT,
  QUEUE.STATUS,
  QUEUE.OVERFLOW,
  QUEUE.DLQ,
  ...CHANNELS.flatMap((c) => PRIORITIES.map((p) => deliveryQueueName(c, p))),
];

/**
 * Retry policy: exponential backoff with jitter, applied via the worker's
 * custom backoffStrategy (see workers/index.ts). Failed jobs are kept so the
 * DLQ handler can inspect them before they are trimmed.
 */
export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export function backoffWithJitter(attemptsMade: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attemptsMade);
  return base + Math.floor(Math.random() * 500);
}

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis, defaultJobOptions: DEFAULT_JOB_OPTS });
    queues.set(name, q);
  }
  return q;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}

/**
 * Waiting jobs ahead of one priority tier: fanout backlog plus that tier's
 * delivery queues. Broadcast paging pauses on this (backpressure) so Redis
 * holds a bounded window of jobs regardless of blast size.
 */
export async function pipelineBacklog(priority: Priority): Promise<number> {
  let total = 0;
  const names = [QUEUE.FANOUT, ...CHANNELS.map((c) => deliveryQueueName(c, priority))];
  for (const name of names) {
    const counts = await getQueue(name).getJobCounts('waiting', 'prioritized', 'delayed');
    total += (counts.waiting ?? 0) + (counts.prioritized ?? 0);
  }
  return total;
}

/** Waiting/active/delayed/failed counts for every queue — the #1 scaling signal. */
export async function queueDepths() {
  const out: Record<string, Record<string, number>> = {};
  for (const name of ALL_QUEUE_NAMES) {
    out[name] = await getQueue(name).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'prioritized',
    );
  }
  return out;
}
