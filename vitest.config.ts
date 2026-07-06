import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests hit real Postgres/Redis; give them headroom.
    testTimeout: 15_000,
    hookTimeout: 20_000,
    // One file at a time keeps the shared DB/Redis state deterministic.
    fileParallelism: false,
  },
});
