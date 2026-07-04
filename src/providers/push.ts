import { randomUUID } from 'node:crypto';
import { PermanentError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { ChannelProvider, RenderedMessage, SendResult } from './types';

/** Mock push vendor — stands in for FCM/APNs. */
export class MockPushProvider implements ChannelProvider {
  readonly id = 'push-mock';
  readonly channel = 'push' as const;

  async send(message: RenderedMessage): Promise<SendResult> {
    if (!message.to.pushToken) {
      throw new PermanentError('subscriber has no push token');
    }
    logger.info({ token: message.to.pushToken, body: message.body }, '[push-mock] push "sent"');
    return { providerMessageId: `push_${randomUUID()}` };
  }
}
