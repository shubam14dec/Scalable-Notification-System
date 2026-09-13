import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger';
import { sendPlatformEmail } from '../../core/platform-email';
import { inviteEmail } from '../../core/platform-email-templates';
import {
  approveAccessRequest,
  declineAccessRequest,
  getAccessRequestById,
  hashInviteCode,
  listAccessRequests,
  type AccessRequest,
  type ListedAccessRequest,
} from '../../db/access-requests.repo';
import { getUserByEmail, setSuspended, type User } from '../../db/accounts.repo';
import { revokeAllForUser } from '../../db/refresh-tokens.repo';
import { isOperatorEmail, requireOperatorUser } from '../jwt-auth';
import { dashboardOrigin } from './auth';

/**
 * B1 — THE OPERATOR SIDE OF THE BETA GATE.
 *
 * The three routes a human uses to work the waiting list: read it, let someone
 * in, turn someone away. They live under `/v1/ops/` beside the machine operator
 * plane because they are the same JOB — running the platform rather than using
 * it — but they are guarded by a different key entirely: `requireOperatorUser`
 * (a signed-in dashboard account listed in OPERATOR_EMAILS), never the
 * `x-operator-token` machine secret. See the doc comment on that preHandler for
 * why the two planes must not substitute for each other.
 */

/**
 * How long an invite lives. A week is the span of "I saw the email on my phone
 * on Friday and will set it up at work on Monday" — long enough that nobody
 * loses their seat to a weekend, short enough that a mailbox someone stops
 * reading is not an open door into the beta six months later. Expiry is not a
 * dead end either: re-approving re-mints and re-sends.
 */
const INVITE_TTL_DAYS = 7;

/** Ids come from our own list; a non-uuid can only be someone poking at it. */
const IdSchema = z.string().uuid();

const StatusSchema = z.enum(['pending', 'approved', 'declined']);

function requestView(row: AccessRequest | ListedAccessRequest) {
  const accountStatus = 'account_status' in row ? row.account_status : null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    useCase: row.use_case,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    inviteExpiresAt: row.invite_expires_at,
    consumedAt: row.consumed_at,
    /**
     * B2 — what became of the account this seat turned into, present ONLY on a
     * consumed row (the listing's join supplies it; approve and decline return
     * a bare row and never carry it). A seat that has not been spent has no
     * account behind it, so 'active' there would be a claim about somebody who
     * does not exist.
     */
    ...(row.consumed_at && accountStatus ? { accountStatus } : {}),
    // The invite code itself is deliberately absent — it exists in exactly one
    // place, the applicant's email. An operator who could read it could sign up
    // as them, and a screen that displayed it would put it in every screenshot.
  };
}

export function registerAccessRequestRoutes(app: FastifyInstance) {
  /** The waiting list, one status at a time, newest first. */
  app.get<{ Querystring: { status?: string } }>(
    '/v1/ops/access-requests',
    { preHandler: [requireOperatorUser] },
    async (req, reply) => {
      // Validated rather than defaulted-on-mismatch: a typo'd filter that
      // silently showed the pending list would look like "nobody is approved".
      const status = req.query.status === undefined ? 'pending' : req.query.status;
      const parsed = StatusSchema.safeParse(status);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'status must be pending, approved or declined' });
      }
      return { requests: (await listAccessRequests(parsed.data)).map(requestView) };
    },
  );

  /**
   * Let someone in: mint an invite, store its digest, email them the link.
   *
   * Allowed from `pending` (the first yes) AND from `approved` — re-approving
   * is the RESEND button. Invites get lost in spam folders and expire in
   * inboxes, and without a resend the only recovery would be asking the
   * applicant to submit the form again, which they cannot do while their row is
   * approved. Re-approving overwrites the digest, so the previous code dies the
   * moment a new one is sent; there is never more than one live invite per seat.
   *
   * The two refusals are different on purpose:
   *  - consumed -> 409. The seat was used; there is nothing to re-send, and the
   *    person the operator is looking at already has an account.
   *  - declined -> 400. Not a state an approval may jump from: the applicant
   *    must ask again (which returns the row to pending), so a decline is never
   *    quietly undone by an operator working from a stale list.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/ops/access-requests/:id/approve',
    { preHandler: [requireOperatorUser] },
    async (req, reply) => {
      if (!IdSchema.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown access request' });
      }
      const existing = await getAccessRequestById(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'unknown access request' });
      if (existing.consumed_at) {
        return reply.code(409).send({ error: 'already signed up' });
      }
      if (existing.status === 'declined') {
        return reply
          .code(400)
          .send({ error: 'this request was declined — they must ask again before it can be approved' });
      }

      // 32 random bytes, stored as its sha256 — the same discipline as reset
      // tokens, api keys and handoff tokens. The raw code below is the only
      // copy, and it leaves this process in one email.
      const code = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
      const updated = await approveAccessRequest(existing.id, hashInviteCode(code), expiresAt);
      if (!updated) {
        // The row moved under us between the read and the write (someone else
        // approved and the applicant signed up, most plausibly).
        return reply.code(409).send({ error: 'already signed up' });
      }

      const link = `${await dashboardOrigin()}/login?invite=${code}`;
      // Unawaited, like every other platform send: a slow relay must not hold
      // the operator's button in its loading state.
      void sendPlatformEmail({ to: updated.email, ...inviteEmail({ link }) }).catch((err: Error) => {
        logger.warn({ err: err.message }, 'access request: invite email threw');
      });

      logger.info({ requestId: updated.id, operator: req.userId }, 'access request approved');
      return { request: requestView(updated) };
    },
  );

  /**
   * Turn someone away. PENDING only — a decided row is decided.
   *
   * NO email goes out. Silence is the deliberate v1 choice: a rejection letter
   * from a beta nobody has heard of is worse than no letter, it invites a reply
   * thread there is nobody to staff, and the decline is not final anyway — the
   * address can ask again, which puts it straight back on this list.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/ops/access-requests/:id/decline',
    { preHandler: [requireOperatorUser] },
    async (req, reply) => {
      if (!IdSchema.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown access request' });
      }
      const declined = await declineAccessRequest(req.params.id);
      if (!declined) {
        const existing = await getAccessRequestById(req.params.id);
        if (!existing) return reply.code(404).send({ error: 'unknown access request' });
        return reply.code(409).send({ error: 'this request has already been decided' });
      }
      logger.info({ requestId: declined.id, operator: req.userId }, 'access request declined');
      return { request: requestView(declined) };
    },
  );

  /* ------------------------------------------------------------------ *
   * B2 — REVOKE AND RESTORE AN ACCOUNT'S ACCESS.
   * ------------------------------------------------------------------ */

  /**
   * Shut an account out. The operator's seat turned out to be the wrong seat:
   * the person left the company, the address was compromised, the beta tester
   * started abusing the send quota.
   *
   * TWO writes, and both are load-bearing:
   *  - `setSuspended` closes every DOOR — password login, the Google returning
   *    and link branches, and the refresh rotation all read this column.
   *  - `revokeAllForUser` closes every SESSION already open. Without it the
   *    doors would be shut behind somebody who is already inside, and their
   *    browser would go on rotating a refresh token for seven days.
   * Together they bound the lockout at one access-token lifetime (~15 minutes):
   * the live access token in the person's tab keeps working until it expires,
   * and nothing can mint another. See the note on `setSuspended` for why the
   * authenticated hot path deliberately does not read this column.
   *
   * Idempotent: revoking a revoked account is a 200 that changes nothing (the
   * timestamp does not move, and there are no live families left to revoke).
   */
  app.post<{ Params: { id: string } }>(
    '/v1/ops/access-requests/:id/revoke',
    { preHandler: [requireOperatorUser] },
    async (req, reply) => {
      const target = await resolveAccount(req.params.id, 'revoke', reply);
      if (!target) return;

      /**
       * THE OPERATOR GUARD. An operator seat cannot be revoked — not by another
       * operator, and above all not by whoever is holding a hijacked operator
       * session.
       *
       * Without it this page is a one-click lockout of the only people who can
       * undo it: suspend every operator and the Requests page is closed to
       * everybody, permanently, with no path back that does not involve a
       * database console. The seat is configured in OPERATOR_EMAILS, which lives
       * in the deployment and not in this table, so an operator who genuinely
       * must be removed is removed THERE — where the change is reviewed, and
       * where it takes effect on their very next click.
       */
      if (isOperatorEmail(target.email)) {
        return reply.code(403).send({ error: 'operators cannot be suspended' });
      }

      await setSuspended(target.id, true);
      const revoked = await revokeAllForUser(target.id);
      logger.warn(
        { operator: req.userId, target: target.id, revoked },
        'account access revoked',
      );
      return { accountStatus: 'suspended' as const };
    },
  );

  /**
   * Let them back in. One write — the sessions revoked above stay revoked, so
   * they sign in again and get a new one, which is the right outcome: a restore
   * is not a resurrection of whatever was open when the operator clicked.
   *
   * No operator guard here: an operator account can never have been suspended
   * in the first place, so there is nothing this could undo that the guard above
   * did not already prevent.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/ops/access-requests/:id/restore',
    { preHandler: [requireOperatorUser] },
    async (req, reply) => {
      const target = await resolveAccount(req.params.id, 'restore', reply);
      if (!target) return;

      await setSuspended(target.id, false);
      logger.info({ operator: req.userId, target: target.id }, 'account access restored');
      return { accountStatus: 'active' as const };
    },
  );
}

/**
 * B2 — the access request the operator clicked -> the USER it became.
 *
 * The :id is a row on the Requests page, because that page is where the
 * operator is standing and it is the only list of beta accounts this deployment
 * has. The hop from one to the other is the MAILBOX, which is what an access
 * request is keyed on and what a user row is unique on.
 *
 * Only a CONSUMED row qualifies: a seat that was never spent has no account
 * behind it, and a 409 saying so is a truer answer than a 404 (the request is
 * right there on their screen; it is the account that does not exist).
 *
 * Replies and returns null on every refusal — the caller returns immediately on
 * null (the house idiom, see `requireEnvAccess`), so nothing downstream can act
 * on a target that was never found.
 */
async function resolveAccount(
  id: string,
  verb: 'revoke' | 'restore',
  reply: FastifyReply,
): Promise<User | null> {
  if (!IdSchema.safeParse(id).success) {
    reply.code(404).send({ error: 'unknown access request' });
    return null;
  }
  const request = await getAccessRequestById(id);
  if (!request) {
    reply.code(404).send({ error: 'unknown access request' });
    return null;
  }
  const user = request.consumed_at ? await getUserByEmail(request.email) : null;
  if (!user) {
    reply.code(409).send({ error: `no account to ${verb}` });
    return null;
  }
  return user;
}
