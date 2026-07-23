/**
 * Runs before every test file, ahead of its imports. Tests get Redis db 15
 * so a dev worker fleet running against db 0 can never consume the jobs a
 * test enqueues (that race made history-count assertions flaky) — and test
 * jobs can never leak into the real pipeline.
 */
process.env.REDIS_DB ??= '15';

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
