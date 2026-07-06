import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env';
import { logger } from '../shared/logger';
import { registerTriggerRoutes } from './routes/trigger';
import { registerAdminRoutes } from './routes/admin';
import { registerEventRoutes } from './routes/events';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerOpsRoutes } from './routes/ops';
import { registerInboxRoutes } from './routes/inbox';
import { registerSuppressionRoutes } from './routes/suppressions';
import { registerBroadcastRoutes } from './routes/broadcast';
import { registerAuthRoutes } from './routes/auth';
import { registerAccountRoutes } from './routes/account';
import { registerIntegrationRoutes } from './routes/integrations';
import { registerTopicRoutes } from './routes/topics';
import { registerTrackingRoutes } from './routes/tracking';
import { registerTemplateRoutes } from './routes/templates';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact request bytes, kept for webhook HMAC verification. */
    rawBody?: string;
  }
}

/**
 * Builds the fully-wired Fastify app WITHOUT binding a port — the server
 * entrypoint listens on it, and tests exercise it in-process via inject().
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  // Keep the raw body: HMAC signatures are computed over exact bytes, and
  // re-serializing parsed JSON would not round-trip byte-for-byte.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, payload, done) => {
    req.rawBody = payload as string;
    try {
      done(null, (payload as string).length > 0 ? JSON.parse(payload as string) : {});
    } catch (err) {
      done(err as Error);
    }
  });

  await app.register(fastifyJwt, { secret: env.jwtSecret });

  registerAuthRoutes(app);
  registerAccountRoutes(app);
  registerIntegrationRoutes(app);
  registerTopicRoutes(app);
  registerTrackingRoutes(app);
  registerTemplateRoutes(app);
  registerTriggerRoutes(app);
  registerAdminRoutes(app);
  registerEventRoutes(app);
  registerWebhookRoutes(app);
  registerOpsRoutes(app);
  registerInboxRoutes(app);
  registerSuppressionRoutes(app);
  registerBroadcastRoutes(app);

  app.setErrorHandler((err, _req, reply) => {
    logger.error(err, 'unhandled api error');
    reply.code(500).send({ error: 'internal error' });
  });

  return app;
}
