import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { getPublicUrl } from '../../config/public-url';
import { logger } from '../../shared/logger';
import { redis } from '../../shared/redis';
import { sendPlatformEmail } from '../../core/platform-email';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../../auth/password';
import {
  createUser,
  getUserByEmail,
  getUserById,
  organizationsForUser,
  setUserPassword,
  type User,
} from '../../db/accounts.repo';
import { provisionAccount } from '../../auth/provisioning';
import { requireUser } from '../jwt-auth';
import { ipRateLimit } from '../rate-limit';

/**
 * S1.2 — per-IP brakes on the credential surface. These are the only routes
 * in the API a stranger can call with no key at all, so they are the ones
 * worth guessing against; each gets its own named budget so exhausting one
 * never locks a legitimate caller out of the others.
 *
 *  login   10/min — a human mistypes a password two or three times, never ten.
 *  signup   3/min — one real person creates one account; anything faster is a
 *                   junk-tenant script (S1.6's Google sign-in is the durable
 *                   answer, this is the floor until then).
 *  refresh 30/min — an SPA with several tabs refreshes legitimately often, so
 *                   this is loose enough to never bite and tight enough to
 *                   stop a script mining refresh tokens for a live one.
 *
 * S1.7a adds three more:
 *
 *  password-change 10/min — an authenticated surface, but a wrong `currentPassword`
 *                   is a password oracle; ten is the same allowance login gets.
 *  forgot   3/min — one human asks for one reset link. Anything faster is a
 *                   script walking an address list, and every accepted call
 *                   costs an outbound email.
 *  reset   10/min — the token is 32 random bytes; brute force is hopeless
 *                   regardless, so this only bounds the scrypt work a stranger
 *                   can buy with garbage tokens.
 */
const LOGIN_PER_MIN = 10;
const SIGNUP_PER_MIN = 3;
const REFRESH_PER_MIN = 30;
const PASSWORD_CHANGE_PER_MIN = 10;
const FORGOT_PER_MIN = 3;
const RESET_PER_MIN = 10;

/**
 * The reset token's life. Long enough to walk to another device and find the
 * mail, short enough that a link sitting in an unattended inbox stops being a
 * key to the account by the time anyone wanders past.
 */
const RESET_TTL_S = 1800;

/**
 * A SECOND budget on /auth/forgot, keyed on the ADDRESS rather than the caller.
 * The per-IP brake above bounds one machine; this bounds one mailbox, which is
 * the thing that actually gets hurt — without it a botnet (or one caller with a
 * rotating proxy) turns "forgot password" into a mail bomb aimed at a person
 * who did nothing.
 *
 * A rolling hour from the first request rather than a fixed hour bucket: three
 * links is already generous for a real human, and the fixed-bucket seam would
 * hand out six across an hour boundary.
 */
const RESET_EMAILS_PER_HOUR = 3;
const RESET_EMAIL_WINDOW_S = 3600;

/**
 * Reset tokens are stored HASHED, exactly like API keys and the handoff tokens:
 * the raw token exists only in the email. A dump of Redis (a `KEYS *` from a
 * misconfigured instance, an RDB file in a backup) then yields nothing that can
 * be replayed — the key IS the digest, so there is no plaintext to steal.
 */
const resetKey = (token: string) => `pwreset:${createHash('sha256').update(token).digest('hex')}`;

/** Per-mailbox budget key. The address is hashed too — Redis keys end up in
 *  slow logs and `KEYS` output, and a customer's email address is PII. */
const resetBudgetKey = (email: string) =>
  `pwreset-budget:${createHash('sha256').update(email.toLowerCase()).digest('hex')}`;

const SignupSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  organizationName: z.string().min(1).max(255),
});

/** Mirrors signup's password rule — one strength policy, set in one place. */
const NewPasswordSchema = z.string().min(8).max(255);

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(255).optional(),
  newPassword: NewPasswordSchema,
});

const ForgotSchema = z.object({ email: z.string().email().max(255) });

const ResetSchema = z.object({
  token: z.string().min(1).max(256),
  newPassword: NewPasswordSchema,
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RefreshSchema = z.object({ refreshToken: z.string().min(1) });

/**
 * The access+refresh pair every sign-in door hands out. Exported because
 * S1.6's Google redeem endpoint must mint the EXACT same pair — a second
 * signer with its own TTLs would be a second session policy nobody would
 * remember to keep in step.
 */
export function mintSessionTokens(app: FastifyInstance, userId: string) {
  return {
    accessToken: app.jwt.sign({ sub: userId, type: 'access' }, { expiresIn: env.accessTokenTtl }),
    refreshToken: app.jwt.sign(
      { sub: userId, type: 'refresh' },
      { expiresIn: env.refreshTokenTtl },
    ),
  };
}

/**
 * The body /auth/login returns — user, their orgs, and the token pair. Shared
 * with /auth/google/redeem so the dashboard's post-sign-in handling is one code
 * path regardless of which door the session came through.
 */
export async function sessionResponse(app: FastifyInstance, user: User) {
  return {
    user: { id: user.id, name: user.name, email: user.email },
    organizations: await organizationsForUser(user.id),
    ...mintSessionTokens(app, user.id),
  };
}

/**
 * Where the reset link points. The page is a DASHBOARD route, so this is the
 * SPA's origin, not the API's.
 *
 * In production those are the same host (the SPA and the API sit behind one
 * Caddy), so the runtime public URL is exactly right — and a domain move needs
 * no code change, the same property `getPublicUrl()` buys everywhere else.
 *
 * In dev they are NOT the same: the API answers on :3000 while vite serves the
 * dashboard on :5173, and `getPublicUrl()` in dev is usually the cloudflared
 * tunnel hostname, which fronts the API. Either would produce a link that 404s.
 * Hard-coding the vite origin here is the same call `googleRedirectUri()` makes
 * for the same reason: dev's real SPA origin is a fixed local port, and the
 * rotating tunnel URL is never it.
 */
async function resetLinkOrigin(): Promise<string> {
  return process.env.NODE_ENV === 'production' ? await getPublicUrl() : 'http://localhost:5173';
}

function resetEmailBody(link: string): string {
  return [
    'Someone asked to reset the password on your asyncify account.',
    '',
    'Open this link to choose a new one:',
    link,
    '',
    'The link works for 30 minutes and can only be used once.',
    '',
    'If you did not request this, you can ignore this email — nothing has',
    'changed, and your current password still works.',
  ].join('\n');
}

/**
 * Mint a reset token for a user we KNOW exists, park its digest in Redis, and
 * put the link in the post. Deliberately returns nothing: /auth/forgot's answer
 * must not depend on anything that happens in here.
 */
async function issueResetLink(userId: string, email: string): Promise<void> {
  // Budget first, so an over-budget request mints no token at all: the previous
  // link stays the only live one, and there is nothing new to leak.
  const budgetKey = resetBudgetKey(email);
  const used = await redis.incr(budgetKey);
  if (used === 1) await redis.expire(budgetKey, RESET_EMAIL_WINDOW_S);
  if (used > RESET_EMAILS_PER_HOUR) {
    logger.warn(
      { userId, perHour: RESET_EMAILS_PER_HOUR },
      'password reset: per-address hourly budget exhausted, not sending',
    );
    return;
  }

  const token = randomBytes(32).toString('hex');
  await redis.set(resetKey(token), userId, 'EX', RESET_TTL_S);
  const link = `${await resetLinkOrigin()}/reset-password?token=${token}`;

  // NOT awaited. See the note in the route: the send is the one step whose cost
  // is unbounded and variable, and awaiting it here would make "this address is
  // registered" measurable from the response time alone.
  void sendPlatformEmail({
    to: email,
    subject: 'Reset your asyncify password',
    text: resetEmailBody(link),
  }).catch((err: Error) => {
    logger.warn({ err: err.message }, 'password reset: send threw');
  });
}

export function registerAuthRoutes(app: FastifyInstance) {
  const tokens = (userId: string) => mintSessionTokens(app, userId);

  /**
   * Self-serve onboarding: one call creates the user, their organization,
   * Development + Production environments, and one API key per environment.
   * The plaintext keys appear in THIS response only — they are stored hashed.
   */
  app.post('/auth/signup', { preHandler: [ipRateLimit('signup', SIGNUP_PER_MIN)] }, async (req, reply) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const body = parsed.data;

    const user = await createUser(body.email, body.name, await hashPassword(body.password));
    if (!user) {
      return reply.code(409).send({ error: 'an account with this email already exists' });
    }

    const { organization, environments } = await provisionAccount(user, body.organizationName);

    return reply.code(201).send({
      user: { id: user.id, name: user.name, email: user.email },
      organization,
      environments,
      ...tokens(user.id),
    });
  });

  app.post('/auth/login', { preHandler: [ipRateLimit('login', LOGIN_PER_MIN)] }, async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body' });
    }
    const user = await getUserByEmail(parsed.data.email);
    // An unknown email still pays for a full scrypt verify (against a fixed
    // dummy hash) instead of returning early, so "no such account" and "wrong
    // password" cost the same time as well as sending the same body — latency
    // would otherwise enumerate which addresses are registered.
    //
    // A Google-first account (S1.6) has NO password hash, and it takes the
    // dummy-verify branch for the same reason an unknown email does: returning
    // early would make "this address exists but only signs in with Google" a
    // measurably faster 401 than "wrong password", which is the enumeration
    // leak the identical bodies exist to close.
    const passwordOk = user?.password_hash
      ? await verifyPassword(parsed.data.password, user.password_hash)
      : await verifyDummyPassword(parsed.data.password);
    if (!user || !passwordOk) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    return sessionResponse(app, user);
  });

  app.post('/auth/refresh', { preHandler: [ipRateLimit('refresh', REFRESH_PER_MIN)] }, async (req, reply) => {
    const parsed = RefreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body' });
    }
    try {
      const payload = app.jwt.verify<{ sub: string; type: string }>(parsed.data.refreshToken);
      if (payload.type !== 'refresh') throw new Error('wrong token type');
      return { accessToken: app.jwt.sign({ sub: payload.sub, type: 'access' }, { expiresIn: env.accessTokenTtl }) };
    } catch {
      return reply.code(401).send({ error: 'invalid refresh token' });
    }
  });

  app.get('/auth/me', { preHandler: [requireUser] }, async (req, reply) => {
    const user = await getUserById(req.userId);
    if (!user) return reply.code(401).send({ error: 'user no longer exists' });
    return {
      user: { id: user.id, name: user.name, email: user.email },
      organizations: await organizationsForUser(user.id),
      /**
       * S1.7a. The dashboard's Password card has two entirely different shapes
       * — "change it" (current + new) and "set one" (new only, for an account
       * that has only ever signed in with Google) — and this is the bit that
       * picks. Deliberately a BOOLEAN and not the hash, its parameters, or a
       * length: the answer the UI needs is "is there one", and nothing more
       * about a password should ever leave the server.
       */
      hasPassword: user.password_hash !== null,
    };
  });

  /* ------------------------------------------------------------------ *
   * S1.7a — PASSWORDS: change one, forget one, reset one.
   * ------------------------------------------------------------------ */

  /**
   * Set or change the signed-in user's password.
   *
   * Two shapes, decided by the row and not by the request:
   *
   *  - The user HAS a password -> `currentPassword` is required and must
   *    verify. Re-proving possession is what stops a borrowed laptop (or an
   *    XSS-lifted access token) from being upgraded into permanent ownership
   *    of the account.
   *  - The user has NO password (Google-only, S1.6) -> there is nothing to
   *    re-prove and no secret they could supply, so `currentPassword` is
   *    ignored entirely. They are holding a valid access token, which they can
   *    only have got by completing a Google sign-in; that IS the proof.
   */
  app.post(
    '/auth/password',
    { preHandler: [requireUser, ipRateLimit('password-change', PASSWORD_CHANGE_PER_MIN)] },
    async (req, reply) => {
      const parsed = ChangePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }

      const user = await getUserById(req.userId);
      if (!user) return reply.code(401).send({ error: 'user no longer exists' });

      if (user.password_hash !== null) {
        const current = parsed.data.currentPassword ?? '';
        if (!(await verifyPassword(current, user.password_hash))) {
          return reply.code(401).send({ error: 'current password is incorrect' });
        }
      }

      // Always hashed under the CURRENT parameters, never the ones the old hash
      // carried — every password change is also a free upgrade to today's cost.
      await setUserPassword(user.id, await hashPassword(parsed.data.newPassword));
      return { ok: true };
    },
  );

  /**
   * Ask for a reset link.
   *
   * ALWAYS 200 {ok:true}. Not "200 if it exists, 404 if it doesn't", and not a
   * different message either: this route is unauthenticated, so any answer that
   * varies with the address turns it into a free membership oracle over every
   * mailbox on the internet.
   *
   * TIMING — the deliberate choice, since an identical body proves nothing if
   * the two paths take visibly different times to produce it (the same trap
   * `verifyDummyPassword` exists to close on /auth/login):
   *
   *   - The unknown path does one Postgres lookup and answers.
   *   - The known path does the same lookup, then two local Redis round trips
   *     (budget INCR, token SET) before answering. Tens of microseconds against
   *     a query measured in whole milliseconds — under the jitter of the query
   *     itself, so it is not a signal anyone can read.
   *   - The SEND — the one step whose cost is unbounded, network-shaped and
   *     hundreds of milliseconds wide — is fired WITHOUT being awaited. That is
   *     the difference that would have been measurable from Australia, and it
   *     is off the response path entirely.
   *
   * The alternative (reply first, then do everything) buys a slightly flatter
   * profile at the cost of a response that has provably done nothing yet — and
   * nothing here is expensive enough to be worth that.
   */
  app.post(
    '/auth/forgot',
    { preHandler: [ipRateLimit('forgot', FORGOT_PER_MIN)] },
    async (req, reply) => {
      const parsed = ForgotSchema.safeParse(req.body);
      // Even a malformed body gets the friendly answer: "that isn't an email
      // address" is not information an attacker can use, but branching here
      // would still be one more shape to keep in step with the others.
      if (!parsed.success) return reply.send({ ok: true });

      const user = await getUserByEmail(parsed.data.email);
      if (user) {
        // Note the address from the ROW, not the request: `getUserByEmail`
        // lowercases to match, so this is the canonical mailbox we hold.
        await issueResetLink(user.id, user.email);
      }
      return reply.send({ ok: true });
    },
  );

  /**
   * Spend a reset link and set the new password.
   *
   * GETDEL, not GET-then-DEL: read and burn are one atomic step, so two tabs
   * (or a mail scanner that pre-fetches links, then the human) cannot both
   * spend the same token. Same discipline as the Google one-time login code.
   *
   * NO session is minted here. The user proves the new password immediately by
   * logging in with it, which is both simpler than auto-login and a better
   * outcome: whoever finishes a reset has demonstrably typed a password that
   * works, rather than being carried past the only door that tests it.
   */
  app.post(
    '/auth/reset',
    { preHandler: [ipRateLimit('reset', RESET_PER_MIN)] },
    async (req, reply) => {
      const parsed = ResetSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }

      const userId = await redis.getdel(resetKey(parsed.data.token));
      if (!userId) {
        return reply.code(401).send({ error: 'reset link expired — request a new one' });
      }
      // The account can have been deleted between the mail and the click.
      const user = await getUserById(userId);
      if (!user) {
        return reply.code(401).send({ error: 'reset link expired — request a new one' });
      }

      // `setUserPassword` writes password_hash and nothing else — a reset on a
      // linked account leaves google_sub intact, so both doors stay open.
      await setUserPassword(user.id, await hashPassword(parsed.data.newPassword));
      logger.info({ userId: user.id }, 'password reset completed');
      return { ok: true };
    },
  );
}
