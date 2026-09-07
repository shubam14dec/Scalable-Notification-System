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
import { registerAgentRoutes } from './routes/agents';
import { registerAgentToolRoutes } from './routes/agent-tools';
import { registerApprovalRoutes } from './routes/approvals';
import { registerConversationMessageRoutes } from './routes/conversation-messages';
import { registerTelegramRoutes } from './routes/telegram';
import { registerEmailChannelRoutes } from './routes/email-channel';
import { registerSlackRoutes } from './routes/slack';
import { registerIdentityRoutes } from './routes/identities';
import { registerMeRoutes } from './routes/me';
import { registerDeviceRoutes } from './routes/devices';
import { registerAgentEvalRoutes } from './routes/agent-evals';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerSmsWebhookRoutes } from './routes/sms-webhooks';
import { registerConnectionRoutes } from './routes/connections';
import { registerHandoffRoutes } from './routes/handoff';
import { registerSettingsRoutes } from './routes/settings';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact request bytes, kept for webhook HMAC verification. */
    rawBody?: string;
  }
}

/**
 * CSP for API responses that are NOT documents — JSON, the open-tracking GIF,
 * plain text. Browsers ignore CSP on subresources, so this only bites when
 * someone navigates a tab straight at an endpoint and the browser renders the
 * body as a document; then nothing at all may load out of it.
 */
const API_JSON_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/**
 * CSP for the API's REAL HTML pages: the phone-facing bot-setup handoff
 * (routes/handoff.ts) and the Slack OAuth result page (routes/slack.ts).
 * `default-src 'none'` alone would strip both of their styling — handoff uses a
 * <style> block, the Slack page uses style="" attributes, and style-src falls
 * back to default-src — so they get 'unsafe-inline' for STYLE only. Neither
 * page has a script of any kind, so script-src stays 'none' via the fallback,
 * which is the strictest useful policy for a page that takes a paste from an
 * untrusted phone. form-action 'self' keeps the handoff paste posting home.
 */
const API_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Builds the fully-wired Fastify app WITHOUT binding a port — the server
 * entrypoint listens on it, and tests exercise it in-process via inject().
 */
export async function buildApp(): Promise<FastifyInstance> {
  // trustProxy: behind Caddy in production req.ip is otherwise the proxy's address, collapsing every per-IP abuse brake (src/api/rate-limit.ts — login, signup, refresh, the handoff paste page, the widget's inbound turns) into one global bucket; dev is unaffected (nothing sets X-Forwarded-For).
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });

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

  // Slack interactivity posts application/x-www-form-urlencoded; keep the raw
  // body for its HMAC signature and expose the decoded form as the parsed body.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, payload, done) => {
      req.rawBody = payload as string;
      done(null, Object.fromEntries(new URLSearchParams(payload as string)));
    },
  );

  // Pin the JWT algorithm on BOTH sides. Without `verify.algorithms` the
  // verifier accepts whatever `alg` the token header claims, which is the
  // classic algorithm-confusion surface; the WS gateway already hard-required
  // HS256 (src/ws/gateway.ts) while the API was the looser of the two. Option
  // shapes are fast-jwt's: SignerOptions.algorithm (singular) and
  // VerifierOptions.algorithms (a list) — see node_modules/fast-jwt/src/index.d.ts.
  // Per-call options (routes/auth.ts passes expiresIn) merge over these.
  await app.register(fastifyJwt, {
    secret: env.jwtSecret,
    sign: { algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });

  /**
   * S1.3 response hardening for every API reply. Hand-rolled rather than
   * helmet: five headers, no dependency, and the branch below needs to know
   * about our own HTML routes anyway.
   *
   * The split with Caddy is one-writer-per-header — Caddy sets the SPA's
   * headers on the static handler only (deploy/compose/Caddyfile) and sets
   * HSTS site-wide; anything Caddy sets for proxied API responses would
   * APPEND next to these rather than replace them.
   *
   * Referrer-Policy is `no-referrer` here, stricter than the SPA's
   * strict-origin-when-cross-origin: API URLs carry ids and handoff tokens in
   * the path, and no API response has a legitimate reason to leak its own URL
   * onward.
   */
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');

    // Token-bearing responses: /auth/login, /auth/signup and /auth/refresh
    // hand back access/refresh tokens, and the one-shot handoff read under
    // /v1/ops/handoffs returns a bot token. no-store keeps them out of any
    // intermediary and out of the browser's back/forward cache.
    if (req.url.startsWith('/auth/') || req.url.startsWith('/v1/ops/handoffs')) {
      reply.header('Cache-Control', 'no-store');
    }

    // Branch on the OUTGOING content type, not on a path allowlist: a list of
    // HTML routes would silently drift the next time one is added, and the
    // content type is the thing the browser actually acts on.
    const contentType = String(reply.getHeader('content-type') ?? '');
    reply.header(
      'Content-Security-Policy',
      contentType.startsWith('text/html') ? API_HTML_CSP : API_JSON_CSP,
    );

    return payload;
  });

  registerAuthRoutes(app);
  registerAccountRoutes(app);
  registerIntegrationRoutes(app);
  registerTopicRoutes(app);
  registerTrackingRoutes(app);
  registerTemplateRoutes(app);
  registerAgentRoutes(app);
  registerAgentToolRoutes(app);
  registerApprovalRoutes(app);
  registerConversationMessageRoutes(app);
  registerTelegramRoutes(app);
  registerEmailChannelRoutes(app);
  registerHandoffRoutes(app);
  registerSlackRoutes(app);
  registerIdentityRoutes(app);
  registerMeRoutes(app);
  registerDeviceRoutes(app);
  registerAgentEvalRoutes(app);
  registerKnowledgeRoutes(app);
  registerSmsWebhookRoutes(app);
  registerConnectionRoutes(app);
  registerSettingsRoutes(app);
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
