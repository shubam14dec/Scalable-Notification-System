/**
 * Fires a burst of triggers at the API and watches the queues drain.
 *
 *   npm run loadtest              # 100 events (default)
 *   npm run loadtest -- 500       # 500 events
 *
 * Priority mix: 10% p0, 60% p1, 30% p2 — check /ops/queues while it runs
 * to watch the tiers drain at different rates.
 */
const BASE = process.env.API_URL ?? 'http://localhost:3000';
const API_KEY = process.env.API_KEY ?? 'dev-api-key-123';

const total = Number.parseInt(process.argv[2] ?? '100', 10);

function pickPriority(i: number): 'p0' | 'p1' | 'p2' {
  const r = i % 10;
  if (r === 0) return 'p0';
  if (r <= 6) return 'p1';
  return 'p2';
}

async function trigger(i: number): Promise<{ status: number; overflow: boolean }> {
  const res = await fetch(`${BASE}/v1/events/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      workflowKey: 'welcome',
      priority: pickPriority(i),
      transactionId: `loadtest-${Date.now()}-${i}`,
      payload: { name: `User ${i}`, company: 'Acme' },
      to: [
        { subscriberId: `lt-${i}-a`, email: `lt-${i}-a@example.com`, phone: `+1555${String(i).padStart(7, '0')}` },
        { subscriberId: `lt-${i}-b`, email: `lt-${i}-b@example.com` },
      ],
    }),
  });
  const parsed = res.status === 202 ? ((await res.json()) as { overflow?: boolean }) : {};
  return { status: res.status, overflow: parsed.overflow === true };
}

async function queuesDrained(): Promise<{ drained: boolean; backlog: number }> {
  const res = await fetch(`${BASE}/ops/queues`);
  const depths = (await res.json()) as Record<string, Record<string, number>>;
  let backlog = 0;
  for (const [name, counts] of Object.entries(depths)) {
    if (name === 'dead-letter') continue;
    backlog += (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  }
  return { drained: backlog === 0, backlog };
}

async function main() {
  console.log(`firing ${total} triggers at ${BASE} ...`);
  const started = Date.now();

  const results = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      trigger(i).catch(() => ({ status: 0, overflow: false })),
    ),
  );
  const accepted = results.filter((r) => r.status === 202).length;
  const overflowed = results.filter((r) => r.overflow).length;
  const throttled = results.filter((r) => r.status === 429).length;
  const acceptMs = Date.now() - started;

  console.log(
    `accepted ${accepted}/${total} (direct: ${accepted - overflowed}, ` +
      `overflow-diverted: ${overflowed}, hard 429s: ${throttled}) in ${acceptMs}ms`,
  );

  process.stdout.write('waiting for queues to drain ');
  for (let i = 0; i < 120; i++) {
    const { drained, backlog } = await queuesDrained();
    if (drained) {
      console.log(`\nall queues drained in ${((Date.now() - started) / 1000).toFixed(1)}s total`);
      return;
    }
    process.stdout.write(`. `);
    if (i % 10 === 9) process.stdout.write(`[backlog ${backlog}] `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('\ntimed out waiting for drain — check /ops/queues and the DLQ');
}

main().catch((err) => {
  console.error('loadtest failed:', err);
  process.exit(1);
});
