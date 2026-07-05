import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { PermanentError, TransientError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { ChannelProvider, RenderedMessage, SendResult } from './types';

export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  user?: string;
  pass?: string;
  secure?: boolean;
}

/** SMTP — the env-configured default, or a per-tenant integration. */
export class SmtpEmailProvider implements ChannelProvider {
  readonly id: string;
  readonly channel = 'email' as const;
  private readonly from: string;
  private transport: nodemailer.Transporter;

  constructor(config?: SmtpConfig, instanceId = 'smtp') {
    this.id = instanceId;
    const cfg = config ?? {
      host: env.smtpHost,
      port: env.smtpPort,
      from: env.smtpFrom,
    };
    this.from = cfg.from;
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
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: message.to.email,
        subject: message.subject ?? '(no subject)',
        text: message.body,
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
        subject: message.subject ?? '(no subject)',
        content: [{ type: 'text/plain', value: message.body }],
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
        subject: message.subject ?? '(no subject)',
        text: message.body,
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
