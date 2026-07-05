import type { Channel } from '../shared/queues';

export interface RenderedMessage {
  messageId: string;
  tenantId: string;
  to: { email?: string; phone?: string; pushToken?: string; inAppSubscriberId?: string };
  subject?: string;
  body: string;
  /** Pre-rendered HTML (template emails). body is the plain-text fallback. */
  htmlBody?: string;
  /** When set (email channel), providers embed this 1px open-tracking image. */
  pixelUrl?: string;
}

export interface SendResult {
  providerMessageId: string;
}

/**
 * The single integration point for any delivery vendor. Adding a new
 * provider (SendGrid, Twilio, FCM, Slack, ...) means implementing this
 * interface and registering it in the channel's failover chain.
 *
 * Implementations must throw TransientError for retryable failures
 * (timeouts, 5xx, 429) and PermanentError for unretryable ones
 * (invalid address, rejected content).
 */
export interface ChannelProvider {
  readonly id: string;
  readonly channel: Channel;
  send(message: RenderedMessage): Promise<SendResult>;
}
