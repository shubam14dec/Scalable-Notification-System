import { randomUUID } from 'node:crypto';
import { PermanentError, TransientError } from '../shared/errors';
import { logger } from '../shared/logger';
import { addSuppression } from '../db/repositories';
import type { ChannelProvider, RenderedMessage, SendResult } from './types';

export interface FcmConfig {
  /** Firebase service-account JSON, as a string. */
  serviceAccountJson: string;
}

/**
 * Firebase Cloud Messaging (HTTP v1 via firebase-admin) — reaches both
 * Android and iOS (FCM relays to APNs). Dead device tokens
 * (registration-token-not-registered) are auto-suppressed, the push
 * equivalent of email bounce suppression.
 */
export class FcmPushProvider implements ChannelProvider {
  readonly id: string;
  readonly channel = 'push' as const;
  private messagingPromise: Promise<import('firebase-admin/messaging').Messaging> | null = null;

  constructor(private readonly config: FcmConfig, instanceId = 'fcm') {
    this.id = instanceId;
  }

  private async messaging() {
    if (!this.messagingPromise) {
      this.messagingPromise = (async () => {
        const { initializeApp, getApps, getApp, cert } = await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');
        const appName = `fcm-${this.id}`;
        const app = getApps().some((a) => a.name === appName)
          ? getApp(appName)
          : initializeApp(
              { credential: cert(JSON.parse(this.config.serviceAccountJson)) },
              appName,
            );
        return getMessaging(app);
      })();
    }
    return this.messagingPromise;
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    const token = message.to.pushToken;
    if (!token) {
      throw new PermanentError('subscriber has no push token');
    }
    try {
      const messaging = await this.messaging();
      const id = await messaging.send({
        token,
        notification: {
          title: message.subject ?? 'Notification',
          body: message.body,
        },
      });
      return { providerMessageId: id };
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        // Dead token: suppress it so future fan-outs skip this device.
        await addSuppression(message.tenantId, 'push', token, 'invalid-token').catch(
          () => undefined,
        );
        throw new PermanentError(`fcm: dead device token (${code})`);
      }
      if (code === 'messaging/invalid-argument' || code === 'app/invalid-credential') {
        throw new PermanentError(`fcm rejected: ${code}`);
      }
      throw new TransientError(`fcm error: ${code || (err as Error).message}`, err);
    }
  }
}

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
