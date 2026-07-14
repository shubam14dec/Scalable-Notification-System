import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { logger } from '../../shared/logger';
import { getPublicUrl } from '../../config/public-url';
import { sealSecret, openSecret } from '../../auth/secret-box';
import { mintOauthState } from '../../auth/oauth-state';
import { pool } from '../../db/pool';
import { telegram } from '../../channels/telegram';
import { slack, SlackError } from '../../channels/slack';
import { buildSlackManifest, manifestToYaml, SLACK_BOT_SCOPES } from '../../channels/slack-manifest';
import {
  connectionWebhookState,
  credentials,
  handleTelegramConnect,
  registerWebhook,
  telegramBotTokenSchema,
} from './telegram';
import { emailAddressSchema, handleEmailConnect } from './email-channel';
import {
  handleSlackConnect,
  slackBotTokenSchema,
  slackSigningSecretSchema,
  slackWebhookUrls,
} from './slack';
import { mintLinkToken } from './identities';
import {
  deleteConnectionById,
  deleteRoutingRule,
  getAgent,
  getConnection,
  listConnectionsForTenant,
  listRoutingRules,
  updateConnectionAgent,
  updateConnectionConfig,
  upsertRoutingRule,
  type AgentConnection,
} from '../../db/conversations.repo';

/** The agent columns the manifest builder needs — read directly (no agents.ts import). */
interface AgentManifestRow {
  id: string;
  name: string;
  description: string | null;
  suggested_prompts: Array<{ title: string; message: string }> | null;
}

async function loadAgentForManifest(
  tenantId: string,
  identifier: string,
): Promise<AgentManifestRow | null> {
  const { rows } = await pool.query(
    'select id, name, description, suggested_prompts from agents where tenant_id = $1 and identifier = $2',
    [tenantId, identifier],
  );
  return rows[0] ?? null;
}

/** The sealed-credentials shape a quick-setup slack connection carries. */
interface SlackQuickSetupCreds {
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
  appId?: string;
  botToken?: string;
  configRefreshToken?: string;
}

function openSlackCreds(connection: AgentConnection): SlackQuickSetupCreds {
  try {
    return JSON.parse(openSecret(connection.credentials)) as SlackQuickSetupCreds;
  } catch {
    return {};
  }
}

type SlackChainResult =
  | { kind: 'rotate-failed' }
  | { kind: 'missing-app' }
  | { kind: 'manifest-failed'; message: string }
  | { kind: 'ok'; eventsUrl: string; interactivityUrl: string };

/**
 * The shared rotate→persist→manifest-update core (reconnect + chain repair):
 * spend `refreshToken` via tooling.tokens.rotate, PERSIST the successor into
 * sealed creds IMMEDIATELY (single-use chain — a crash after the rotate must
 * never strand us with a spent token), then push a manifest rebuilt from the
 * current public URL and the agent's CURRENT name/description/prompts.
 *
 * On 'rotate-failed' the row is untouched. From 'missing-app'/'manifest-failed'
 * onward the chain has already advanced and been persisted — the stored
 * successor is healthy even when the manifest push fails.
 */
async function rotateAndPushSlackManifest(
  connection: AgentConnection,
  creds: SlackQuickSetupCreds,
  refreshToken: string,
): Promise<SlackChainResult> {
  let rotated;
  try {
    rotated = await slack.toolingTokensRotate(refreshToken);
  } catch {
    return { kind: 'rotate-failed' };
  }

  // Persist the rotated (single-use) refresh token BEFORE the manifest call.
  await pool.query(
    `update agent_connections set credentials = $2, updated_at = now() where id = $1`,
    [connection.id, sealSecret(JSON.stringify({ ...creds, configRefreshToken: rotated.refreshToken }))],
  );

  const { rows } = await pool.query(
    'select name, description, suggested_prompts from agents where id = $1',
    [connection.agent_id],
  );
  const agent = rows[0] as
    | { name: string; description: string | null; suggested_prompts: Array<{ title: string; message: string }> | null }
    | undefined;
  const appId = creds.appId ?? (connection.config as { appId?: string }).appId;
  if (!agent || !appId) {
    return { kind: 'missing-app' };
  }

  const manifest = buildSlackManifest({
    agentName: agent.name,
    agentDescription: agent.description,
    suggestedPrompts: agent.suggested_prompts,
    publicUrl: await getPublicUrl(),
    connectionId: connection.id,
  });
  try {
    await slack.appsManifestUpdate(rotated.token, appId, manifest);
  } catch (err) {
    return { kind: 'manifest-failed', message: (err as Error).message };
  }

  const urls = await slackWebhookUrls(connection.id);
  return { kind: 'ok', eventsUrl: urls.eventsUrl, interactivityUrl: urls.interactivityUrl };
}

/**
 * Reconnect a Slack quick-setup connection: rotate the STORED refresh token
 * and push a fresh manifest (see rotateAndPushSlackManifest). No stored token
 * means the URLs are pasted manually; a dead chain flags manifestAutoUpdate
 * 'broken' and points the admin at the config-token repair endpoint.
 */
async function reconnectSlack(
  reply: FastifyReply,
  tenantId: string,
  connection: AgentConnection,
): Promise<FastifyReply> {
  const creds = openSlackCreds(connection);

  if (!creds.configRefreshToken) {
    return reply.code(400).send({
      error: 'slack URLs must be pasted manually for this connection',
      code: 'manual',
    });
  }

  const result = await rotateAndPushSlackManifest(connection, creds, creds.configRefreshToken);
  switch (result.kind) {
    case 'rotate-failed':
      // The refresh chain is broken — flag it and make the admin paste a fresh one.
      await updateConnectionConfig(tenantId, connection.id, { manifestAutoUpdate: 'broken' });
      return reply.code(409).send({
        error: 'slack config refresh token expired — paste a fresh one in the dashboard',
        code: 'refresh-expired',
      });
    case 'missing-app':
      return reply.code(409).send({ error: 'connection is missing its slack app id', code: 'manual' });
    case 'manifest-failed':
      return reply.code(502).send({ error: result.message });
    case 'ok':
      return reply.send({ eventsUrl: result.eventsUrl, interactivityUrl: result.interactivityUrl, updated: true });
  }
}

/**
 * The connection-as-endpoint API surface: channel connections are standalone
 * resources (a bot / an inbound address), each routed to exactly one agent.
 * The legacy per-agent routes (telegram.ts, email-channel.ts, identities.ts)
 * are byte-identical shims over the SAME shared cores this file calls, so
 * either surface produces the same effects. A sealed credential or bot token
 * never appears in any response here — only minted webhook URLs and config.
 */
export function registerConnectionRoutes(app: FastifyInstance) {
  /** Every connection in the tenant, with its agent and live webhook state. */
  app.get('/v1/connections', { preHandler: [authenticate] }, async (req) => {
    const rows = await listConnectionsForTenant(req.tenant.id);
    const connections = [];
    for (const c of rows) {
      const state = await connectionWebhookState(c);
      connections.push({
        id: c.id,
        channel: state.channel,
        status: state.status,
        config: state.config,
        agent: { identifier: c.agent_identifier, name: c.agent_name },
        webhook: state.webhook,
        createdAt: state.createdAt,
      });
    }
    return { connections };
  });

  /** Connect a telegram bot and route it to an agent named in the body. */
  app.post('/v1/connections/telegram', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({ botToken: telegramBotTokenSchema, agentIdentifier: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return handleTelegramConnect(reply, req.tenant.id, agent, parsed.data.botToken);
  });

  /** Connect an inbound email address and route it to an agent named in the body. */
  app.post('/v1/connections/email', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({ address: emailAddressSchema, agentIdentifier: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return handleEmailConnect(reply, req.tenant.id, agent, parsed.data.address);
  });

  /** Connect a Slack workspace (bot token + signing secret) and route it to an agent. */
  app.post('/v1/connections/slack', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({
        botToken: slackBotTokenSchema,
        signingSecret: slackSigningSecretSchema,
        agentIdentifier: z.string().min(1),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return handleSlackConnect(
      reply,
      req.tenant.id,
      agent,
      parsed.data.botToken,
      parsed.data.signingSecret,
    );
  });

  /**
   * Slack quick-setup: turn an app-configuration token into a fully wired Slack
   * app in one call. We insert a PENDING connection first (so its id is baked
   * into the manifest's webhook URLs), POST the manifest to apps.manifest.create,
   * then seal the app's OAuth credentials onto the row. The connection stays
   * pending until the admin completes the install (GET .../slack/install →
   * Slack → the OAuth callback flips it active). On any create failure the stub
   * row is deleted so a retry starts clean.
   */
  app.post('/v1/connections/slack/quick-setup', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({
        configToken: z.string().min(10),
        configRefreshToken: z.string().optional(),
        agentIdentifier: z.string().min(1),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }

    const agent = await loadAgentForManifest(req.tenant.id, parsed.data.agentIdentifier);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });

    // Stub row FIRST — its id is the routing key baked into the manifest URLs.
    const stub = await pool.query(
      `insert into agent_connections (tenant_id, agent_id, channel, credentials, config, status)
       values ($1, $2, 'slack', $3, '{}'::jsonb, 'pending')
       returning id`,
      [req.tenant.id, agent.id, sealSecret(JSON.stringify({}))],
    );
    const connectionId = stub.rows[0].id as string;

    const publicUrl = await getPublicUrl();
    const manifest = buildSlackManifest({
      agentName: agent.name,
      agentDescription: agent.description,
      suggestedPrompts: agent.suggested_prompts,
      publicUrl,
      connectionId,
    });

    let app_;
    try {
      app_ = await slack.appsManifestCreate(parsed.data.configToken, manifest);
    } catch (err) {
      // The stub is useless without an app — remove it so a retry is clean.
      await pool.query('delete from agent_connections where id = $1', [connectionId]);
      if (err instanceof SlackError) {
        // invalid_auth is what live Slack ACTUALLY returns for a malformed or
        // stale config token (proven by curl 2026-07-14); invalid_token /
        // token_expired are the documented codes — same admin fix for all three.
        if (
          err.error === 'invalid_auth' ||
          err.error === 'invalid_token' ||
          err.error === 'token_expired'
        ) {
          return reply.code(400).send({
            error:
              'slack config token invalid or expired — tokens last 12 hours; generate a fresh one',
          });
        }
        if (err.error === 'invalid_manifest') {
          const detail = (err.details ?? [])
            .map((d) => `${d.pointer ?? ''} ${d.message ?? ''}`.trim())
            .filter(Boolean)
            .join('; ');
          return reply.code(400).send({
            error: 'slack rejected the manifest',
            code: 'invalid_manifest',
            ...(detail ? { detail } : {}),
          });
        }
        return reply.code(400).send({ error: `slack rejected the app: ${err.error}` });
      }
      throw err;
    }

    const sealed = sealSecret(
      JSON.stringify({
        clientId: app_.clientId,
        clientSecret: app_.clientSecret,
        signingSecret: app_.signingSecret,
        appId: app_.appId,
        ...(parsed.data.configRefreshToken
          ? { configRefreshToken: parsed.data.configRefreshToken }
          : {}),
      }),
    );
    await pool.query(
      `update agent_connections set credentials = $2, config = $3::jsonb, updated_at = now()
        where id = $1`,
      [
        connectionId,
        sealed,
        JSON.stringify({
          appId: app_.appId,
          ...(parsed.data.configRefreshToken ? { manifestAutoUpdate: 'on' } : {}),
        }),
      ],
    );

    const urls = await slackWebhookUrls(connectionId);
    reply.code(201);
    return {
      connectionId,
      installUrl: `/v1/connections/${connectionId}/slack/install`,
      eventsUrl: urls.eventsUrl,
      interactivityUrl: urls.interactivityUrl,
    };
  });

  /**
   * Kick off the OAuth install for a quick-setup connection: 302 to Slack's
   * consent screen, scoped to the app's own client id and the 12 bot scopes,
   * with an HMAC-signed state binding the callback to this connection+tenant.
   * Content negotiation: with `Accept: application/json` the URL comes back as
   * `{authorizeUrl}` instead — a browser fetch can't read a 302's Location
   * (opaqueredirect) and window.open can't carry auth headers, so the dashboard
   * asks for JSON and navigates itself. Plain requests keep the redirect.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/connections/:id/slack/install',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });

      let creds: { clientId?: string };
      try {
        creds = JSON.parse(openSecret(connection.credentials));
      } catch {
        creds = {};
      }
      if (connection.channel !== 'slack' || !creds.clientId) {
        return reply.code(409).send({ error: 'not a quick-setup connection' });
      }

      const redirectUri = `${await getPublicUrl()}/webhooks/slack/oauth/callback`;
      const state = mintOauthState({ connectionId: connection.id, tenantId: req.tenant.id });
      const url =
        'https://slack.com/oauth/v2/authorize' +
        `?client_id=${encodeURIComponent(creds.clientId)}` +
        `&scope=${encodeURIComponent(SLACK_BOT_SCOPES.join(','))}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}`;
      if (req.headers.accept?.includes('application/json')) {
        return { authorizeUrl: url };
      }
      return reply.redirect(url);
    },
  );

  /**
   * Repair a broken config-token chain: the admin generates a fresh token pair
   * on api.slack.com and pastes the REFRESH token here. We spend it once via
   * rotate (proving it's live), persist its successor, push a current manifest,
   * and clear the 'broken' flag. This is the recovery for a dead single-use
   * chain (reused/lost refresh token) — without it the only fix was recreating
   * the connection.
   */
  app.put<{ Params: { id: string } }>(
    '/v1/connections/:id/slack/config-token',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const parsed = z.object({ configRefreshToken: z.string().min(10) }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });

      const creds = openSlackCreds(connection);
      if (connection.channel !== 'slack' || !creds.clientId || !creds.appId) {
        return reply.code(409).send({ error: 'not a quick-setup connection' });
      }

      const result = await rotateAndPushSlackManifest(
        connection,
        creds,
        parsed.data.configRefreshToken,
      );
      switch (result.kind) {
        case 'rotate-failed':
          // Nothing was persisted — the row (and any 'broken' flag) is unchanged.
          return reply.code(422).send({
            error:
              'refresh token invalid or already used — generate a fresh token pair on api.slack.com and paste the new refresh token',
          });
        case 'missing-app':
          return reply.code(409).send({ error: 'not a quick-setup connection' });
        case 'manifest-failed':
          // The rotate succeeded and the successor is persisted, so the STORED
          // chain is healthy — the admin's pasted token is spent and must not
          // be retried. Mark auto-update 'on' anyway: the next reconnect uses
          // the stored successor and heals the URLs then.
          await updateConnectionConfig(req.tenant.id, connection.id, { manifestAutoUpdate: 'on' });
          return reply.code(502).send({ error: result.message });
        case 'ok':
          await updateConnectionConfig(req.tenant.id, connection.id, { manifestAutoUpdate: 'on' });
          return reply.send({
            eventsUrl: result.eventsUrl,
            interactivityUrl: result.interactivityUrl,
            updated: true,
          });
      }
    },
  );

  /**
   * Preview the app manifest as YAML for the MANUAL create flow (paste into
   * api.slack.com). Built with a placeholder connection id ('pending'); the
   * real webhook URLs are returned by the manual create path once the admin
   * pastes the app's credentials back.
   */
  app.get<{ Querystring: { agentIdentifier?: string } }>(
    '/v1/connections/slack/manifest-preview',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agentIdentifier = req.query.agentIdentifier;
      if (!agentIdentifier) {
        return reply.code(400).send({ error: 'agentIdentifier is required' });
      }
      const agent = await loadAgentForManifest(req.tenant.id, agentIdentifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const yaml = manifestToYaml(
        buildSlackManifest({
          agentName: agent.name,
          agentDescription: agent.description,
          suggestedPrompts: agent.suggested_prompts,
          publicUrl: await getPublicUrl(),
          connectionId: 'pending',
        }),
      );
      return {
        yaml,
        prefillUrl: 'https://api.slack.com/apps?new_app=1&manifest_yaml=' + encodeURIComponent(yaml),
      };
    },
  );

  /** Re-point a connection at a different agent, moving its live threads along. */
  app.patch<{ Params: { id: string } }>(
    '/v1/connections/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid connection id' });
      }
      const parsed = z.object({ agentIdentifier: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const result = await updateConnectionAgent(req.tenant.id, req.params.id, agent.id);
      if (!result) return reply.code(404).send({ error: 'unknown connection' });
      return {
        id: result.connection.id,
        agent: { identifier: agent.identifier, name: agent.name },
        movedConversations: result.movedConversations,
      };
    },
  );

  /**
   * Re-register / refresh the channel's inbound wiring. Telegram re-issues its
   * webhook. Slack, when the connection carries a config refresh token, rotates
   * the token and pushes a fresh manifest (auto-updating the event URLs to the
   * current public URL); without one, the URLs are pasted manually. Email's URL
   * is static.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/connections/:id/reconnect',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });

      if (connection.channel === 'telegram') {
        try {
          const url = await registerWebhook(connection);
          return { channel: 'telegram', webhookUrl: url };
        } catch (err) {
          return reply.code(502).send({ error: (err as Error).message });
        }
      }

      if (connection.channel === 'slack') {
        return reconnectSlack(reply, req.tenant.id, connection);
      }

      // Email (and anything else): the inbound address is static — nothing to
      // re-issue. `code:'manual'` tells the CLI to prompt for a manual paste.
      return reply.code(400).send({
        error: 'nothing to re-register — the email webhook URL is static',
        code: 'manual',
      });
    },
  );

  /** Disconnect a connection: best-effort de-register, then delete the row. */
  app.delete<{ Params: { id: string } }>(
    '/v1/connections/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel === 'telegram') {
        // Best effort: a revoked bot token must not block disconnecting.
        await telegram
          .deleteWebhook(credentials(connection).botToken)
          .catch((err) =>
            logger.warn(
              { err: (err as Error).message },
              'telegram deleteWebhook failed on disconnect',
            ),
          );
      }
      await deleteConnectionById(req.tenant.id, req.params.id);
      return { deleted: true };
    },
  );

  /** Mint a telegram deep-link token through a specific active connection. */
  app.post<{ Params: { id: string } }>(
    '/v1/connections/:id/link-tokens',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const parsed = z.object({ subscriberId: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      const botUsername = (connection.config as { botUsername?: string } | null)?.botUsername;
      if (connection.channel !== 'telegram' || connection.status !== 'active' || !botUsername) {
        return reply.code(404).send({ error: 'no active telegram connection' });
      }
      return mintLinkToken(reply, req.tenant.id, connection, parsed.data.subscriberId);
    },
  );

  // ---- slack scope routing rules (a slack-only feature) ----

  /** List a slack connection's scope routing rules. */
  app.get<{ Params: { id: string } }>(
    '/v1/connections/:id/routes',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel !== 'slack') {
        return reply.code(400).send({ error: 'routing rules are a slack feature' });
      }
      const rules = await listRoutingRules(req.tenant.id, connection.id);
      return {
        routes: rules.map((r) => ({
          scopeKey: r.scope_key,
          agent: { identifier: r.agent_identifier, name: r.agent_name },
          createdAt: r.created_at,
        })),
      };
    },
  );

  /** Set (or re-point) the rule for a scope — a slack channel/group id. */
  app.put<{ Params: { id: string } }>(
    '/v1/connections/:id/routes',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel !== 'slack') {
        return reply.code(400).send({ error: 'routing rules are a slack feature' });
      }
      const parsed = z
        .object({
          scopeKey: z
            .string()
            .trim()
            .regex(/^[CG][A-Z0-9]{6,}$/i, 'that does not look like a slack channel id'),
          agentIdentifier: z.string().min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      await upsertRoutingRule({
        tenantId: req.tenant.id,
        connectionId: connection.id,
        scopeKey: parsed.data.scopeKey,
        agentId: agent.id,
      });
      return {
        scopeKey: parsed.data.scopeKey,
        agent: { identifier: agent.identifier, name: agent.name },
      };
    },
  );

  /** Remove a scope routing rule. */
  app.delete<{ Params: { id: string; scopeKey: string } }>(
    '/v1/connections/:id/routes/:scopeKey',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel !== 'slack') {
        return reply.code(400).send({ error: 'routing rules are a slack feature' });
      }
      const deleted = await deleteRoutingRule(req.tenant.id, connection.id, req.params.scopeKey);
      return { deleted };
    },
  );
}
