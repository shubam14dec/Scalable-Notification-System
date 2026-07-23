import { redis } from '../shared/redis';
import { logger } from '../shared/logger';
import { logExec } from '../core/execution-log';
import { inAppPubSubChannel } from '../providers/inapp';
import { sweepInactiveConversations } from '../db/conversations.repo';
import { purgeDeadLinkTokens } from '../db/identities.repo';
import { expirePendingToolCalls } from '../db/agent-tools.repo';
import { getQueue, QUEUE } from '../shared/queues';

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

    // Phase 23 (D7): managed conversations that auto-resolved get summarized +
    // embedded off the hot path. Bulk-enqueue (the 10-20M rule: never a per-row
    // round trip); jobId = summarize-<convId> is idempotent, and the job itself
    // self-filters trivial (<2-turn) conversations.
    const managedRows = swept.filter((r) => r.agent_runtime === 'managed');
    if (managedRows.length > 0) {
      await getQueue(QUEUE.KNOWLEDGE).addBulk(
        managedRows.map((r) => ({
          name: `summarize-${r.id}`,
          data: { kind: 'summarize', tenantId: r.tenant_id, conversationId: r.id },
          opts: { jobId: `summarize-${r.id}`, attempts: 5 },
        })),
      );
    }

    // Bridge agents also get a resolved lifecycle event (managed agents have
    // no bridge to notify). One bulk enqueue per batch; the jobId keys on the
    // row's idle epoch so a re-swept row can't double-fire the event.
    const bridgeRows = swept.filter((r) => r.agent_runtime === 'bridge' && r.agent_bridge_url);
    if (bridgeRows.length > 0) {
      await getQueue(QUEUE.CONVERSATION).addBulk(
        bridgeRows.map((r) => ({
          name: `resolved-${r.id}`,
          data: {
            kind: 'resolved',
            tenantId: r.tenant_id,
            conversationId: r.id,
            resolvedBy: 'sweep',
          },
          opts: { jobId: `conv-resolved-${r.id}-${r.idle_epoch}`, attempts: 5, priority: 10 },
        })),
      );
    }

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

  // Piggybacked: approval-gated tool calls past their 24h deadline flip to
  // 'expired' (set-based, capped) and each enqueues one tool-decision job — the
  // decision handler records the expiry outcome and runs the follow-up turn.
  // The jobId is the call id, so a re-swept row (expiry is idempotent via the
  // status guard) can't double-enqueue.
  try {
    const expired = await expirePendingToolCalls(500);
    if (expired.length > 0) {
      await getQueue(QUEUE.CONVERSATION).addBulk(
        expired.map((c) => ({
          name: `tool-decision-${c.id}`,
          data: {
            kind: 'tool-decision',
            tenantId: c.tenant_id,
            conversationId: c.conversation_id,
            toolCallId: c.id,
          },
          opts: { jobId: `tool-decision-${c.id}`, attempts: 5 },
        })),
      );
      logger.info({ expired: expired.length }, 'expired pending tool approvals');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'tool-call expiry sweep failed');
  }

  return total;
}
