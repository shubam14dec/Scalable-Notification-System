import { randomUUID } from 'node:crypto';
import { redis } from '../shared/redis';
import { getQueue, QUEUE, type Priority } from '../shared/queues';
import {
  getWorkflow,
  insertEvent,
  type TriggerRecipient,
} from '../db/repositories';
import { logExec } from './execution-log';

const DEDUPE_TTL_SECONDS = 86_400;

/**
 * Server-side workflow trigger — the same accept path as POST
 * /v1/events/trigger minus HTTP auth and tenant rate limiting (callers are
 * already inside the trust boundary: today, the conversation worker acting
 * on a bridge's `trigger` signal). Same dedupe (Redis fast path + events
 * unique constraint), same queue hop, same audit trail.
 */
export async function internalTrigger(args: {
  tenantId: string;
  workflowKey: string;
  to: TriggerRecipient[];
  payload?: Record<string, unknown>;
  priority?: Priority;
  transactionId?: string;
  /** Where the trigger came from, for the execution log. */
  source: string;
}): Promise<
  | { ok: true; transactionId: string; duplicate: boolean }
  | { ok: false; error: string }
> {
  const workflow = await getWorkflow(args.tenantId, args.workflowKey);
  if (!workflow) return { ok: false, error: `unknown workflow "${args.workflowKey}"` };
  if (args.to.length === 0) return { ok: false, error: 'no recipients' };

  const transactionId = args.transactionId ?? randomUUID();
  const fresh = await redis.set(
    `txn:${args.tenantId}:${transactionId}`,
    '1',
    'EX',
    DEDUPE_TTL_SECONDS,
    'NX',
  );
  if (fresh === null) return { ok: true, transactionId, duplicate: true };

  const event = await insertEvent({
    tenantId: args.tenantId,
    transactionId,
    workflowKey: args.workflowKey,
    priority: args.priority ?? 'p1',
    payload: args.payload ?? {},
    recipients: args.to,
  });
  if (!event) return { ok: true, transactionId, duplicate: true };

  await getQueue(QUEUE.TRIGGER).add(
    transactionId,
    { eventId: event.id, tenantId: args.tenantId },
    { attempts: 3 },
  );

  logExec({
    tenantId: args.tenantId,
    transactionId,
    level: 'info',
    detail: `event accepted (${args.source}): workflow=${args.workflowKey} recipients=${args.to.length}`,
  });

  return { ok: true, transactionId, duplicate: false };
}
