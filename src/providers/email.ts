import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { PermanentError, TransientError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { ChannelProvider, RenderedMessage, SendResult } from './types';

/** Primary: real SMTP (points at Mailpit locally, any relay in production). */
export class SmtpEmailProvider implements ChannelProvider {
  readonly id = 'smtp';
  readonly channel = 'email' as const;

  private transport = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: false,
    pool: true,
    maxConnections: 10,
  });

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
        from: env.smtpFrom,
        to: message.to.email,
        subject: message.subject ?? '(no subject)',
        text: message.body,
      });
      return { providerMessageId: info.messageId ?? randomUUID() };
    } catch (err) {
      // SMTP 5xx permanent codes (550 bad mailbox etc.) vs everything else.
      const code = (err as { responseCode?: number }).responseCode;
      if (code && code >= 500 && code < 560 && code !== 552) {
        throw new PermanentError(`smtp rejected: ${code}`, err);
      }
      throw new TransientError(`smtp send failed: ${(err as Error).message}`, err);
    }
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
