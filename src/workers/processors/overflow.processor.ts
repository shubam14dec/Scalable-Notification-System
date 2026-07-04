import type { Job } from 'bullmq';
import { redis } from '../../shared/redis';
import { getQueue, QUEUE } from '../../shared/queues';
import { rateLimitWindowKey } from '../../api/rate-limit';
import { getTenantById, type Tenant } from '../../db/repositories';
import { getEvent } from '../../db/repositories';
import { logExec } from '../../core/execution-log';

/**
 * Trickle re-injection of diverted bursts. Each tick this worker checks the
 * tenant's CURRENT-second budget (the same Redis window the API uses):
 *
 *  - budget available -> take a slot, re-inject the event into `trigger`
 *  - still saturated  -> give the slot back and re-defer itself 2s
 *
 * The worker's own queue limiter (OVERFLOW_REPLAY_PER_SEC) additionally caps
 * total replay pressure, so even many bursting tenants together can't spike
 * the main pipeline. After MAX_DEFERRALS the event is pushed through anyway
 * — an overflow burst degrades to "later", never to "lost".
 */
const MAX_DEFERRALS = 150; // ~5 minutes at 2s per deferral

const tenantCache = new Map<string, { tenant: Tenant | null; expiresAt: number }>();
async function cachedTenant(tenantId: string): Promise<Tenant | null> {
  const hit = tenantCache.get(tenantId);
  if (hit && hit.expiresAt > Date.now()) return hit.tenant;
  const tenant = await getTenantById(tenantId);
  tenantCache.set(tenantId, { tenant, expiresAt: Date.now() + 60_000 });
  return tenant;
}

export async function processOverflow(
  job: Job<{
    eventId: string;
    tenantId: string;
    deferrals?: number;
    _trace?: Record<string, string>;
  }>,
): Promise<void> {
  const { eventId, tenantId } = job.data;
  const deferrals = job.data.deferrals ?? 0;

  const tenant = await cachedTenant(tenantId);
  const limit = tenant?.rate_limit_per_sec ?? 50;

  const windowKey = rateLimitWindowKey(tenantId);
  const count = await redis.incr(windowKey);
  if (count === 1) await redis.expire(windowKey, 2);

  if (count > limit && deferrals < MAX_DEFERRALS) {
    await redis.decr(windowKey); // give the slot back
    await getQueue(QUEUE.OVERFLOW).add(
      job.name,
      { eventId, tenantId, deferrals: deferrals + 1, _trace: job.data._trace },
      { attempts: 3, delay: 2000, jobId: `${eventId}-o${deferrals + 1}` },
    );
    return;
  }

  await getQueue(QUEUE.TRIGGER).add(
    job.name,
    { eventId, _trace: job.data._trace },
    { attempts: 3 },
  );

  const event = await getEvent(eventId);
  logExec({
    tenantId,
    transactionId: event?.transaction_id,
    level: 'info',
    detail: `re-injected from overflow after ${deferrals} deferral(s)`,
  });
}
