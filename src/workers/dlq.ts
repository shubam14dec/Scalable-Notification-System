import { UnrecoverableError, type Job, type Worker } from 'bullmq';
import { getQueue, QUEUE } from '../shared/queues';
import { logger } from '../shared/logger';
import { logExec } from '../core/execution-log';
import { emitTenantEvent } from '../core/tenant-events';

/**
 * Dead-letter wiring: when a job exhausts its retries (or fails permanently),
 * park a copy in the `dead-letter` queue with enough context to inspect and
 * replay it (scripts/replay-dlq.ts). Nothing is silently dropped.
 */
export function wireDlq(
  worker: Worker,
  queueName: string,
  onDead?: (job: Job, err: Error) => Promise<void>,
): void {
  worker.on('failed', (job, err) => {
    void (async () => {
      if (!job) return;
      const maxAttempts = job.opts.attempts ?? 1;
      const exhausted = job.attemptsMade >= maxAttempts;
      const permanent = err instanceof UnrecoverableError || err.name === 'UnrecoverableError';
      if (!exhausted && !permanent) return;

      try {
        await getQueue(QUEUE.DLQ).add(
          'dead',
          {
            originQueue: queueName,
            name: job.name,
            data: job.data,
            failedReason: err.message,
            attemptsMade: job.attemptsMade,
            diedAt: new Date().toISOString(),
          },
          { attempts: 1, removeOnComplete: false, removeOnFail: false },
        );
        logExec({
          level: 'error',
          detail: `dead-lettered from ${queueName} after ${job.attemptsMade} attempt(s): ${err.message}`,
          raw: { name: job.name, data: job.data },
        });
        // Phase 25 (D6b): a job hit the dead-letter path — rare + urgent, a true
        // event. Best-effort tenant attribution from job data; if a path carries
        // no tenantId we SKIP (no platform channel in v1 — out of scope).
        const dlqTenantId = (job.data as { tenantId?: unknown })?.tenantId;
        if (typeof dlqTenantId === 'string' && dlqTenantId) {
          void emitTenantEvent(dlqTenantId, 'queue.deadletter', job.id ?? job.name);
        }
        if (onDead) await onDead(job, err);
      } catch (dlqErr) {
        logger.error({ dlqErr, queueName, jobId: job.id }, 'failed to dead-letter job');
      }
    })();
  });

  worker.on('error', (err) => logger.error({ err }, `worker error on ${queueName}`));
}
