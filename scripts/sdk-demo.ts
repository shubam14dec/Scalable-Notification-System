/**
 * Exercises @asyncify-hq/node against the local API — the exact code a
 * customer's backend would run.
 *
 *   $env:API_KEY='nk_dev_...'; npx tsx scripts/sdk-demo.ts
 */
import { AsyncifyClient } from '../packages/sdk-node/src/index';

const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('set API_KEY first');
  process.exit(1);
}

const asyncify = new AsyncifyClient({ apiKey, baseUrl: 'http://localhost:3000' });

async function main() {
  const result = await asyncify.trigger('order-shipped', {
    to: [{ subscriberId: 'sdk-user-1', email: 'sdk-user-1@example.com' }],
    payload: { name: 'SDK User', orderId: 'ORD-SDK-1', carrier: 'BlueDart', eta: 'Wednesday' },
  });
  console.log('trigger →', result);

  const dup = await asyncify.trigger('order-shipped', {
    to: [{ subscriberId: 'sdk-user-1', email: 'sdk-user-1@example.com' }],
    payload: { name: 'SDK User', orderId: 'ORD-SDK-1', carrier: 'BlueDart', eta: 'Wednesday' },
    transactionId: result.transactionId,
  });
  console.log('same transactionId again →', dup);

  const { token, expiresAt } = await asyncify.subscriberToken('sdk-user-1');
  console.log('subscriber token →', token.slice(0, 24) + '...', 'expires', new Date(expiresAt * 1000).toISOString());

  await new Promise((r) => setTimeout(r, 3000));
  const status = await asyncify.events.get(result.transactionId);
  console.log('delivery status →', status.messages);
}

main().catch((err) => {
  console.error('sdk demo failed:', err);
  process.exit(1);
});
