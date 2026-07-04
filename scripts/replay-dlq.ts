import { getQueue, QUEUE, closeQueues } from '../src/shared/queues';
import { redis } from '../src/shared/redis';
import { logger } from '../src/shared/logger';

/**
 * Re-injects dead-lettered jobs into their origin queues at a controlled
 * pace (10/s) so a replay can never re-create the surge that killed them.
 *
 *   npm run dlq:replay            # replay up to 1000 jobs
 *   npm run dlq:replay -- 50      # replay up to 50
 */
async function main() {
  const limit = Number.parseInt(process.argv[2] ?? '1000', 10);
  const dlq = getQueue(QUEUE.DLQ);

  const jobs = await dlq.getJobs(['waiting', 'delayed', 'failed'], 0, limit - 1);
  logger.info({ found: jobs.length }, 'dead-lettered jobs to replay');

  let replayed = 0;
  for (const job of jobs) {
    const { originQueue, name, data, failedReason } = job.data as {
      originQueue: string;
      name: string;
      data: unknown;
      failedReason?: string;
    };
    await getQueue(originQueue).add(name, data, { attempts: 5 });
    await job.remove();
    replayed += 1;
    logger.info({ originQueue, name, failedReason }, `replayed ${replayed}/${jobs.length}`);
    await new Promise((r) => setTimeout(r, 100)); // ~10 jobs/sec
  }

  logger.info({ replayed }, 'done');
  await closeQueues();
  await redis.quit();
}

main().catch((err) => {
  logger.error(err, 'dlq replay failed');
  process.exit(1);
});
