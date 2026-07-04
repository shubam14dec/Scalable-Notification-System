import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { tenantRateLimit } from '../rate-limit';
import { redis } from '../../shared/redis';
import { getQueue, QUEUE, PRIORITIES } from '../../shared/queues';
import { getWorkflow, insertEvent, getEventByTransaction } from '../../db/repositories';
import { logExec } from '../../core/execution-log';
import { triggersTotal } from '../../shared/metrics';
import { traceCarrier, withSpan } from '../../shared/tracing';

const RecipientSchema = z.object({
  subscriberId: z.string().min(1).max(255),
  email: z.string().email().optional(),
  phone: z.string().max(32).optional(),
  pushToken: z.string().max(4096).optional(),
});

const TriggerSchema = z.object({
  workflowKey: z.string().min(1).max(255),
  to: z.array(RecipientSchema).min(1).max(1000),
  payload: z.record(z.unknown()).default({}),
  priority: z.enum(PRIORITIES).default('p1'),
  transactionId: z.string().min(1).max(255).optional(),
});

const DEDUPE_TTL_SECONDS = 86_400;

export function registerTriggerRoutes(app: FastifyInstance) {
  /**
   * The hot path. Does the absolute minimum — validate, dedupe, persist,
   * enqueue — and returns 202 immediately. Everything else is async.
   */
  app.post(
    '/v1/events/trigger',
    { preHandler: [authenticate, tenantRateLimit] },
    async (req, reply) => {
      const parsed = TriggerSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const body = parsed.data;
      const tenant = req.tenant;

      const workflow = await getWorkflow(tenant.id, body.workflowKey);
      if (!workflow) {
        return reply.code(404).send({ error: `unknown workflow "${body.workflowKey}"` });
      }

      const transactionId = body.transactionId ?? randomUUID();

      // Fast-path dedupe in Redis; the unique constraint on events is the backstop.
      const fresh = await redis.set(
        `txn:${tenant.id}:${transactionId}`,
        '1',
        'EX',
        DEDUPE_TTL_SECONDS,
        'NX',
      );
      if (fresh === null) {
        const existing = await getEventByTransaction(tenant.id, transactionId);
        return reply.code(200).send({
          transactionId,
          duplicate: true,
          status: existing?.status ?? 'accepted',
        });
      }

      const event = await insertEvent({
        tenantId: tenant.id,
        transactionId,
        workflowKey: body.workflowKey,
        priority: body.priority,
        payload: body.payload,
        recipients: body.to,
      });
      if (!event) {
        // Redis lost the key (restart) but the DB still remembers: duplicate.
        return reply.code(200).send({ transactionId, duplicate: true });
      }

      // Over the soft limit? The burst is accepted but isolated: it goes to
      // the overflow queue and trickles back in as the tenant's budget frees
      // up, so it can't delay other tenants.
      const diverted = req.overflowDiverted === true;
      triggersTotal.inc({ result: diverted ? 'overflow' : 'direct' });
      await withSpan(
        'trigger.accept',
        {
          'notif.transaction_id': transactionId,
          'notif.workflow': body.workflowKey,
          'notif.priority': body.priority,
          'notif.recipients': body.to.length,
          'notif.overflow': diverted,
        },
        async () => {
          await getQueue(diverted ? QUEUE.OVERFLOW : QUEUE.TRIGGER).add(
            transactionId,
            { eventId: event.id, tenantId: tenant.id, _trace: traceCarrier() },
            { attempts: 3 },
          );
        },
      );

      logExec({
        tenantId: tenant.id,
        transactionId,
        level: 'info',
        detail:
          `event accepted${diverted ? ' (diverted to overflow)' : ''}: ` +
          `workflow=${body.workflowKey} recipients=${body.to.length} priority=${body.priority}`,
      });

      return reply.code(202).send({
        transactionId,
        eventId: event.id,
        recipients: body.to.length,
        priority: body.priority,
        overflow: diverted,
      });
    },
  );
}
