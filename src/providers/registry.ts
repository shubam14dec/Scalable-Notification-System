import type { Channel } from '../shared/queues';
import { PermanentError, TransientError } from '../shared/errors';
import { breakerFor } from '../resilience/circuit-breaker';
import { logger } from '../shared/logger';
import { integrationsForChannel } from '../db/integrations.repo';
import { buildProviderFromIntegration } from './factory';
import { SmtpEmailProvider, LogEmailProvider } from './email';
import { MockSmsProvider } from './sms';
import { MockPushProvider } from './push';
import { InAppProvider } from './inapp';
import type { ChannelProvider, RenderedMessage } from './types';

/**
 * Default chains, used when a tenant has configured no integrations for a
 * channel — env-configured SMTP for email, mocks for sms/push, and the
 * internal in-app provider (in-app never needs an integration).
 */
const defaults: Record<Channel, ChannelProvider[]> = {
  email: [new SmtpEmailProvider(), new LogEmailProvider()],
  sms: [new MockSmsProvider()],
  push: [new MockPushProvider()],
  inapp: [new InAppProvider()],
};

// Per tenant+channel chain cache. Short TTL instead of cross-process
// invalidation: a credential change is live everywhere within 30s.
const CHAIN_TTL_MS = 30_000;
const chains = new Map<string, { providers: ChannelProvider[]; expiresAt: number }>();

async function chainFor(tenantId: string, channel: Channel): Promise<ChannelProvider[]> {
  if (channel === 'inapp') return defaults.inapp;

  const key = `${tenantId}:${channel}`;
  const hit = chains.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.providers;

  const integrations = await integrationsForChannel(tenantId, channel);
  let providers: ChannelProvider[];
  if (integrations.length === 0) {
    providers = defaults[channel];
  } else {
    providers = [];
    for (const row of integrations) {
      try {
        providers.push(buildProviderFromIntegration(row));
      } catch (err) {
        logger.error({ err, integrationId: row.id }, 'skipping unbuildable integration');
      }
    }
    if (providers.length === 0) providers = defaults[channel];
  }
  chains.set(key, { providers, expiresAt: Date.now() + CHAIN_TTL_MS });
  return providers;
}

/** Same-process cache bust after integration mutations (workers refresh via TTL). */
export function invalidateChain(tenantId: string, channel: Channel): void {
  chains.delete(`${tenantId}:${channel}`);
}

export interface DeliveryResult {
  provider: string;
  providerMessageId: string;
}

/**
 * Try each provider in the tenant's chain, skipping any whose breaker is
 * open.
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
  const chain = await chainFor(message.tenantId, channel);
  let lastError: unknown = new TransientError(`no providers configured for ${channel}`);

  for (const provider of chain) {
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
