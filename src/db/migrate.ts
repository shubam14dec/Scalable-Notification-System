import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool';
import { logger } from '../shared/logger';
import { chEnabled, chMigrate } from '../analytics/clickhouse';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
  logger.info('postgres schema applied');

  if (chEnabled()) {
    try {
      await chMigrate();
      logger.info('clickhouse schema applied');
    } catch (err) {
      // Soft-fail: ClickHouse being down must not block the core system.
      logger.warn({ err: (err as Error).message }, 'clickhouse migration skipped');
    }
  }
  await pool.end();
}

main().catch((err) => {
  logger.error(err, 'migration failed');
  process.exit(1);
});
