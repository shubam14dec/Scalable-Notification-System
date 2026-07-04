import { randomUUID } from 'node:crypto';
import { PermanentError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { ChannelProvider, RenderedMessage, SendResult } from './types';

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
