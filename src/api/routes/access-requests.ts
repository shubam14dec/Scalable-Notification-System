import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger';
import { sendPlatformEmail } from '../../core/platform-email';
import {
  approveAccessRequest,
  declineAccessRequest,
  getAccessRequestById,
  hashInviteCode,
  listAccessRequests,
  type AccessRequest,
} from '../../db/access-requests.repo';
import { requireOperatorUser } from '../jwt-auth';
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

function requestView(row: AccessRequest) {
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
    // The invite code itself is deliberately absent — it exists in exactly one
    // place, the applicant's email. An operator who could read it could sign up
    // as them, and a screen that displayed it would put it in every screenshot.
  };
}

function inviteEmailBody(link: string): string {
  return [
    "You asked for access to asyncify — you're in.",
    '',
    'Create your account here:',
    link,
    '',
    'The link works for 7 days and can only be used once. Sign up with THIS',
    'email address; the invite is issued to it and will not accept another.',
    '',
    'If the link has expired by the time you get to it, just ask again and',
    "we'll send a fresh one.",
  ].join('\n');
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
      void sendPlatformEmail({
        to: updated.email,
        subject: "You're in — Asyncify access approved",
        text: inviteEmailBody(link),
      }).catch((err: Error) => {
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
}
