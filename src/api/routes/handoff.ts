import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { pool } from '../../db/pool';
import { redis } from '../../shared/redis';
import { getPublicUrl } from '../../config/public-url';
import { sealSecret, openSecret } from '../../auth/secret-box';
import { logger } from '../../shared/logger';
import { logExec } from '../../core/execution-log';
import { parseBotFatherToken } from '../../shared/botfather';

/**
 * QR-code bot setup handoff. The dashboard mints a 5-minute single-use token
 * and shows its {publicUrl}/handoff/<token> as a QR; the operator's PHONE
 * opens that page and pastes BotFather's "Done! ..." message. We parse the bot
 * token out of the paste, seal it into the row, and the authed dashboard poll
 * reads it back exactly once (payload nulled on read). The token is stored
 * hashed only — the plaintext lives solely in the QR and the phone's URL bar.
 */

const HANDOFF_TTL_MS = 5 * 60 * 1000;
/** Public paste endpoint: per-IP burst wall (unauthenticated surface). */
const PASTE_LIMIT_PER_MIN = 10;

function hashHandoffToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Redis per-IP+minute counter — the same Redis-backed idiom as tenantRateLimit
 * (src/api/rate-limit.ts), so the wall holds across API replicas. Returns true
 * when this request is within the 10/min budget.
 */
async function withinPasteBudget(ip: string): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `handoff-rl:${ip}:${minute}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 61);
  return count <= PASTE_LIMIT_PER_MIN;
}

/** A whole standalone HTML document — no framework, no tenant data, mobile-first. */
function htmlPage(bodyInner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Asyncify — bot setup</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #0f172a; background: #f8fafc;
    min-height: 100vh;
  }
  main {
    max-width: 480px; margin: 0 auto; padding: 24px;
    background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,.06);
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: #475569; }
  textarea {
    width: 100%; min-height: 160px; padding: 12px;
    font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    border: 1px solid #cbd5e1; border-radius: 8px; resize: vertical;
  }
  button {
    margin-top: 16px; width: 100%; padding: 14px;
    font-size: 16px; font-weight: 600; color: #fff;
    background: #2563eb; border: 0; border-radius: 8px; cursor: pointer;
  }
  button:active { background: #1d4ed8; }
  .ok { color: #16a34a; font-size: 22px; }
  .muted { color: #64748b; font-size: 14px; }
</style>
</head>
<body>
<main>
${bodyInner}
</main>
</body>
</html>`;
}

function formPage(token: string): string {
  return htmlPage(`
  <h1>Asyncify — bot setup</h1>
  <p>Paste the full message BotFather sent you (the one that starts with
  “Done! Congratulations…”). We'll pull the bot token out of it.</p>
  <form method="post" action="/handoff/${token}">
    <textarea name="message" placeholder="Paste BotFather's message here" autofocus></textarea>
    <button type="submit">Send to my computer</button>
  </form>`);
}

/** Shown for unknown / expired / already-used tokens — never says which. */
function expiredPage(): string {
  return htmlPage(`
  <h1>Asyncify — bot setup</h1>
  <p>This link has expired — generate a fresh QR from your dashboard.</p>`);
}

function noTokenPage(): string {
  return htmlPage(`
  <h1>Asyncify — bot setup</h1>
  <p>No bot token found — paste BotFather's full message, including the
  <code>&lt;digits&gt;:&lt;letters&gt;</code> token line.</p>
  <p class="muted">Nothing was submitted; you can paste again.</p>`);
}

function ambiguousPage(): string {
  return htmlPage(`
  <h1>Asyncify — bot setup</h1>
  <p>More than one bot token was found — paste the message for just the
  <strong>one</strong> bot you're connecting.</p>
  <p class="muted">Nothing was submitted; you can paste again.</p>`);
}

function receivedPage(): string {
  return htmlPage(`
  <h1 class="ok">✔ Received</h1>
  <p>Return to your computer — setup will continue there. You can close this
  tab.</p>`);
}

function sendHtml(reply: FastifyReply, code: number, body: string): FastifyReply {
  return reply.code(code).type('text/html; charset=utf-8').send(body);
}

export function registerHandoffRoutes(app: FastifyInstance) {
  // ---- authed: dashboard mints and polls ----

  /** Mint a single-use 5-minute handoff token; returns the phone-facing URL. */
  app.post('/v1/ops/handoffs', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({ channel: z.enum(['telegram']).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const channel = parsed.data.channel ?? 'telegram';

    // Opportunistic hygiene: the shared inactivity sweep lives outside this
    // slice's files, so drop this tenant's long-expired rows here instead of
    // in the sweep (see the divergence note in the slice report).
    await pool
      .query(
        `delete from setup_handoffs
          where tenant_id = $1 and expires_at < now() - interval '1 hour'`,
        [req.tenant.id],
      )
      .catch((err) =>
        logger.warn({ err: (err as Error).message }, 'handoff opportunistic purge failed'),
      );

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
    const { rows } = await pool.query(
      `insert into setup_handoffs (tenant_id, channel, token_hash, expires_at)
       values ($1, $2, $3, $4)
       returning id, expires_at`,
      [req.tenant.id, channel, hashHandoffToken(token), expiresAt],
    );

    const publicUrl = await getPublicUrl();
    return reply.code(201).send({
      handoffId: rows[0].id,
      url: `${publicUrl}/handoff/${token}`,
      expiresAt: rows[0].expires_at,
    });
  });

  /**
   * One-shot poll. When the paste has landed, this returns the bot token AND
   * nulls the sealed payload in the SAME statement — a data-modifying CTE runs
   * to completion, while the outer select reads the pre-clear snapshot, so the
   * token is handed out exactly once. Later polls report 'consumed'.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/ops/handoffs/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid handoff id' });
      }
      const { rows } = await pool.query(
        `with target as (
           select id, payload_sealed, used_at, expires_at
             from setup_handoffs
            where id = $1 and tenant_id = $2
         ),
         cleared as (
           update setup_handoffs h set payload_sealed = null
             from target t
            where h.id = t.id and t.payload_sealed is not null
           returning h.id
         )
         select payload_sealed, used_at, expires_at from target`,
        [req.params.id, req.tenant.id],
      );
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: 'unknown handoff' });

      if (row.used_at) {
        if (row.payload_sealed) {
          const { botToken } = JSON.parse(openSecret(row.payload_sealed)) as { botToken: string };
          return { status: 'received' as const, botToken };
        }
        return { status: 'consumed' as const };
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        return { status: 'expired' as const };
      }
      return { status: 'pending' as const };
    },
  );

  // ---- public: the phone opens and pastes here (no auth, no tenant data) ----

  /** The paste form (or the expired notice for a dead token). */
  app.get<{ Params: { token: string } }>('/handoff/:token', async (req, reply) => {
    const { rows } = await pool.query(
      `select id from setup_handoffs
        where token_hash = $1 and used_at is null and expires_at > now()`,
      [hashHandoffToken(req.params.token)],
    );
    if (!rows[0]) return sendHtml(reply, 410, expiredPage());
    return sendHtml(reply, 200, formPage(req.params.token));
  });

  /** Accept the pasted BotFather message (form or JSON), parse, seal, consume. */
  app.post<{ Params: { token: string }; Body: unknown }>(
    '/handoff/:token',
    async (req, reply) => {
      if (!(await withinPasteBudget(req.ip))) {
        return sendHtml(reply, 429, htmlPage('<h1>Too many attempts</h1><p>Please wait a minute and try again.</p>'));
      }

      const body = (req.body ?? {}) as { message?: unknown };
      const message = typeof body.message === 'string' ? body.message : '';

      // Parse FIRST, consume only on success — a bad paste must leave the
      // single-use token intact so the operator can retry on the same link.
      const parsed = parseBotFatherToken(message);
      if ('error' in parsed) {
        return sendHtml(reply, 422, parsed.error === 'ambiguous' ? ambiguousPage() : noTokenPage());
      }

      // Atomic single-use consume + seal in one statement (mirrors
      // consumeLinkToken): a redelivered/duplicate paste updates zero rows.
      const sealed = sealSecret(JSON.stringify({ botToken: parsed.token }));
      const { rows } = await pool.query(
        `update setup_handoffs
            set used_at = now(), payload_sealed = $2
          where token_hash = $1 and used_at is null and expires_at > now()
          returning id, tenant_id`,
        [hashHandoffToken(req.params.token), sealed],
      );
      if (!rows[0]) return sendHtml(reply, 410, expiredPage());

      logExec({
        tenantId: rows[0].tenant_id,
        transactionId: `handoff-${rows[0].id}`,
        level: 'info',
        detail: 'bot setup handoff received',
      });
      return sendHtml(reply, 200, receivedPage());
    },
  );
}
