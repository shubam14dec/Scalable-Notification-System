import type { Channel } from '../shared/queues';
import { PermanentError, TransientError } from '../shared/errors';
import { breakerFor } from '../resilience/circuit-breaker';
import { logger } from '../shared/logger';
import { SmtpEmailProvider, LogEmailProvider } from './email';
import { MockSmsProvider } from './sms';
import { MockPushProvider } from './push';
import { InAppProvider } from './inapp';
import type { ChannelProvider, RenderedMessage } from './types';

/**
 * Ordered failover chain per channel: the first provider is primary, the
 * rest are fallbacks tried in order when the primary fails or its circuit
 * breaker is open.
 */
const chains: Record<Channel, ChannelProvider[]> = {
  email: [new SmtpEmailProvider(), new LogEmailProvider()],
  sms: [new MockSmsProvider()],
  push: [new MockPushProvider()],
  inapp: [new InAppProvider()],
};

export interface DeliveryResult {
  provider: string;
  providerMessageId: string;
}

/**
 * Try each provider in the chain, skipping any whose breaker is open.
 *
 * - PermanentError (bad address, rejected content) aborts immediately —
 *   no other provider can fix a bad address, and retrying is pointless.
 * - TransientError moves on to the next provider; if the whole chain
 *   fails, a TransientError is thrown so BullMQ retries the job with backoff.
 */
export async function sendWithFailover(
  channel: Channel,
  message: RenderedMessage,
): Promise<DeliveryResult> {
  let lastError: unknown = new TransientError(`no providers configured for ${channel}`);

  for (const provider of chains[channel]) {
    const breaker = breakerFor(provider.id);
    if (!breaker.canRequest()) {
      logger.warn({ provider: provider.id }, 'skipping provider: circuit open');
      continue;
    }
    try {
      const result = await provider.send(message);
      breaker.onSuccess();
      return { provider: provider.id, ...result };
    } catch (err) {
      if (err instanceof PermanentError) {
        // Not the provider's fault — don't trip the breaker, don't fail over.
        throw err;
      }
      breaker.onFailure();
      lastError = err;
      logger.warn(
        { provider: provider.id, err: (err as Error).message },
        'provider failed, trying next in chain',
      );
    }
  }

  throw new TransientError(
    `all ${channel} providers failed: ${(lastError as Error).message}`,
    lastError,
  );
}
