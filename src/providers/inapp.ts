import { PermanentError } from '../shared/errors';
import { redis } from '../shared/redis';
import { getQueue, QUEUE } from '../shared/queues';
import type { ChannelProvider, RenderedMessage, SendResult } from './types';

export function inAppPubSubChannel(tenantId: string, subscriberExternalId: string): string {
  return `inapp:${tenantId}:${subscriberExternalId}`;
}

/**
 * In-app is an internal channel: the message row in Postgres IS the inbox
 * (durable — offline subscribers see it on next fetch), and delivery here
 * just pushes it live over Redis pub/sub to whichever WebSocket gateway
 * node holds the subscriber's sockets.
 *
 * PUBLISH returns the number of connected listeners: > 0 means a gateway
 * pushed it to a live socket, so we feed a 'delivered' receipt through the
 * same status queue that provider webhooks use. 0 means the subscriber is
 * offline and the message simply waits in the inbox as 'sent'.
 */
export class InAppProvider implements ChannelProvider {
  readonly id = 'inapp';
  readonly channel = 'inapp' as const;

  async send(message: RenderedMessage): Promise<SendResult> {
    const subscriberId = message.to.inAppSubscriberId;
    if (!subscriberId) {
      throw new PermanentError('in-app message has no subscriber id');
    }

    const providerMessageId = `inapp_${message.messageId}`;
    const receivers = await redis.publish(
      inAppPubSubChannel(message.tenantId, subscriberId),
      JSON.stringify({
        type: 'notification',
        message: {
          id: message.messageId,
          subject: message.subject ?? null,
          body: message.body,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    if (receivers > 0) {
      await getQueue(QUEUE.STATUS).add(
        'status',
        { provider: this.id, providerMessageId, status: 'delivered' },
        { attempts: 5 },
      );
    }

    return { providerMessageId };
  }
}
