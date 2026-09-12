import { pool } from './pool';

/**
 * Slice S1.7 — THE REFRESH-TOKEN LEDGER.
 *
 * Every statement in here is written against the lifecycle documented beside
 * the table in schema.sql. The short version:
 *
 *   live    spent_at IS NULL AND revoked_at IS NULL AND expires_at > now()
 *   spent   exchanged for a successor that inherited its `family`
 *   revoked logout, logout-everywhere, or the theft alarm
 *   expired aged out on its own
 *
 * WHY POSTGRES AND NOT REDIS, given that Redis is right there and this is the
 * auth hot path: a session ledger that a `FLUSHALL` (or an evicted key, or a
 * restarted cache) can erase is a ledger that silently stops detecting theft
 * and silently forgets who was logged out. The cost of durability here is
 * negligible — a session touches this table about once every 15 minutes, and
 * every touch is addressed by primary key or by an index.
 */

export interface RefreshTokenRow {
  jti: string;
  user_id: string;
  family: string;
  issued_at: string;
  expires_at: string;
  spent_at: string | null;
  revoked_at: string | null;
}

/** Record a freshly minted refresh token. Called by `mintSessionTokens`. */
export async function insertRefreshToken(
  jti: string,
  userId: string,
  family: string,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `insert into refresh_tokens (jti, user_id, family, expires_at)
     values ($1, $2, $3, $4)`,
    [jti, userId, family, expiresAt],
  );
}

/**
 * THE ROTATION. One conditional UPDATE by primary key, and the `returning`
 * clause is the whole answer: a row means this caller is the one and only
 * holder of a live token and may have a successor; no row means the token was
 * already spent, or revoked, or expired, or never existed — and WHICH of those
 * is a separate question (`getRefreshToken` below) asked only on the sad path.
 *
 * Atomic by construction: two browsers presenting the same token both reach
 * this statement, Postgres serialises them on the row, and the predicate makes
 * the second one match nothing. There is no read-then-write window to lose.
 */
export async function spendRefreshToken(
  jti: string,
): Promise<{ user_id: string; family: string } | null> {
  const { rows } = await pool.query(
    `update refresh_tokens set spent_at = now()
      where jti = $1
        and spent_at is null
        and revoked_at is null
        and expires_at > now()
      returning user_id, family`,
    [jti],
  );
  return rows[0] ?? null;
}

/** The sad path's diagnosis: spent (when?), revoked, or expired. */
export async function getRefreshToken(jti: string): Promise<RefreshTokenRow | null> {
  const { rows } = await pool.query('select * from refresh_tokens where jti = $1', [jti]);
  return rows[0] ?? null;
}

/**
 * Kill one sign-in: every token descended from it, whatever hop the browser
 * had reached. Used by logout and by the theft alarm. Idempotent — a family
 * revoked twice reports 0 the second time, which is why the count is returned
 * rather than a boolean.
 */
export async function revokeFamily(family: string): Promise<number> {
  const { rowCount } = await pool.query(
    'update refresh_tokens set revoked_at = now() where family = $1 and revoked_at is null',
    [family],
  );
  return rowCount ?? 0;
}

/**
 * "Log out everywhere." Only the LIVE tokens are counted, because that count is
 * shown to a human: a session chain is a dozen spent rows and one live one, and
 * reporting "12 sessions ended" for one laptop would be a lie. Spent and
 * expired rows are already dead and need no revocation stamp.
 */
export async function revokeAllForUser(userId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `update refresh_tokens set revoked_at = now()
      where user_id = $1
        and spent_at is null
        and revoked_at is null
        and expires_at > now()`,
    [userId],
  );
  return rowCount ?? 0;
}

/**
 * GRANDFATHERING — adopt a pre-S1.7 refresh token into the ledger.
 *
 * Tokens minted before this slice carry no `jti` claim, so there is nothing to
 * look up and a strict reading would 401 every live dashboard session on
 * deploy. Instead the route derives a DETERMINISTIC jti from the token itself
 * (see `legacyJti` in routes/auth.ts) and calls this once; from the next line
 * onwards the token is an ordinary ledger entry and every rule — one-shot
 * rotation, the grace window, the theft alarm, revocation — applies to it
 * unchanged.
 *
 * `on conflict do nothing` is what makes the adoption SINGLE-USE, and that is
 * the entire security argument for doing this at all: the second presentation
 * of a legacy token inserts nothing, finds the spent row, and is judged exactly
 * like any other reuse. Without the conflict clause a legacy token would be an
 * unlimited session minter for the rest of its 7 days.
 *
 * `expires_at` comes from the token's own `exp` claim — adoption must not
 * extend a life the signer already fixed. Its family is its own jti, so one
 * pre-existing session becomes one family, exactly as a fresh login would.
 */
export async function adoptLegacyRefreshToken(
  jti: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `insert into refresh_tokens (jti, user_id, family, expires_at)
     values ($1, $2, $1, $3)
     on conflict (jti) do nothing`,
    [jti, userId, expiresAt],
  );
}

/**
 * Sweep-tick hygiene, piggybacked on the inactivity sweep next to
 * `purgeDeadLinkTokens` and `purgeDeadSetupHandoffs` — one set-based DELETE, no
 * new timer.
 *
 * `expires_at` alone is the whole predicate, and it is sufficient for every
 * dead state: a spent or revoked row still carries the expiry it was born with,
 * and a refresh token's life is 7 days, so 30 days past expiry is at least 23
 * days after the row stopped mattering to anybody. Adding `spent_at is not
 * null OR ...` would buy nothing and would cost the index scan
 * (refresh_tokens_expiry_idx) that keeps this cheap at 20M sessions.
 *
 * The 30 days are not rounding: a revoked family is the evidence trail behind a
 * theft alarm, and an operator reading a warn line from three weeks ago should
 * still find the rows it names.
 */
export async function purgeDeadRefreshTokens(): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from refresh_tokens where expires_at < now() - interval '30 days'`,
  );
  return rowCount ?? 0;
}
