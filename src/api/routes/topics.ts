import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import {
  addTopicSubscribers,
  deleteTopic,
  getTopicByKey,
  listTopicMembers,
  listTopics,
  removeTopicSubscribers,
  upsertTopic,
} from '../../db/topics.repo';

const TopicSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-_:.]+$/, 'lowercase letters, digits, - _ : . only'),
  name: z.string().min(1).max(255),
});

const MembersSchema = z.object({
  subscriberIds: z.array(z.string().min(1).max(255)).min(1).max(1000),
});

export function registerTopicRoutes(app: FastifyInstance) {
  app.get('/v1/topics', { preHandler: [authenticate] }, async (req) => ({
    topics: await listTopics(req.tenant.id),
  }));

  app.put('/v1/topics', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = TopicSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const topic = await upsertTopic(req.tenant.id, parsed.data.key, parsed.data.name);
    return { id: topic.id, key: topic.key, name: topic.name };
  });

  app.delete<{ Params: { key: string } }>(
    '/v1/topics/:key',
    { preHandler: [authenticate] },
    async (req) => ({ deleted: (await deleteTopic(req.tenant.id, req.params.key)) > 0 }),
  );

  app.get<{ Params: { key: string } }>(
    '/v1/topics/:key/subscribers',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const topic = await getTopicByKey(req.tenant.id, req.params.key);
      if (!topic) return reply.code(404).send({ error: 'unknown topic' });
      return { members: await listTopicMembers(topic.id) };
    },
  );

  app.post<{ Params: { key: string } }>(
    '/v1/topics/:key/subscribers',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const topic = await getTopicByKey(req.tenant.id, req.params.key);
      if (!topic) return reply.code(404).send({ error: 'unknown topic' });
      const parsed = MembersSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const added = await addTopicSubscribers(req.tenant.id, topic.id, parsed.data.subscriberIds);
      return { added };
    },
  );

  app.delete<{ Params: { key: string } }>(
    '/v1/topics/:key/subscribers',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const topic = await getTopicByKey(req.tenant.id, req.params.key);
      if (!topic) return reply.code(404).send({ error: 'unknown topic' });
      const parsed = MembersSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const removed = await removeTopicSubscribers(
        req.tenant.id,
        topic.id,
        parsed.data.subscriberIds,
      );
      return { removed };
    },
  );
}
