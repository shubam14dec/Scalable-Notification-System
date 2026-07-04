/**
 * GitHub-style workload simulator: a sustained stream of independent events,
 * each with a TINY recipient list (a "PR merged" thread: 2-8 subscribers),
 * plus a P0 "OTP" fired every 5s to prove transactional latency is
 * unaffected while the stream runs.
 *
 *   npx tsx scripts/github-sim.ts [durationSec=30] [eventsPerSec=20]
 *
 * Reports, from DB timestamps (API accept -> last message sent):
 * p50/p95/p99/max end-to-end latency per event, separately for the stream
 * and for the P0 OTPs.
 */
import { pool } from '../src/db/pool';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
const API_KEY = process.env.API_KEY ?? 'dev-api-key-123';
const HEADERS = { 'content-type': 'application/json', 'x-api-key': API_KEY };

const durationSec = Number.parseInt(process.argv[2] ?? '30', 10);
const eventsPerSec = Number.parseInt(process.argv[3] ?? '20', 10);
const runId = Date.now().toString(36);

const USER_POOL = 500;

function prRecipients(): unknown[] {
  const n = 2 + Math.floor(Math.random() * 7); // 2-8 watchers per PR
  const picked = new Set<number>();
  while (picked.size < n) picked.add(Math.floor(Math.random() * USER_POOL));
  return [...picked].map((u) => ({
    subscriberId: `gh-user-${u}`,
    email: `gh-user-${u}@example.com`,
  }));
}

async function put(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
}

async function trigger(body: unknown): Promise<number> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/events/trigger`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (res.status !== 202) throw new Error(`trigger -> ${res.status}`);
  return Date.now() - t0;
}

async function firePr(i: number): Promise<number> {
  return trigger({
    workflowKey: 'pr-merged',
    priority: 'p1',
    transactionId: `ghsim-${runId}-${i}`,
    payload: { repo: 'acme/api', pr: `#${1000 + i}`, author: `dev${i % 40}` },
    to: prRecipients(),
  });
}

async function fireOtp(i: number): Promise<number> {
  return trigger({
    workflowKey: 'otp',
    priority: 'p0',
    transactionId: `ghotp-${runId}-${i}`,
    payload: { code: String(100000 + i), company: 'Acme' },
    to: [{ subscriberId: 'gh-otp-user', phone: '+15559990000' }],
  });
}

async function backlogNow(): Promise<number> {
  const res = await fetch(`${BASE}/ops/queues`);
  const depths = (await res.json()) as Record<string, Record<string, number>>;
  let total = 0;
  for (const [name, c] of Object.entries(depths)) {
    if (name === 'dead-letter') continue;
    total += (c.waiting ?? 0) + (c.active ?? 0);
  }
  return total;
}

async function latencyStats(prefix: string) {
  const { rows } = await pool.query(
    `select count(*)::int as events,
            round(percentile_cont(0.5) within group (order by lat)::numeric, 3)  as p50,
            round(percentile_cont(0.95) within group (order by lat)::numeric, 3) as p95,
            round(percentile_cont(0.99) within group (order by lat)::numeric, 3) as p99,
            round(max(lat)::numeric, 3) as max
     from (
       select extract(epoch from (max(m.updated_at) - e.created_at)) as lat
       from events e
       join messages m on m.event_id = e.id
       where e.transaction_id like $1 and m.status in ('sent','delivered')
       group by e.id
     ) t`,
    [`${prefix}-${runId}-%`],
  );
  return rows[0];
}

async function main() {
  await put('/v1/workflows', {
    key: 'pr-merged',
    name: 'PR merged',
    steps: [
      {
        channel: 'email',
        subject: '[{{repo}}] PR {{pr}} was merged',
        body: '{{author}} merged pull request {{pr}} into main.',
      },
      { channel: 'inapp', subject: 'PR {{pr}} merged', body: '{{author}} merged {{pr}}.' },
    ],
  });

  const totalEvents = durationSec * eventsPerSec;
  console.log(
    `simulating ${eventsPerSec} PR-merge events/sec for ${durationSec}s ` +
      `(${totalEvents} events, 2-8 recipients each) + one P0 OTP every 5s\n`,
  );

  const pending: Promise<number>[] = [];
  const started = Date.now();
  let fired = 0;
  let otps = 0;

  while (Date.now() - started < durationSec * 1000) {
    const tickStart = Date.now();
    for (let j = 0; j < eventsPerSec; j++) {
      pending.push(firePr(fired++));
    }
    if (Math.floor((tickStart - started) / 5000) >= otps) {
      pending.push(fireOtp(otps++));
    }
    const elapsedThisSecond = Date.now() - tickStart;
    if ((tickStart - started) % 5000 < 1000) {
      console.log(
        `  t+${Math.round((tickStart - started) / 1000)}s  fired=${fired}  ` +
          `queue backlog=${await backlogNow()}`,
      );
    }
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - elapsedThisSecond)));
  }

  const acceptLats = await Promise.all(pending);
  acceptLats.sort((a, b) => a - b);
  console.log(
    `\nall ${fired} PR events + ${otps} OTPs accepted; ` +
      `API accept p50=${acceptLats[Math.floor(acceptLats.length * 0.5)]}ms ` +
      `p95=${acceptLats[Math.floor(acceptLats.length * 0.95)]}ms`,
  );

  process.stdout.write('waiting for queues to drain ');
  for (let i = 0; i < 60; i++) {
    if ((await backlogNow()) === 0) break;
    process.stdout.write('. ');
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('drained.\n');

  const pr = await latencyStats('ghsim');
  const otp = await latencyStats('ghotp');
  console.log('end-to-end latency, API accept -> message sent (seconds):');
  console.log(
    `  PR-merge stream (p1): events=${pr.events}  p50=${pr.p50}s  p95=${pr.p95}s  p99=${pr.p99}s  max=${pr.max}s`,
  );
  console.log(
    `  OTPs during load (p0): events=${otp.events}  p50=${otp.p50}s  p95=${otp.p95}s  p99=${otp.p99}s  max=${otp.max}s`,
  );

  const { rows } = await pool.query(
    `select m.status, count(*)::int from messages m
     join events e on e.id = m.event_id
     where e.transaction_id like $1 group by m.status`,
    [`ghsim-${runId}-%`],
  );
  console.log(`  message outcomes: ${rows.map((r) => `${r.status}=${r.count}`).join(', ')}`);

  await pool.end();
}

main().catch((err) => {
  console.error('github-sim failed:', err);
  process.exit(1);
});
