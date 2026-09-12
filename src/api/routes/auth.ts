import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { getPublicUrl } from '../../config/public-url';
import { logger } from '../../shared/logger';
import { redis } from '../../shared/redis';
import { sendPlatformEmail } from '../../core/platform-email';
import {
  accessRequestEmail,
  passwordResetEmail,
} from '../../core/platform-email-templates';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../../auth/password';
import {
  createUser,
  getUserByEmail,
  getUserById,
  organizationsForUser,
  setTourPending,
  setUserPassword,
  type User,
} from '../../db/accounts.repo';
import {
  consumeAccessRequest,
  findLiveInvite,
  getAccessRequestByEmail,
  insertAccessRequest,
  reopenDeclinedRequest,
} from '../../db/access-requests.repo';
import {
  adoptLegacyRefreshToken,
  getRefreshToken,
  insertRefreshToken,
  revokeAllForUser,
  revokeFamily,
  spendRefreshToken,
} from '../../db/refresh-tokens.repo';
import { initialApiKeysFrom, provisionAccount } from '../../auth/provisioning';
import { isOperatorEmail, operatorEmails, requireUser } from '../jwt-auth';
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
 * S1.7 adds one: /auth/logout is unauthenticated by design (possession of the
 * refresh token IS the credential — a dying session's access token may already
 * be expired), so it gets a brake like every other door a stranger can knock
 * on. Loose, because the cost of a call is one HMAC and at most one indexed
 * UPDATE, and because a person with six tabs open legitimately fires six.
 */
const LOGOUT_PER_MIN = 60;

/**
 * B1 adds one more, the same shape as `forgot` and for the same reason: one
 * human asks to be let in once. Anything faster is a script, and every accepted
 * call costs an outbound email to a REAL PERSON (the operator), who is the one
 * this budget actually protects.
 */
const REQUEST_ACCESS_PER_MIN = 3;

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

/**
 * B1 — the same per-mailbox idiom for access requests, and the mailbox it
 * protects is the OPERATOR's: without it, one address could be walked through
 * request -> decline -> request forever, and every lap costs the operator an
 * email. Three asks per rolling hour is far more than any real applicant needs.
 * The address is hashed for the same PII reason as above.
 */
const ACCESS_REQUESTS_PER_HOUR = 3;
const ACCESS_REQUEST_WINDOW_S = 3600;
const accessBudgetKey = (email: string) =>
  `access-budget:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;

const SignupSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  organizationName: z.string().min(1).max(255),
});

/**
 * B1 — the invite code, validated SEPARATELY from the body above rather than as
 * a fourth required field on it. The distinction is the whole point: a
 * malformed body is a 400 that tells a developer what they got wrong, while
 * anything at all to do with the invite — missing, junk, expired, spent, or
 * issued to a different address — is the one identical 403 below. Folding it
 * into SignupSchema would have made "no code" a 400 and every other failure a
 * 403, which is a free oracle for whether a guessed code exists.
 */
const InviteCodeSchema = z.string().min(1).max(256);

/**
 * The ONLY answer any invite failure gets. Deliberately says nothing about
 * WHICH failure it was: a stranger holding a random code learns nothing, and a
 * real invitee who typed the wrong email gets a message that tells them what to
 * do without confirming that a code they hold is otherwise valid.
 */
const INVITE_REQUIRED = 'a valid invite for this email is required';

const RequestAccessSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  useCase: z.string().trim().min(1).max(500),
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
 * Logout's body. Bounded at 4096 so a stranger cannot make us HMAC a megabyte;
 * a real refresh token is a couple of hundred bytes.
 */
const LogoutSchema = z.object({ refreshToken: z.string().min(1).max(4096) });

/**
 * S1.7 — HOW LONG A JUST-SPENT TOKEN IS MERELY DEAD RATHER THAN STOLEN.
 *
 * Two dashboard tabs share one localStorage and can both hold token #481 when
 * their access tokens expire. Tab A rotates it into #482; tab B, a few
 * milliseconds behind, presents #481 too. That is not theft — it is the same
 * browser racing itself — and treating it as theft would log the user out of
 * their own laptop and blame them for it.
 *
 * So a reuse inside this window is refused (401, plain) but rings no alarm, and
 * the client recovers by reading the token the winning tab already stored (see
 * `tryRefresh` in dashboard/src/lib/api.ts). Outside it, a reuse is what it
 * looks like: somebody is replaying a token whose successor has been in use for
 * half a minute, and the whole family dies.
 *
 * 30 seconds is chosen against the two failure modes: too short and a slow
 * network turns a tab race into a false alarm; too long and a genuine thief
 * gets a usable head start. A real race resolves in tens of milliseconds.
 */
const REUSE_GRACE_MS = 30_000;

/**
 * The ONLY answer /auth/refresh gives a token it will not honour — unknown,
 * expired, revoked, already spent, or the wrong type. One body for all of them,
 * deliberately: "this token was spent" and "this token never existed" are
 * different facts about somebody's session, and a caller holding a stolen token
 * must not be able to tell which one they are holding.
 */
const REFRESH_REJECTED = { error: 'invalid refresh token' };

/**
 * The access+refresh pair every sign-in door hands out. Exported because
 * S1.6's Google redeem endpoint must mint the EXACT same pair — a second
 * signer with its own TTLs would be a second session policy nobody would
 * remember to keep in step.
 *
 * S1.7 makes this write as well as sign: the refresh token gains a `jti` and a
 * `family`, and the jti is recorded in the ledger as the one live token of that
 * family (src/db/refresh-tokens.repo.ts). Hence `async` — every caller awaits.
 *
 * `family` is passed ONLY by a rotation, which inherits the chain's identity. A
 * sign-in door passes nothing and the token roots its own family under its own
 * jti: one sign-in, one family, whatever it later rotates into.
 *
 * The access token is untouched — no jti, no row, no lookup. It is verified by
 * signature alone on every request, and that is exactly why the refresh token
 * is the one that carries state: 15 minutes of statelessness per DB write.
 */
export async function mintSessionTokens(
  app: FastifyInstance,
  userId: string,
  family?: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const jti = randomUUID();
  const refreshToken = app.jwt.sign(
    { sub: userId, type: 'refresh', jti, family: family ?? jti },
    { expiresIn: env.refreshTokenTtl },
  );

  // The row's expiry is read back off the token we just signed rather than
  // recomputed from env.refreshTokenTtl: the signer owns that arithmetic (and
  // the TTL is a duration string it parses), so asking it is the only way the
  // ledger and the JWT can never disagree about when this token dies.
  const exp = app.jwt.decode<{ exp: number }>(refreshToken)?.exp ?? 0;
  await insertRefreshToken(jti, userId, family ?? jti, new Date(exp * 1000));

  return {
    accessToken: app.jwt.sign({ sub: userId, type: 'access' }, { expiresIn: env.accessTokenTtl }),
    refreshToken,
  };
}

/**
 * GRANDFATHERING — a stable ledger handle for a refresh token minted BEFORE
 * S1.7, which carries no `jti` claim of its own.
 *
 * The deploy would otherwise sign every live dashboard session out: no jti
 * means no row, no row means the rotation matches nothing, and the browser
 * lands on /login. That is a one-time cost nobody would notice for long, but it
 * is avoidable, and the naive way to avoid it — "no jti? mint a pair and let it
 * through" — is worse than the logout: with nothing to spend, one stolen legacy
 * token would mint fresh sessions on demand for the rest of its seven days, in
 * a new unrelated family each time, invisible to the very theft detection this
 * slice adds.
 *
 * So the token is given a handle DERIVED FROM ITSELF. Same token, same jti,
 * every time — which is what lets `adoptLegacyRefreshToken`'s `on conflict do
 * nothing` make the adoption single-use, after which the legacy token is an
 * ordinary ledger entry and rotates, races and revokes like any other.
 *
 * A sha256 of the token, laid out as an RFC 9562 version-8 uuid (the version
 * reserved for exactly this: a well-formed uuid built from application data).
 * The digest — not the token — is what lands in the column, so this stores no
 * more secret material than the random-jti path does.
 */
export function legacyJti(refreshToken: string): string {
  const h = createHash('sha256').update(refreshToken).digest('hex');
  // Nibble 12 is the version (8) and the top two bits of nibble 16 are the
  // RFC variant; everything else is digest.
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const u = `${h.slice(0, 12)}8${h.slice(13, 16)}${variant}${h.slice(17, 32)}`;
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
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
    ...(await mintSessionTokens(app, user.id)),
  };
}

/**
 * Where a link we EMAIL points — reset links (S1.7a), invite links and the
 * operator's "open the Requests page" pointer (B1). The pages are DASHBOARD
 * routes, so this is the SPA's origin, not the API's.
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
export async function dashboardOrigin(): Promise<string> {
  return process.env.NODE_ENV === 'production' ? await getPublicUrl() : 'http://localhost:5173';
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
  const link = `${await dashboardOrigin()}/reset-password?token=${token}`;

  // NOT awaited. See the note in the route: the send is the one step whose cost
  // is unbounded and variable, and awaiting it here would make "this address is
  // registered" measurable from the response time alone.
  void sendPlatformEmail({ to: email, ...passwordResetEmail({ link }) }).catch((err: Error) => {
    logger.warn({ err: err.message }, 'password reset: send threw');
  });
}

/**
 * B1 — tell every human operator that someone is knocking.
 *
 * One email per address in OPERATOR_EMAILS, each fired WITHOUT being awaited,
 * for the same reason /auth/forgot does it: the send is the one unbounded,
 * network-shaped step in the request, and the applicant's 200 must not wait on
 * it — nor vary with how many operators there are, nor with whether their mail
 * relay is having a bad afternoon.
 *
 * With no operator configured this sends nothing at all, quietly and by design:
 * the request is still recorded, and it is waiting on the Requests page for
 * whoever eventually gets the seat.
 */
function notifyOperators(name: string, email: string, useCase: string, origin: string): void {
  // Built ONCE, outside the loop: every operator gets the identical message,
  // and the escaping this applies to a stranger's name and use case (U4) is
  // work that must not be repeated per recipient either.
  const content = accessRequestEmail({
    name,
    email,
    useCase,
    requestsUrl: `${origin}/requests`,
  });

  for (const operator of operatorEmails()) {
    void sendPlatformEmail({ to: operator, ...content }).catch((err: Error) => {
      logger.warn({ err: err.message }, 'access request: operator notification threw');
    });
  }
}


export function registerAuthRoutes(app: FastifyInstance) {
  const tokens = (userId: string) => mintSessionTokens(app, userId);

  /**
   * Self-serve onboarding: one call creates the user, their organization,
   * Development + Production environments, and one API key per environment.
   * The plaintext keys appear in THIS response only — they are stored hashed.
   *
   * B1: with SIGNUP_MODE=invite this door additionally demands a live invite
   * code issued to THIS address (see the block below). In the default open mode
   * the behavior is byte-identical to what it has always been, and an
   * `inviteCode` sent anyway is simply not read — SignupSchema strips it.
   */
  app.post('/auth/signup', { preHandler: [ipRateLimit('signup', SIGNUP_PER_MIN)] }, async (req, reply) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const body = parsed.data;

    if (env.signupMode === 'invite') {
      const code = InviteCodeSchema.safeParse((req.body as { inviteCode?: unknown })?.inviteCode);
      const invite = code.success ? await findLiveInvite(code.data) : null;

      // The address the invite was ISSUED to must be the address being
      // registered. Without this the gate would be a bearer token for the whole
      // beta: one approved invitee could hand their link to anyone, and the
      // operator's decision would name a person who never signs up.
      if (!invite || invite.email !== body.email.trim().toLowerCase()) {
        return reply.code(403).send({ error: INVITE_REQUIRED });
      }

      // Spend it BEFORE creating anything. Two browsers on one code both reach
      // this line; the conditional UPDATE inside picks exactly one winner, and
      // the loser is refused with the same 403 as an invented code.
      //
      // The cost of this order is that a code is burned if the user insert then
      // fails (a duplicate email, a database blip). That is the deliberate
      // trade: a burned invite is one click for an operator to re-approve
      // (which re-mints and re-sends), while the other order — create, then
      // consume — would let a lost race create a SECOND account off one invite,
      // which is the exact thing this gate exists to prevent.
      if (!(await consumeAccessRequest(invite.id))) {
        return reply.code(403).send({ error: INVITE_REQUIRED });
      }
    }

    const user = await createUser(body.email, body.name, await hashPassword(body.password));
    if (!user) {
      return reply.code(409).send({ error: 'an account with this email already exists' });
    }

    const { organization, environments } = await provisionAccount(user, body.organizationName);

    /**
     * U5 — THIS DOOR arms the first-run tour, not provisionAccount().
     *
     * provisionAccount says what an account IS (an org, two environments, a key
     * each) and it is called from places that are not a person signing up — the
     * test fixtures mint accounts with it directly. "Somebody just walked in
     * through a sign-up door for the first time" is a fact about the DOOR, so
     * each door states it for the row it just created. There are exactly two,
     * and the other is google-auth.ts's create branch.
     *
     * Awaited: one indexed UPDATE on a row we hold the id of, and a tour that
     * fails to arm because a fire-and-forget write lost a race is a first
     * impression nobody gets a second shot at.
     */
    await setTourPending(user.id, true);

    // U4. Unawaited like every other platform send — the account exists, the
    // keys are in the response, and a slow relay must not hold either.

    return reply.code(201).send({
      user: { id: user.id, name: user.name, email: user.email },
      organization,
      environments,
      /**
       * U6 — the same keys `environments` already carries, in the shape BOTH
       * sign-up doors emit. The Google door cannot send `environments` (its
       * response is a session minted a redirect later, and a returning user's
       * session must carry no keys at all), so this is the field the
       * dashboard's one-time reveal reads, whichever door was used. It is the
       * same plaintext already in this body, not a second exposure.
       */
      initialApiKeys: initialApiKeysFrom(environments),
      ...(await tokens(user.id)),
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

  /**
   * S1.7 — ROTATE. A refresh token is spent exactly once, and what it buys is a
   * WHOLE NEW PAIR: a fresh access token and a fresh refresh token inheriting
   * the same family with a fresh 7 days on it (the sliding window — a session
   * in daily use never expires, and one abandoned for a week does).
   *
   * The order of the two checks is the point. The signature is verified first
   * because it is free and it throws out every forgery and every expired token
   * without touching Postgres; only a token we actually signed gets to cost a
   * query. Then the ledger decides whether this particular token is still the
   * live one, in ONE conditional UPDATE — see `spendRefreshToken`.
   *
   * THE THEFT ALARM. If the UPDATE matches nothing, we ask why. A token that was
   * already SPENT (longer ago than the race grace above) means two parties have
   * held the same token: whoever presented it now has a copy of something whose
   * successor is in somebody's browser, and there is no innocent explanation
   * left. We cannot tell victim from thief — so the whole family dies and the
   * legitimate user signs in again, which is a bad afternoon instead of a
   * compromised account. Every other reason (revoked, expired, unknown) is just
   * a dead token and gets the same 401 with no fuss.
   */
  app.post('/auth/refresh', { preHandler: [ipRateLimit('refresh', REFRESH_PER_MIN)] }, async (req, reply) => {
    const parsed = RefreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body' });
    }

    let payload: { sub: string; type: string; jti?: string; exp: number };
    try {
      payload = app.jwt.verify<{ sub: string; type: string; jti?: string; exp: number }>(
        parsed.data.refreshToken,
      );
      if (payload.type !== 'refresh') throw new Error('wrong token type');
    } catch {
      return reply.code(401).send(REFRESH_REJECTED);
    }

    // Pre-S1.7 token: give it the handle it was born without, once. See
    // `legacyJti` and `adoptLegacyRefreshToken` — after this line there is no
    // such thing as a legacy token, only a ledger row like any other.
    let jti = payload.jti;
    if (!jti) {
      jti = legacyJti(parsed.data.refreshToken);
      try {
        await adoptLegacyRefreshToken(jti, payload.sub, new Date(payload.exp * 1000));
      } catch {
        // The one way this insert can fail is the users(id) foreign key: the
        // account was deleted after the token was signed. That is a dead token,
        // not a server error — and the rotation path below reaches the same
        // conclusion for a post-S1.7 token, because `on delete cascade` took
        // its ledger row with the account.
        return reply.code(401).send(REFRESH_REJECTED);
      }
    }

    const spent = await spendRefreshToken(jti);
    if (spent) {
      // SAME family, so the chain keeps its identity and one logout still kills
      // every hop of it.
      return await mintSessionTokens(app, spent.user_id, spent.family);
    }

    const row = await getRefreshToken(jti);
    if (row?.spent_at && Date.now() - new Date(row.spent_at).getTime() > REUSE_GRACE_MS) {
      const revoked = await revokeFamily(row.family);
      // Structured, and carrying no token material: the userId is who to talk
      // to, the count is how much of their session went with it. The jti and
      // the family are deliberately absent — a log line is not the place for
      // session handles.
      logger.warn(
        { userId: row.user_id, revoked },
        'refresh token reuse detected — revoked the whole session family',
      );
    }
    return reply.code(401).send(REFRESH_REJECTED);
  });

  /**
   * S1.7 — REAL LOGOUT. Until now "logging out" cleared localStorage and hoped:
   * the refresh token stayed valid for seven days wherever else it had got to.
   *
   * NO `requireUser`, deliberately. The access token of a session being
   * abandoned is frequently already expired — that is often WHY somebody is
   * leaving — and demanding a live one would mean the sessions most worth
   * ending are the ones that cannot be ended. Possession of the refresh token
   * is the credential here, and it is the only thing this route acts on.
   *
   * Revokes the FAMILY, not the jti: one sign-in is one family, and the browser
   * has almost certainly rotated past whichever token it is holding. Killing
   * the jti alone would leave the session's own successor alive.
   *
   * ALWAYS 200 {ok:true} — for a valid token, an expired one, a forgery, a
   * malformed body. A logout that can fail visibly is a logout people don't
   * trust, and there is nothing an error code could tell the caller that it
   * would be safe to say: "that token was real" is precisely the fact a
   * stranger probing this endpoint would want.
   */
  app.post('/auth/logout', { preHandler: [ipRateLimit('logout', LOGOUT_PER_MIN)] }, async (req) => {
    const parsed = LogoutSchema.safeParse(req.body);
    if (!parsed.success) return { ok: true };

    try {
      const payload = app.jwt.verify<{ type: string; jti?: string; family?: string }>(
        parsed.data.refreshToken,
      );
      if (payload.type === 'refresh') {
        // A pre-S1.7 token has no family claim; its adopted row's family IS its
        // derived jti (see `adoptLegacyRefreshToken`), so one expression covers
        // both. Revoking a family that was never adopted is a harmless no-op —
        // and the right one, since such a token has no successor either.
        await revokeFamily(payload.family ?? legacyJti(parsed.data.refreshToken));
      }
    } catch {
      // Garbage, expired, or signed by somebody else. Nothing to revoke, and
      // nothing to report: the caller is already logged out by any measure.
    }
    return { ok: true };
  });

  /**
   * S1.7 — "Log out everywhere." Every live refresh token this user holds, on
   * every device, including the browser making the call (the dashboard follows
   * it with an ordinary logout, so the tab the person is looking at ends up
   * signed out too).
   *
   * `requireUser` here and not on /auth/logout above, because the two answer
   * different questions. Ending YOUR OWN session needs proof you hold that
   * session's token. Ending EVERY session of an account is an account-wide act,
   * so it needs proof of the account — a live access token — and the refresh
   * token of one device is not that.
   *
   * Returns the count so the UI can say what happened rather than "done".
   */
  app.post('/auth/logout-all', { preHandler: [requireUser] }, async (req) => {
    const revoked = await revokeAllForUser(req.userId);
    logger.info({ userId: req.userId, revoked }, 'logout everywhere: revoked all live sessions');
    return { revoked };
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
      /**
       * B1. Whether this account holds the human operator seat — the same check
       * `requireOperatorUser` enforces, exposed so the dashboard knows whether
       * to render the Requests nav item at all. It is a CONVENIENCE, never the
       * gate: every operator route runs the check again server-side, so a
       * forged `true` in a browser buys a 403 and nothing else.
       */
      operator: isOperatorEmail(user.email),
      /**
       * U5. Does this account still owe its first-run tour? The dashboard
       * already keeps this query warm on every page, so the tour costs no
       * request of its own — and because the answer is the SERVER's, a person
       * who signs up on their laptop and first opens the dashboard on their
       * desktop still gets the tour (a localStorage flag would have lost it).
       */
      tourPending: user.tour_pending,
    };
  });

  /**
   * U5 — "I have seen the tour." Fired by EVERY exit from it: finishing the
   * last stop, pressing the close button, or pressing Escape. There is no
   * matching "start" call and no progress tracking, deliberately — a tour is
   * worth one bit, and any exit means the same thing.
   *
   * No body, no parameters, and nothing to get wrong: the only account it can
   * possibly clear is the caller's own. Idempotent (the UPDATE writes the same
   * false however often it arrives), which matters because the dashboard fires
   * it unawaited and never retries — a second call from a double-click, or from
   * a replay off the Settings page, is a 200 and a no-op.
   */
  app.post('/auth/tour-done', { preHandler: [requireUser] }, async (req) => {
    await setTourPending(req.userId, false);
    return { ok: true };
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

  /* ------------------------------------------------------------------ *
   * B1 — ASK TO BE LET IN.
   * ------------------------------------------------------------------ */

  /**
   * The public door of the beta gate. Registered UNCONDITIONALLY, in both
   * signup modes: an operator who flips SIGNUP_MODE back and forth must not
   * find that requests sent during the switch vanished, and a 404 that appears
   * only in invite mode would advertise the deployment's posture to anyone who
   * probed for it.
   *
   * ALWAYS the identical 200 {ok:true} for a valid body — for exactly the
   * reasons /auth/forgot does it. Every branch below (first ask, repeat ask,
   * already approved, already declined, already a customer) is a different
   * amount of work and a different set of side effects, and NONE of them may be
   * visible from out here: "this address already has an account" and "this
   * address was declined" are both facts a stranger could otherwise harvest an
   * address list with. A malformed body still gets a 400 — that is a developer
   * integrating, not an oracle.
   */
  app.post(
    '/auth/request-access',
    { preHandler: [ipRateLimit('request-access', REQUEST_ACCESS_PER_MIN)] },
    async (req, reply) => {
      const parsed = RequestAccessSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const { name, useCase } = parsed.data;
      const email = parsed.data.email.toLowerCase();

      // The per-mailbox budget is spent by EVERY valid request, before any
      // branching — including the ones that turn out to be no-ops. Uniform on
      // purpose: a budget that only counted the requests which "did something"
      // would make the response time (and the eventual lockout) depend on
      // exactly the hidden state the identical 200 exists to conceal.
      const budgetKey = accessBudgetKey(email);
      const used = await redis.incr(budgetKey);
      if (used === 1) await redis.expire(budgetKey, ACCESS_REQUEST_WINDOW_S);
      if (used > ACCESS_REQUESTS_PER_HOUR) {
        logger.warn(
          { perHour: ACCESS_REQUESTS_PER_HOUR },
          'access request: per-address hourly budget exhausted, ignoring',
        );
        return reply.send({ ok: true });
      }

      // Already a customer: nothing to request, and nothing to say about it.
      // (Their door is /auth/login, which they can find on their own; telling
      // them here would confirm the address is registered.)
      if (await getUserByEmail(email)) {
        return reply.send({ ok: true });
      }

      const existing = await getAccessRequestByEmail(email);

      if (!existing) {
        // First ask. A null return means another request inserted the same
        // address a millisecond ago — the no-op is correct, and the operator
        // gets one email rather than two.
        if (await insertAccessRequest(email, name, useCase)) {
          notifyOperators(name, email, useCase, await dashboardOrigin());
        }
        return reply.send({ ok: true });
      }

      if (existing.status === 'declined') {
        // A declined address may ask again — people's circumstances change, and
        // a decline is not a ban. It goes back to pending with the new words
        // they wrote, and the operator hears about it once.
        if (await reopenDeclinedRequest(email, name, useCase)) {
          notifyOperators(name, email, useCase, await dashboardOrigin());
        }
        return reply.send({ ok: true });
      }

      // pending or approved: it is already on the operator's list (or already
      // in their inbox as an invite). Re-notifying would turn an impatient
      // applicant refreshing a form into a way to bury the operator.
      return reply.send({ ok: true });
    },
  );
}
