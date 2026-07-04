/**
 * DR reconciler (see docs/MULTI-REGION.md): queues are disposable because
 * Postgres is the outbox — this script rebuilds queue state from it.
 *
 * Two passes:
 *  1. Mark events 'completed' when every message reached a terminal state.
 *  2. Re-enqueue events still 'accepted'/'processing' after a grace period
 *     (lost jobs — e.g. Redis was wiped or a region failed over). Safe to
 *     run any time: every pipeline stage is idempotent, so replaying a
 *     healthy event changes nothing and never double-sends.
 *
 *   npm run reconcile                   # grace 5 min, limit 500
 *   npm run reconcile -- 60 20          # grace 60s, limit 20
 */
import { pool } from '../src/db/pool';
import { getQueue, QUEUE, closeQueues } from '../src/shared/queues';
import { redis } from '../src/shared/redis';
import { logger } from '../src/shared/logger';

const TERMINAL = ['sent', 'delivered', 'failed', 'skipped', 'bounced', 'complaint', 'merged'];

async function main() {
  const graceSeconds = Number.parseInt(process.argv[2] ?? '300', 10);
  const limit = Number.parseInt(process.argv[3] ?? '500', 10);

  // Pass 1: settle finished events.
  const { rowCount: completed } = await pool.query(
    `update events e set status = 'completed'
     where e.status in ('accepted', 'processing')
       and exists (select 1 from messages m where m.event_id = e.id)
       and not exists (
         select 1 from messages m
         where m.event_id = e.id and m.status != all($1::text[])
       )`,
    [TERMINAL],
  );
  logger.info({ completed }, 'events settled as completed');

  // Pass 2: replay stuck events (accepted but no delivery ever concluded).
  const { rows: stuck } = await pool.query(
    `select id, tenant_id, transaction_id from events
     where status in ('accepted', 'processing')
       and created_at < now() - make_interval(secs => $1)
     order by created_at
     limit $2`,
    [graceSeconds, limit],
  );

  // The nonce gives replayed fan-out chunks fresh jobIds (see trigger
  // processor); message-level idempotency still prevents double-sends.
  const replay = Date.now().toString(36);
  for (const event of stuck) {
    await getQueue(QUEUE.TRIGGER).add(
      event.transaction_id,
      { eventId: event.id, tenantId: event.tenant_id, replay },
      { attempts: 3 },
    );
  }
  logger.info({ replayed: stuck.length, graceSeconds }, 'stuck events re-enqueued');

  await closeQueues();
  await redis.quit();
  await pool.end();
}

main().catch((err) => {
  logger.error(err, 'reconcile failed');
  process.exit(1);
});
