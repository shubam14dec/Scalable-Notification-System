/**
 * Runs before every test file, ahead of its imports. Tests get Redis db 15
 * so a dev worker fleet running against db 0 can never consume the jobs a
 * test enqueues (that race made history-count assertions flaky) — and test
 * jobs can never leak into the real pipeline.
 *
 * The two imports below are hoisted above the env pins, as ESM imports
 * always are. That is safe ONLY because neither reads our configuration:
 * `vitest` registers hooks and `ioredis` takes its connection details as
 * call arguments. Never import anything from `src/` here — src/config/env.ts
 * snapshots process.env at module load, which is exactly what these pins
 * exist to get in front of.
 */
import { beforeAll } from 'vitest';
import { Redis } from 'ioredis';

process.env.REDIS_DB ??= '15';
// The suite's baseline is OPEN signup (the default) — most files sign a
// tenant up in a helper, and a dev .env carrying SIGNUP_MODE=invite (as this
// machine does since B1) would otherwise 403 sixty-plus percent of the suite.
// Invite-mode tests flip process.env per-test with restore, same as ever.
process.env.SIGNUP_MODE = 'open';

// Pin PUBLIC_URL: dotenv never overrides pre-set vars, so tests stay
// hermetic even when .env points at a live tunnel for manual E2E.
process.env.PUBLIC_URL = 'http://localhost:3000';

// Integration tests run their bridge stubs on localhost — exempt it from
// the SSRF guard exactly the way local dev does (same code path, config
// decides; prod leaves this empty).
process.env.OUTBOUND_URL_ALLOW = 'localhost,127.0.0.1';

// Phase 23: vector-store.ts captures the Pinecone CONTROL-plane URL in a
// module-load const (`process.env.PINECONE_CONTROL_URL ?? api.pinecone.io`),
// so a knowledge test's in-process fake control plane must be reachable at a
// URL known BEFORE any import runs — hence a fixed loopback port pinned here
// (fileParallelism is off, so at most one Pinecone-using file binds it at a
// time). Only vector-store.ts reads this; other suites never dial it.
process.env.PINECONE_CONTROL_URL ??= 'http://127.0.0.1:51733';

/**
 * S1.2: every test file injects from the same "IP" (127.0.0.1), so the
 * per-IP abuse brakes (src/api/rate-limit.ts) see the WHOLE SUITE as one
 * client — dozens of files each signing up a fresh org would blow the
 * 3/min signup budget by the fourth file and cascade from there. Clearing
 * the `*-rl:*` minute buckets before each file gives every file its own
 * budget, which is what a real deployment sees (one client, one signup),
 * while the production limiter still runs inside each file.
 *
 * A throwaway connection, quit immediately — the same idiom as
 * global-setup.ts — so unit files that never touch Redis don't inherit an
 * open handle from the shared singleton.
 */
beforeAll(async () => {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    db: Number(process.env.REDIS_DB ?? 15),
    lazyConnect: true,
  });
  await redis.connect();
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});
