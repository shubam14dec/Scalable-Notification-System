import { redis } from '../shared/redis';
import { logger } from '../shared/logger';
import { logExec } from '../core/execution-log';
import { inAppPubSubChannel } from '../providers/inapp';
import { sweepInactiveConversations } from '../db/conversations.repo';
import { purgeDeadLinkTokens } from '../db/identities.repo';

/**
 * The inactivity backstop: conversations idle past their agent's
 * auto_resolve_hours flip to resolved — a timer and a status flip, no
 * brain, no channel sends. Runs on the settle-sweep pattern (plain
 * interval, idempotent SQL, concurrent worker replicas harmless).
 *
 * Scale shape (the 10-20M rule): each iteration is ONE set-based
 * statement resolving a whole batch; a 5M-conversation backlog drains in
 * ~1000 batches across a tick or two instead of ~87 days of row-at-a-time
 * work. The drain loop is time-budgeted so a huge backlog can never pin
 * the worker past its tick.
 */

// 60s tick so a 1-minute knob behaves like one; an idle tick is a single
// indexed query (partial index, zero matches), cheaper than the 30s
// settle sweep next door.
export const SWEEP_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 5000;
const TICK_BUDGET_MS = 55_000;

export async function runInactivitySweep(): Promise<number> {
  const started = Date.now();
  let total = 0;

  for (;;) {
    const swept = await sweepInactiveConversations(BATCH_SIZE);
    if (swept.length === 0) break;
    total += swept.length;

    // Live widgets flip to resolved; one pipelined round trip per batch.
    // Non-inapp channels get nothing — an hours-idle chat has no spinner
    // to clear, and we send no unsolicited "closed" message (v1).
    const pipe = redis.pipeline();
    for (const row of swept) {
      logExec({
        tenantId: row.tenant_id,
        transactionId: `conv-${row.id}`,
        level: 'info',
        detail: `auto-resolved after ${row.auto_resolve_minutes}m of inactivity (agent=${row.agent_identifier})`,
      });
      if (row.channel !== 'inapp') continue;
      pipe.publish(
        inAppPubSubChannel(row.tenant_id, row.subscriber_external_id),
        JSON.stringify({
          type: 'conversation.resolved',
          conversation: {
            id: row.id,
            agentIdentifier: row.agent_identifier,
            agentName: row.agent_name,
          },
        }),
      );
    }
    await pipe.exec();

    if (swept.length < BATCH_SIZE) break; // drained
    if (Date.now() - started > TICK_BUDGET_MS) {
      logger.warn({ total }, 'inactivity sweep hit its tick budget; resuming next tick');
      break;
    }
  }

  if (total > 0) logger.info({ resolved: total }, 'inactivity sweep resolved stale conversations');

  // Piggybacked hygiene: expired link tokens (7-day grace) — one indexed
  // delete, no new timer.
  await purgeDeadLinkTokens().catch((err) =>
    logger.warn({ err: (err as Error).message }, 'link token purge failed'),
  );

  return total;
}
