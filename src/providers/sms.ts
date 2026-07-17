import { randomUUID } from 'node:crypto';
import { getPublicUrl } from '../config/public-url';
import { addSuppression } from '../db/repositories';
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
    const params = new URLSearchParams({
      To: message.to.phone,
      From: this.config.from,
      Body: message.body,
    });
    // Ask Twilio to POST delivery receipts back so Activity can advance
    // sent -> delivered/failed. The callback URL rides the RUNTIME public-url
    // (getPublicUrl), so it is tunnel-rotation safe for NEW sends. Callbacks
    // for messages sent on a since-dead tunnel are lost — acceptable: receipts
    // are best-effort and the send itself already succeeded. Only attach when
    // we have a real http(s) base URL (never point Twilio at a bad value).
    const publicUrl = await getPublicUrl();
    if (/^https?:\/\//.test(publicUrl)) {
      params.set('StatusCallback', `${publicUrl}/webhooks/sms/twilio/${message.messageId}`);
    }
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: params,
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
      // 21610 = recipient texted STOP. Suppress so future fan-outs never
      // re-attempt this number (best-effort backstop; the async STATUS
      // callback also suppresses on ErrorCode 21610). 21211 is a bad number
      // in the sender's data entry, not a recipient opt-out — no suppression.
      if (body.code === 21610 && message.to.phone) {
        await addSuppression(message.tenantId, 'sms', message.to.phone, 'stop').catch(
          () => undefined,
        );
      }
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
