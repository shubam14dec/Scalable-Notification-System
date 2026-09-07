import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { assertSafeOutboundHost, UnsafeOutboundUrlError } from '../core/safe-url';
import { PermanentError, TransientError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { ChannelProvider, RenderedMessage, SendResult } from './types';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * HTML body for an email: pre-rendered template HTML when present,
 * otherwise the plain-text body wrapped minimally — with the open-tracking
 * pixel injected either way.
 */
export function toHtmlBody(message: RenderedMessage): string | undefined {
  const pixel = message.pixelUrl
    ? `<img src="${message.pixelUrl}" width="1" height="1" alt="" style="display:block"/>`
    : '';

  if (message.htmlBody) {
    if (!pixel) return message.htmlBody;
    return /<\/body>/i.test(message.htmlBody)
      ? message.htmlBody.replace(/<\/body>/i, `${pixel}</body>`)
      : message.htmlBody + pixel;
  }

  if (!message.pixelUrl) return undefined;
  return (
    `<!doctype html><html><body>` +
    `<div style="white-space:pre-wrap;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">` +
    escapeHtml(message.body) +
    `</div>` +
    pixel +
    `</body></html>`
  );
}

export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  user?: string;
  pass?: string;
  secure?: boolean;
}

/**
 * The connect-time half of the SMTP SSRF gate.
 *
 * INVESTIGATION (nodemailer 6.10.1, read from source): the SMTP transport does
 * NOT accept a custom DNS `lookup`, so the undici `safeDispatcher()` trick has
 * no equivalent here. `SMTPConnection.connect` builds its own connect options
 * from scratch — `{port, host, allowInternalNetworkInterfaces, timeout}` plus
 * `localAddress` and the `tls` block (lib/smtp-connection/index.js:224-233) —
 * and never forwards a `lookup` from the transport options. It then resolves
 * the host ITSELF via `shared.resolveHostname`
 * (lib/shared/index.js:90-260, `dns.resolve4` → `resolve6` → `dns.lookup`,
 * behind a module-level 5-minute cache) and overwrites `opts.host` with the
 * chosen IP literal before `net.connect` / `tls.connect`
 * (lib/smtp-connection/index.js:364 and :331) — at which point Node skips any
 * lookup anyway. Its one adjacent-sounding option,
 * `allowInternalNetworkInterfaces`, filters LOCAL interface families; it says
 * nothing about the destination.
 *
 * So this is a resolve-and-assert immediately before each send, not a pin.
 * RESIDUAL TOCTOU, stated honestly: we resolve, then nodemailer resolves again
 * on its own, and a rebinding host can answer differently in that gap. What
 * this closes is the large window — a host that passed the write-time check at
 * `src/api/routes/integrations.ts` months ago and has pointed at 169.254.169.254
 * ever since. The remaining window is milliseconds wide and, because
 * nodemailer's DNS cache holds up to 5 minutes, usually resolves to an OLDER
 * answer than ours rather than a newer one. Closing it entirely would mean
 * pinning `host` to a vetted IP with `servername` for SNI — rejected because
 * provider instances are cached by `id:updated_at`
 * (`src/providers/factory.ts`), so the pin would outlive any legitimate IP
 * rotation of the tenant's mail host.
 */
async function assertSmtpHostSafe(host: string): Promise<void> {
  try {
    await assertSafeOutboundHost(host);
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      // Same shape as every other config-SSRF refusal (bridge/tool dials,
      // knowledge fetches): permanent, so it lands as a transcript/exec-log
      // note instead of burning the retry budget on a host that cannot
      // become legal by trying again.
      throw new PermanentError(`smtp host blocked: ${err.message}`);
    }
    throw err;
  }
}

/** SMTP — the env-configured default, or a per-tenant integration. */
export class SmtpEmailProvider implements ChannelProvider {
  readonly id: string;
  readonly channel = 'email' as const;
  private readonly from: string;
  /**
   * Set only when the host came from a TENANT integration. The env-configured
   * default is operator infrastructure (mailpit on the compose network, an
   * internal relay) — SSRF-gating it would block exactly the private targets
   * the operator meant to configure.
   */
  private readonly tenantHost: string | null;
  private transport: nodemailer.Transporter;

  constructor(config?: SmtpConfig, instanceId = 'smtp') {
    this.id = instanceId;
    const cfg = config ?? {
      host: env.smtpHost,
      port: env.smtpPort,
      from: env.smtpFrom,
    };
    this.from = cfg.from;
    this.tenantHost = config ? cfg.host : null;
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure ?? false,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      pool: true,
      maxConnections: 10,
    });
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    if (!message.to.email) {
      throw new PermanentError('subscriber has no email address');
    }
    // Chaos hook: simulate a flaky provider to exercise retries,
    // circuit breaking and failover locally. Off by default.
    if (env.emailChaosRate > 0 && Math.random() < env.emailChaosRate) {
      throw new TransientError('chaos: simulated smtp 5xx');
    }
    // Re-vet the tenant's host against live DNS on every send — the write-time
    // check in the route is fast feedback, not the boundary (see
    // assertSmtpHostSafe above). An OS-cached lookup costs microseconds next to
    // an SMTP round trip.
    if (this.tenantHost) await assertSmtpHostSafe(this.tenantHost);
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: message.to.email,
        subject: message.subject ?? '(no subject)',
        text: message.body,
        html: toHtmlBody(message),
        replyTo: message.replyTo,
        headers: message.headers,
      });
      return { providerMessageId: info.messageId ?? randomUUID() };
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      if (code && code >= 500 && code < 560 && code !== 552) {
        throw new PermanentError(`smtp rejected: ${code}`, err);
      }
      throw new TransientError(`smtp send failed: ${(err as Error).message}`, err);
    }
  }
}

export interface SendGridConfig {
  apiKey: string;
  from: string;
}

export class SendGridEmailProvider implements ChannelProvider {
  readonly id: string;
  readonly channel = 'email' as const;

  constructor(private readonly config: SendGridConfig, instanceId = 'sendgrid') {
    this.id = instanceId;
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    if (!message.to.email) {
      throw new PermanentError('subscriber has no email address');
    }
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to.email }] }],
        from: { email: this.config.from },
        ...(message.replyTo ? { reply_to: { email: message.replyTo } } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        subject: message.subject ?? '(no subject)',
        content: [
          { type: 'text/plain', value: message.body },
          ...(toHtmlBody(message)
            ? [{ type: 'text/html', value: toHtmlBody(message) }]
            : []),
        ],
      }),
    });
    if (res.status === 202) {
      return { providerMessageId: res.headers.get('x-message-id') ?? randomUUID() };
    }
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      throw new PermanentError(`sendgrid rejected (${res.status}): ${detail}`);
    }
    throw new TransientError(`sendgrid error (${res.status}): ${detail}`);
  }
}

export interface ResendConfig {
  apiKey: string;
  from: string;
}

export class ResendEmailProvider implements ChannelProvider {
  readonly id: string;
  readonly channel = 'email' as const;

  constructor(private readonly config: ResendConfig, instanceId = 'resend') {
    this.id = instanceId;
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    if (!message.to.email) {
      throw new PermanentError('subscriber has no email address');
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.from,
        to: [message.to.email],
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        subject: message.subject ?? '(no subject)',
        text: message.body,
        html: toHtmlBody(message),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (res.ok && body.id) {
      return { providerMessageId: body.id };
    }
    if (res.status === 401 || res.status === 403 || res.status === 422) {
      throw new PermanentError(`resend rejected (${res.status}): ${body.message ?? ''}`);
    }
    throw new TransientError(`resend error (${res.status}): ${body.message ?? ''}`);
  }
}

/** Fallback: logs the email instead of sending. Stands in for a second vendor. */
export class LogEmailProvider implements ChannelProvider {
  readonly id = 'email-log-fallback';
  readonly channel = 'email' as const;

  async send(message: RenderedMessage): Promise<SendResult> {
    logger.info(
      { to: message.to.email, subject: message.subject },
      '[email-log-fallback] email "sent"',
    );
    return { providerMessageId: `log_${randomUUID()}` };
  }
}
