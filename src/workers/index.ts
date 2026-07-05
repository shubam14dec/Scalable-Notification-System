import { Worker, type Processor, type WorkerOptions } from 'bullmq';
import { createServer } from 'node:http';
import { env } from '../config/env';
import { register } from '../shared/metrics';
import { initTracing, shutdownTracing } from '../shared/tracing';
import { logger } from '../shared/logger';
import { createRedis, redis } from '../shared/redis';
import {
  CHANNELS,
  PRIORITIES,
  QUEUE,
  deliveryQueueName,
  closeQueues,
  backoffWithJitter,
} from '../shared/queues';
import { pool } from '../db/pool';
import { getMessage, settleCompletedEvents, updateMessage } from '../db/repositories';
import { wireDlq } from './dlq';
import { startLogWriter } from './log-writer';
import { processTrigger } from './processors/trigger.processor';
import { processFanout } from './processors/fanout.processor';
import { processDelivery } from './processors/delivery.processor';
import { processStatus } from './processors/status.processor';
import { processOverflow } from './processors/overflow.processor';

const workers: Worker[] = [];

function makeWorker(
  queueName: string,
  processor: Processor,
  opts: Partial<WorkerOptions> = {},
  onDead?: Parameters<typeof wireDlq>[2],
): Worker {
  const worker = new Worker(queueName, processor, {
    connection: createRedis(),
    settings: {
      backoffStrategy: (attemptsMade: number) => backoffWithJitter(attemptsMade),
    },
    ...opts,
  });
  wireDlq(worker, queueName, onDead);
  workers.push(worker);
  return worker;
}

function main() {
  initTracing('notification-worker');

  // Pipeline stages
  makeWorker(QUEUE.TRIGGER, processTrigger, { concurrency: env.triggerConcurrency });
  makeWorker(QUEUE.FANOUT, processFanout, { concurrency: env.fanoutConcurrency });
  makeWorker(QUEUE.STATUS, processStatus, { concurrency: env.statusConcurrency });

  // Overflow trickle: low concurrency + a global replay cap, so diverted
  // bursts re-enter the pipeline gently no matter how many tenants burst.
  makeWorker(QUEUE.OVERFLOW, processOverflow, {
    concurrency: env.overflowConcurrency,
    limiter: { max: env.overflowReplayPerSec, duration: 1000 },
  });

  // Delivery: one worker per channel x priority queue.
  //  - concurrency by tier: P0 gets the most slots, P2 the fewest, so a bulk
  //    backlog can never occupy transactional capacity (bulkhead).
  //  - limiter paces provider calls per channel; BullMQ enforces it in Redis,
  //    so the cap holds across every worker process on the queue.
  //  - WORKER_TIERS pins a PROCESS to specific tiers (e.g. "p0"), so
  //    transactional delivery gets dedicated CPU/event-loop capacity that a
  //    bulk flood in another process can never saturate.
  const tiers = (process.env.WORKER_TIERS ?? 'p0,p1,p2')
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is (typeof PRIORITIES)[number] =>
      (PRIORITIES as readonly string[]).includes(t),
    );
  for (const channel of CHANNELS) {
    for (const priority of tiers) {
      makeWorker(
        deliveryQueueName(channel, priority),
        processDelivery,
        {
          concurrency: env.deliveryConcurrency[priority],
          limiter: { max: env.sendsPerSec[channel], duration: 1000 },
        },
        async (job) => {
          // Exhausted transient retries: reflect final state on the message.
          const messageId = (job.data as { messageId?: string }).messageId;
          if (!messageId) return;
          const message = await getMessage(messageId);
          if (message && !['failed', 'sent', 'delivered'].includes(message.status)) {
            await updateMessage(messageId, {
              status: 'failed',
              error: 'exhausted retries',
            });
          }
        },
      );
    }
  }

  const stopLogWriter = startLogWriter();

  // Settle finished events to 'completed' every 30s (concurrent runs from
  // multiple worker processes are harmless — same idempotent UPDATE).
  const settleTimer = setInterval(() => {
    settleCompletedEvents()
      .then((n) => n > 0 && logger.info({ settled: n }, 'events settled as completed'))
      .catch((err) => logger.warn({ err }, 'event settle sweep failed'));
  }, 30_000);

  // Per-process Prometheus endpoint (each worker replica exports its own).
  const metricsServer = createServer((req, res) => {
    if (req.url === '/metrics') {
      register
        .metrics()
        .then((body) => {
          res.setHeader('content-type', register.contentType);
          res.end(body);
        })
        .catch((err) => {
          res.writeHead(500).end(String(err));
        });
      return;
    }
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', workers: workers.length }));
      return;
    }
    res.writeHead(404).end();
  });
  metricsServer.listen(env.workerMetricsPort, () =>
    logger.info({ port: env.workerMetricsPort }, 'worker metrics endpoint up'),
  );

  logger.info(
    {
      workers: workers.length,
      tiers,
      deliveryQueues: CHANNELS.length * tiers.length,
      concurrency: env.deliveryConcurrency,
    },
    'worker fleet up',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'workers shutting down (finishing in-flight jobs)');
    clearInterval(settleTimer);
    metricsServer.close();
    await Promise.all(workers.map((w) => w.close()));
    await stopLogWriter(); // final flush of buffered execution logs
    await shutdownTracing();
    await closeQueues();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
