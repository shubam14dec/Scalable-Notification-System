import { randomUUID } from 'node:crypto';
import { PermanentError, TransientError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { ChannelProvider, RenderedMessage, SendResult } from './types';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

export class TwilioSmsProvider implements ChannelProvider {
  readonly id: string;
  readonly channel = 'sms' as const;

  constructor(private readonly config: TwilioConfig, instanceId = 'twilio') {
    this.id = instanceId;
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    if (!message.to.phone) {
      throw new PermanentError('subscriber has no phone number');
    }
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString(
      'base64',
    );
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: message.to.phone,
          From: this.config.from,
          Body: message.body,
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      sid?: string;
      code?: number;
      message?: string;
    };
    if (res.ok && body.sid) {
      return { providerMessageId: body.sid };
    }
    // 21211 invalid number, 21610 unsubscribed — sender's data, not transient.
    if (res.status === 400 || res.status === 401 || body.code === 21211 || body.code === 21610) {
      throw new PermanentError(`twilio rejected (${body.code ?? res.status}): ${body.message ?? ''}`);
    }
    throw new TransientError(`twilio error (${res.status}): ${body.message ?? ''}`);
  }
}

/**
 * Mock SMS vendor — logs instead of calling Twilio/MSG91. Swap the body of
 * send() for a real HTTP call; keep the error taxonomy (TransientError for
 * 429/5xx/timeouts, PermanentError for invalid numbers).
 */
export class MockSmsProvider implements ChannelProvider {
  readonly id = 'sms-mock';
  readonly channel = 'sms' as const;

  async send(message: RenderedMessage): Promise<SendResult> {
    if (!message.to.phone) {
      throw new PermanentError('subscriber has no phone number');
    }
    logger.info({ to: message.to.phone, body: message.body }, '[sms-mock] sms "sent"');
    return { providerMessageId: `sms_${randomUUID()}` };
  }
}
