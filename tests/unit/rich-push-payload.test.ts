/**
 * FcmPushProvider payload mapping (Phase 20). buildFcmMessage is internal, so
 * we exercise it through send() with a stubbed firebase-admin messaging client
 * (same stub shape push-multidevice.test.ts uses) and capture the exact Message
 * handed to messaging.send(). Two shapes: rich extras present (every block
 * populated, clickUrl mirrored into data) vs. absent (notification only, no
 * data/webpush/android/apns blocks — FCM rejects empty fields).
 */
import { describe, expect, test } from 'vitest';
import type { Message } from 'firebase-admin/messaging';
import { FcmPushProvider } from '../../src/providers/push';
import type { RenderedMessage } from '../../src/providers/types';

/** A provider whose lazily-initialised messaging client is stubbed to capture
 * the payload and never touch real Firebase. */
function providerCapturing(sink: { sent?: Message }) {
  const provider = new FcmPushProvider({ serviceAccountJson: '{}' }, 'itest-payload');
  (provider as unknown as { messagingPromise: Promise<unknown> }).messagingPromise = Promise.resolve({
    send: async (msg: Message) => {
      sink.sent = msg;
      return 'projects/x/messages/fake-id';
    },
  });
  return provider;
}

describe('rich push payload mapping', () => {
  test('a message WITH push extras populates data (clickUrl mirrored), webpush, android + apns image', async () => {
    const sink: { sent?: Message } = {};
    const provider = providerCapturing(sink);
    const message: RenderedMessage = {
      messageId: 'm-rich',
      tenantId: 't1',
      to: { pushToken: 'tok-rich' },
      subject: 'Order shipped',
      body: 'Your order is on its way',
      push: {
        clickUrl: 'https://example.com/orders/A123',
        imageUrl: 'https://example.com/img.png',
        data: { orderId: 'A123', kind: 'promo' },
      },
    };

    const res = await provider.send(message);
    expect(res.providerMessageId).toBe('projects/x/messages/fake-id');

    const sent = sink.sent as Message & Record<string, unknown>;
    // notification always present.
    expect((sent as { notification?: unknown }).notification).toEqual({
      title: 'Order shipped',
      body: 'Your order is on its way',
    });
    // data carries the caller's data AND clickUrl mirrored in for native apps.
    expect(sent.data).toEqual({ orderId: 'A123', kind: 'promo', clickUrl: 'https://example.com/orders/A123' });
    // webpush: tap link + large image.
    expect(sent.webpush).toEqual({
      fcmOptions: { link: 'https://example.com/orders/A123' },
      notification: { image: 'https://example.com/img.png' },
    });
    // android + apns carry the image under their own field names.
    expect(sent.android).toEqual({ notification: { imageUrl: 'https://example.com/img.png' } });
    expect(sent.apns).toEqual({ fcmOptions: { imageUrl: 'https://example.com/img.png' } });
  });

  test('a message WITHOUT push extras is notification-only (no data/webpush/android/apns)', async () => {
    const sink: { sent?: Message } = {};
    const provider = providerCapturing(sink);
    const message: RenderedMessage = {
      messageId: 'm-plain',
      tenantId: 't1',
      to: { pushToken: 'tok-plain' },
      subject: 'Hi',
      body: 'plain body',
    };

    await provider.send(message);
    const sent = sink.sent as Message & Record<string, unknown>;
    expect((sent as { notification?: unknown }).notification).toEqual({ title: 'Hi', body: 'plain body' });
    expect(sent.data).toBeUndefined();
    expect(sent.webpush).toBeUndefined();
    expect(sent.android).toBeUndefined();
    expect(sent.apns).toBeUndefined();
  });
});
