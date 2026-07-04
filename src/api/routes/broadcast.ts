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

const BroadcastSchema = z.object({
  workflowKey: z.string().min(1).max(255),
  payload: z.record(z.unknown()).default({}),
  // Blasts default to the bulk tier so they can never crowd out
  // transactional traffic.
  priority: z.enum(PRIORITIES).default('p2'),
  transactionId: z.string().min(1).max(255).optional(),
});

const DEDUPE_TTL_SECONDS = 86_400;

export function registerBroadcastRoutes(app: FastifyInstance) {
  /**
   * Send a workflow to EVERY subscriber of the tenant — one API call, no
   * recipient list. The trigger worker pages through the subscribers table
   * (keyset pagination) and feeds fan-out under backpressure, so a
   * 10M-subscriber blast neither ships 10M records over HTTP nor floods
   * Redis; it streams.
   */
  app.post(
    '/v1/events/broadcast',
    { preHandler: [authenticate, tenantRateLimit] },
    async (req, reply) => {
      const parsed = BroadcastSchema.safeParse(req.body);
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
      const fresh = await redis.set(
        `txn:${tenant.id}:${transactionId}`,
        '1',
        'EX',
        DEDUPE_TTL_SECONDS,
        'NX',
      );
      if (fresh === null) {
        const existing = await getEventByTransaction(tenant.id, transactionId);
        return reply
          .code(200)
          .send({ transactionId, duplicate: true, status: existing?.status ?? 'accepted' });
      }

      const event = await insertEvent({
        tenantId: tenant.id,
        transactionId,
        workflowKey: body.workflowKey,
        priority: body.priority,
        payload: body.payload,
        recipients: [],
        isBroadcast: true,
      });
      if (!event) {
        return reply.code(200).send({ transactionId, duplicate: true });
      }

      triggersTotal.inc({ result: 'broadcast' });
      await withSpan(
        'broadcast.accept',
        {
          'notif.transaction_id': transactionId,
          'notif.workflow': body.workflowKey,
          'notif.priority': body.priority,
        },
        async () => {
          await getQueue(QUEUE.TRIGGER).add(
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
        detail: `broadcast accepted: workflow=${body.workflowKey} priority=${body.priority}`,
      });

      return reply.code(202).send({
        transactionId,
        eventId: event.id,
        broadcast: true,
        priority: body.priority,
      });
    },
  );
}
