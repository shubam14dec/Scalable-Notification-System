/**
 * Runs before every test file, ahead of its imports. Tests get Redis db 15
 * so a dev worker fleet running against db 0 can never consume the jobs a
 * test enqueues (that race made history-count assertions flaky) — and test
 * jobs can never leak into the real pipeline.
 */
process.env.REDIS_DB ??= '15';
