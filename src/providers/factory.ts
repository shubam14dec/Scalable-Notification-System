import { z } from 'zod';
import type { Channel } from '../shared/queues';
import { openSecret } from '../auth/secret-box';
import type { IntegrationRow } from '../db/integrations.repo';
import {
  ResendEmailProvider,
  SendGridEmailProvider,
  SmtpEmailProvider,
} from './email';
import { TwilioSmsProvider } from './sms';
import { FcmPushProvider } from './push';
import type { ChannelProvider } from './types';

/**
 * Catalog of installable providers: credential schema (validated on
 * create/update, so bad configs are rejected at the door, not at send time)
 * plus a builder. Adding a vendor = one entry here + one provider class.
 */
export const PROVIDER_CATALOG: Record<
  string,
  { channel: Channel; schema: z.ZodTypeAny; build: (creds: never, instanceId: string) => ChannelProvider }
> = {
  smtp: {
    channel: 'email',
    schema: z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      from: z.string().email(),
      user: z.string().optional(),
      pass: z.string().optional(),
      secure: z.boolean().optional(),
    }),
    build: (creds, id) => new SmtpEmailProvider(creds, id),
  },
  sendgrid: {
    channel: 'email',
    schema: z.object({ apiKey: z.string().min(10), from: z.string().email() }),
    build: (creds, id) => new SendGridEmailProvider(creds, id),
  },
  resend: {
    channel: 'email',
    schema: z.object({ apiKey: z.string().min(10), from: z.string().min(3) }),
    build: (creds, id) => new ResendEmailProvider(creds, id),
  },
  twilio: {
    channel: 'sms',
    schema: z.object({
      accountSid: z.string().startsWith('AC'),
      authToken: z.string().min(10),
      from: z.string().min(3),
    }),
    build: (creds, id) => new TwilioSmsProvider(creds, id),
  },
  fcm: {
    channel: 'push',
    schema: z.object({
      serviceAccountJson: z.string().refine((s) => {
        try {
          const parsed = JSON.parse(s);
          return typeof parsed.project_id === 'string' && typeof parsed.private_key === 'string';
        } catch {
          return false;
        }
      }, 'must be a Firebase service-account JSON string'),
    }),
    build: (creds, id) => new FcmPushProvider(creds, id),
  },
};

export function validateCredentials(
  provider: string,
  channel: Channel,
  credentials: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const entry = PROVIDER_CATALOG[provider];
  if (!entry) return { ok: false, error: `unknown provider "${provider}"` };
  if (entry.channel !== channel) {
    return { ok: false, error: `provider "${provider}" is a ${entry.channel} provider` };
  }
  const parsed = entry.schema.safeParse(credentials);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, value: parsed.data };
}

// Instances are cached by integration id + updated_at, so credential updates
// produce fresh instances while unchanged ones keep warm connections
// (SMTP pools, FCM apps).
const instances = new Map<string, ChannelProvider>();

export function buildProviderFromIntegration(row: IntegrationRow): ChannelProvider {
  const cacheKey = `${row.id}:${row.updated_at}`;
  let provider = instances.get(cacheKey);
  if (!provider) {
    const entry = PROVIDER_CATALOG[row.provider];
    if (!entry) throw new Error(`unknown provider "${row.provider}"`);
    const creds = JSON.parse(openSecret(row.credentials));
    provider = entry.build(creds as never, `${row.provider}:${row.id.slice(0, 8)}`);
    instances.set(cacheKey, provider);
  }
  return provider;
}
