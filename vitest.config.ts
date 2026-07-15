import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Once per run: flush the test redis db so bull:* keys can't accumulate
    // across runs (stale-key bloat was the root cause of the plan-card
    // timeout flakiness misdiagnosed as parallel contention).
    globalSetup: ['tests/global-setup.ts'],
    // Integration tests hit real Postgres/Redis; give them headroom.
    testTimeout: 15_000,
    hookTimeout: 20_000,
    // One file at a time keeps the shared DB/Redis state deterministic.
    fileParallelism: false,
  },
});
