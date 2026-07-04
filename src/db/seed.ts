import { pool } from './pool';
import { upsertWorkflow, upsertSubscriber } from './repositories';
import { logger } from '../shared/logger';

const API_KEY = 'dev-api-key-123';

async function main() {
  const { rows } = await pool.query(
    `insert into tenants (name, api_key, rate_limit_per_sec)
     values ('Dev Tenant', $1, 100)
     on conflict (api_key) do update set name = excluded.name
     returning *`,
    [API_KEY],
  );
  const tenant = rows[0];
  logger.info({ tenantId: tenant.id, apiKey: API_KEY }, 'tenant ready');

  await upsertWorkflow(tenant.id, 'welcome', 'Welcome flow', [
    {
      channel: 'email',
      subject: 'Welcome, {{name}}!',
      body: 'Hi {{name}}, thanks for joining {{company}}. Your account is ready.',
    },
    { channel: 'sms', body: 'Hi {{name}}! Welcome to {{company}}.' },
    {
      channel: 'inapp',
      subject: 'Welcome aboard, {{name}}!',
      body: 'Your {{company}} account is ready. Take the tour to get started.',
    },
  ]);

  await upsertWorkflow(tenant.id, 'otp', 'One-time password', [
    { channel: 'sms', body: 'Your {{company}} verification code is {{code}}.' },
  ]);

  // Digest demo: N events inside a 15s window become ONE message per channel.
  await upsertWorkflow(tenant.id, 'activity-digest', 'Activity digest', [
    {
      channel: 'inapp',
      subject: '{{digest_count}} new activities',
      body: 'While you were away:\n{{digest_items}}',
      digest: { windowSeconds: 15, itemTemplate: '- {{actor}} {{action}}' },
    },
    {
      channel: 'email',
      subject: 'Your activity digest ({{digest_count}} updates)',
      body: 'Here is what happened:\n{{digest_items}}',
      digest: { windowSeconds: 15, itemTemplate: '- {{actor}} {{action}}' },
    },
  ]);

  for (const s of [
    { subscriberId: 'alice', email: 'alice@example.com', phone: '+15550000001' },
    { subscriberId: 'bob', email: 'bob@example.com', phone: '+15550000002' },
    { subscriberId: 'carol', email: 'carol@example.com' },
  ]) {
    await upsertSubscriber(tenant.id, s);
  }

  logger.info(
    'seeded workflows (welcome, otp, activity-digest) and subscribers (alice, bob, carol)',
  );
  await pool.end();
}

main().catch((err) => {
  logger.error(err, 'seed failed');
  process.exit(1);
});
