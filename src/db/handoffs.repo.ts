import { pool } from './pool';

/**
 * Phone-handoff setup sessions (`setup_handoffs`) — the db-layer slice of the
 * QR bot-setup flow.
 *
 * Minting, the public paste and the one-shot poll all live in the handoff
 * ROUTES, where they belong; what lives here is the part the WORKER needs. The
 * inactivity sweep cannot import an api route module (fastify, auth, the whole
 * server) just to reach a table, so the sweep's hygiene query gets a home in
 * the repo layer next to its sibling `purgeDeadLinkTokens`.
 */

/**
 * Sweep-tick hygiene: ONE indexed delete over every tenant, nothing per-row and
 * nothing per-tenant (setup_handoffs_expiry_idx on expires_at). This replaces
 * the opportunistic per-tenant purge that used to run inside the mint handler —
 * which meant a tenant who stopped minting leaked its dead rows forever.
 *
 * THE 1-HOUR GRACE AFTER expires_at IS LOAD-BEARING, not rounding. A handoff is
 * live for 5 minutes, but the session outlives the token: the phone's paste
 * lands, and the DASHBOARD still has to poll that row to collect the bot token
 * (and, when the operator was slow, to be told 'expired' rather than nothing).
 * Deleting on the expiry second would let a purge tick land in the middle of a
 * real setup and turn a 'received'/'expired' answer into an unknown-handoff
 * 404. An hour is far longer than any human round trip between the phone and
 * the browser, and it is the same interval the opportunistic purge used — so
 * folding the purge into the sweep changes WHO purges, never what survives.
 */
export async function purgeDeadSetupHandoffs(): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from setup_handoffs
      where expires_at < now() - interval '1 hour'`,
  );
  return rowCount ?? 0;
}
