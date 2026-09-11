import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { getPublicUrl } from '../../config/public-url';
import { logger } from '../../shared/logger';
import { redis } from '../../shared/redis';
import {
  createGoogleUser,
  getUserByEmail,
  getUserByGoogleSub,
  getUserById,
  linkGoogleSub,
  setTourPending,
  type User,
} from '../../db/accounts.repo';
import {
  consumeAccessRequest,
  findLiveInviteForEmail,
} from '../../db/access-requests.repo';
import { defaultOrganizationName, provisionAccount } from '../../auth/provisioning';
import { ipRateLimit } from '../rate-limit';
import { sessionResponse } from './auth';

/**
 * S1.6 — CONTINUE WITH GOOGLE.
 *
 * Server-side OAuth 2.0 authorization-code flow with PKCE, over OIDC. There is
 * deliberately NO Google JavaScript anywhere: no One Tap, no GIS button, no
 * gapi. The whole feature is three redirects and one POST, which is the only
 * shape compatible with the S1.3 strict CSP the dashboard ships
 * (`script-src 'self'` — a Google script tag would simply be blocked, and the
 * failure would look like a dead button in production and nothing at all in
 * dev). Choosing the redirect flow is what lets the policy stay strict.
 *
 * The trip:
 *
 *   1. GET /auth/google           -> 302 to accounts.google.com, with `state`
 *                                    and a PKCE challenge parked in one
 *                                    HttpOnly cookie.
 *   2. GET /auth/google/callback  -> Google sends `code` + `state`; we check
 *                                    the cookie, trade the code for an
 *                                    id_token at Google's token endpoint,
 *                                    find-or-create the user, and bounce the
 *                                    browser to the SPA with a ONE-TIME code.
 *   3. POST /auth/google/redeem   -> the SPA trades that code for the same
 *                                    access+refresh pair /auth/login mints.
 *
 * Off by default: with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET unset every
 * route here 404s and /auth/methods reports `google: false`, so the
 * dashboard hides the button. Nothing about this feature is required to boot.
 */

/**
 * 30/min per IP on each surface. These are unauthenticated doors, so they get
 * the same treatment as login/signup (S1.2) — but a looser budget, because a
 * single human sign-in legitimately hits authorize + callback + redeem within
 * seconds, and a person who bounces off the Google account chooser a few times
 * must not lock themselves out.
 */
const GOOGLE_PER_MIN = 30;

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Google's `iss` claim — both spellings are legal and both appear in the wild. */
const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * The cookie carrying `${state}.${codeVerifier}` between the authorize
 * redirect and the callback. ONE cookie, not two: the two halves are useless
 * apart and expire together.
 *
 * SameSite=Lax (not Strict) is load-bearing — the callback arrives as a
 * top-level navigation FROM accounts.google.com, and Strict would withhold the
 * cookie on exactly that request, breaking every sign-in. Path=/auth keeps it
 * off every other request the browser makes to this origin, HttpOnly keeps it
 * out of any script, and 10 minutes is a generous ceiling on "pick an account
 * and type a password".
 */
const COOKIE_NAME = 'g_oauth';
const COOKIE_MAX_AGE_S = 600;

/** How long the SPA has to redeem the one-time login code. */
const LOGIN_CODE_TTL_S = 300;
const loginCodeKey = (code: string) => `google-login:${code}`;

const RedeemSchema = z.object({ code: z.string().min(1).max(256) });

/** Is the feature configured at all? Read per request — tests flip env live. */
export function googleAuthEnabled(): boolean {
  return Boolean(env.google.clientId && env.google.clientSecret);
}

/**
 * The redirect_uri, which must byte-match in BOTH the authorize redirect and
 * the token exchange (Google compares them) AND match a URI registered in the
 * Google Cloud console. The console holds exactly two:
 *
 *     https://app.asyncify.org/auth/google/callback     (production)
 *     http://localhost:3000/auth/google/callback        (local dev)
 *
 * Which is why dev does NOT derive this from getPublicUrl(): in dev that value
 * is usually the cloudflared tunnel hostname, which rotates on every
 * `asyncify dev` run and could never be registered ahead of time. Google would
 * reject it with redirect_uri_mismatch. Production has one stable public URL
 * and uses it, so a domain move needs no code change — only a console edit.
 */
export async function googleRedirectUri(): Promise<string> {
  const base =
    process.env.NODE_ENV === 'production' ? await getPublicUrl() : 'http://localhost:3000';
  return `${base}/auth/google/callback`;
}

/** Read one cookie off the request (no cookie plugin — five lines of parsing). */
function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function setOauthCookie(reply: FastifyReply, value: string): void {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/auth',
    `Max-Age=${COOKIE_MAX_AGE_S}`,
  ];
  // Secure only in production: dev's callback is plain http://localhost:3000,
  // and a Secure cookie would never be sent back there.
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  reply.header('Set-Cookie', attrs.join('; '));
}

/** Clear it on EVERY callback — success or failure, the pair is spent. */
function clearOauthCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0`);
}

/** Constant-time string compare that tolerates unequal lengths. */
function sameString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The browser-facing failure page. Plain HTML with inline STYLE attributes and
 * no script of any kind, which is what API_HTML_CSP (src/api/app.ts) allows —
 * same shape as the Slack OAuth result page.
 */
function signInErrorPage(reply: FastifyReply, status: number, message: string): FastifyReply {
  reply.code(status).header('content-type', 'text/html; charset=utf-8');
  return reply.send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Sign-in failed</title></head>` +
      `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f7f8;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#1a1a1a">` +
      `<div style="background:#fff;border-radius:12px;padding:40px 48px;box-shadow:0 1px 4px rgba(0,0,0,.08);` +
      `max-width:420px;text-align:center">` +
      `<h1 style="font-size:20px;margin:0 0 12px">Sign-in expired</h1>` +
      `<p style="font-size:15px;line-height:1.5;color:#555;margin:0">${message}</p>` +
      `</div></body></html>`,
  );
}

const TRY_AGAIN = 'This sign-in expired — return to the login page and try again.';

// ---------------------------------------------------------------- id_token --

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

/**
 * Decode the id_token payload WITHOUT verifying its signature.
 *
 * This is deliberate and it is what Google's own documentation blesses for
 * this exact flow ("Obtain user information from the ID token" — validation
 * may be skipped when the token comes straight from Google's token endpoint):
 * we did not receive this token from the browser, we fetched it ourselves over
 * TLS from oauth2.googleapis.com, using a client secret only we hold, against
 * a code bound to our PKCE verifier. There is no attacker position between us
 * and Google to forge it from, so a JWKS fetch + RS256 verify would add a
 * network dependency and a key-rotation failure mode to buy nothing.
 *
 * (If this token ever starts arriving from anywhere else — a client-side
 * flow, a mobile app posting it to us — this shortcut becomes a forgery hole
 * and full signature verification becomes mandatory. It is safe HERE because
 * of WHERE it comes from, not because of what it contains.)
 */
export function decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Everything the claims must satisfy before they are allowed to name a user.
 * Returns the identity, or a short reason for the log.
 */
export function validateIdTokenClaims(
  claims: Record<string, unknown> | null,
  clientId: string,
  nowMs = Date.now(),
): { identity: GoogleIdentity } | { error: string } {
  if (!claims) return { error: 'unparseable id_token' };

  const iss = typeof claims.iss === 'string' ? claims.iss : '';
  if (!VALID_ISSUERS.has(iss)) return { error: `unexpected iss: ${iss || '(none)'}` };

  // aud pins the token to OUR client. Without it, an id_token minted for any
  // other Google app could be replayed at us and would name a real Google user.
  if (claims.aud !== clientId) return { error: 'aud is not our client id' };

  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  if (exp * 1000 <= nowMs) return { error: 'id_token expired' };

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) return { error: 'no sub claim' };

  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (!email) return { error: 'no email claim' };

  // VERIFIED EMAILS ONLY. The email is what links a Google identity onto an
  // existing password account, so an unverified address would let anyone who
  // can get an identity provider to emit `email: victim@corp.com` walk into
  // that account. `email_verified: true` is Google saying it has proof the
  // person controls that mailbox — that vouching is the entire basis on which
  // we are willing to treat the address as an identity. Note the strict ===:
  // some providers send the string "true", and a truthy check would accept
  // "false" just as happily.
  if (claims.email_verified !== true) return { error: 'email not verified by google' };

  const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : '';
  return { identity: { sub, email, name } };
}

/**
 * Trade the authorization code for tokens. Plain global fetch (undici) — no
 * client library — so the request body is exactly the six documented form
 * fields and tests can stub `globalThis.fetch` the way the SMS suite does.
 */
async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`google token endpoint returned ${res.status}`);
  }
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error('google token response carried no id_token');
  return body.id_token;
}

// ----------------------------------------------------------- account model --

/**
 * What a Google sign-in resolved to. A union rather than `User | null` because
 * B1 added a THIRD outcome that must not be rendered as a failure: "you are not
 * in the beta yet" is not an error, it is a redirect to the request form.
 */
export type GoogleSignIn =
  | { user: User }
  /** The address belongs to a different Google account — we refuse to re-point it. */
  | { refused: 'conflict' }
  /** B1 invite mode: no live invite for this address, so nothing was created. */
  | { refused: 'invite' };

/**
 * Resolve a Google identity to one of our users, creating the account on first
 * sight. Three cases, in this order:
 *
 *   (a) we know this `sub`            -> that user, always. The join key is the
 *                                        immutable one, so a Google account
 *                                        that changed its address still lands
 *                                        on the same row.
 *   (b) we know this verified email   -> LINK: stamp the sub onto the existing
 *                                        password account. They keep their
 *                                        password AND gain the Google door;
 *                                        nothing about their data moves.
 *   (c) neither                       -> create a passwordless user and give it
 *                                        the same org + environments + api keys
 *                                        /auth/signup provisions.
 *
 * The (c)->(b) fallback covers the race where two callbacks for the same new
 * address arrive at once: the losing insert returns null and the loser links
 * instead, so both requests end at one user.
 *
 * B1 gates case (c) ONLY. Cases (a) and (b) are people who already exist here —
 * an invite gate that turned an existing customer away from a door they have
 * always used would be a lockout, not a gate — so the beta never touches them.
 */
export async function findOrCreateGoogleUser(identity: GoogleIdentity): Promise<GoogleSignIn> {
  const bySub = await getUserByGoogleSub(identity.sub);
  if (bySub) return { user: bySub };

  const byEmail = await getUserByEmail(identity.email);
  if (byEmail) {
    // Already carrying a DIFFERENT sub (two Google accounts, one address —
    // possible after a Workspace migration): linkGoogleSub returns null and we
    // refuse rather than silently re-point the account.
    if (byEmail.google_sub === identity.sub) return { user: byEmail };
    const linked = await linkGoogleSub(byEmail.id, identity.sub);
    return linked ? { user: linked } : { refused: 'conflict' };
  }

  /**
   * B1 — the invite gate on the CREATE branch.
   *
   * A Google sign-in carries no invite code (nobody clicked a link out of our
   * email to get here), so the thing being matched is the ADDRESS Google has
   * vouched for — which is exactly as strong as the code path's check, because
   * `email_verified` is already required above and the code path also insists
   * the invite was issued to the address being registered.
   *
   * Consumed BEFORE creating, for the same reason and with the same trade as
   * the password door: the atomic UPDATE is what makes one invite mean one
   * account even when two tabs race.
   */
  if (env.signupMode === 'invite') {
    const invite = await findLiveInviteForEmail(identity.email);
    if (!invite) return { refused: 'invite' };
    if (!(await consumeAccessRequest(invite.id))) return { refused: 'invite' };
  }

  const created = await createGoogleUser(
    identity.email,
    identity.name || identity.email.split('@')[0],
    identity.sub,
  );
  if (!created) {
    const raced = await getUserByEmail(identity.email);
    if (!raced) return { refused: 'conflict' };
    if (raced.google_sub === identity.sub) return { user: raced };
    const linked = await linkGoogleSub(raced.id, identity.sub);
    return linked ? { user: linked } : { refused: 'conflict' };
  }

  await provisionAccount(created, defaultOrganizationName(created.name, created.email));

  /**
   * U5 — the second (and last) sign-up door arms the first-run tour, for the
   * reasons spelled out beside the first one in routes/auth.ts: the fact being
   * recorded is "a person just created an account here", which only a door
   * knows. Note WHERE this sits — inside the create branch, after the insert
   * that actually made a row. Cases (a) and (b) above are people who already
   * had an account (a returning Google user, or a password account gaining the
   * Google door) and must never be handed a tour of a product they use daily.
   *
   * `created` is the row as inserted, so its in-memory `tour_pending` is stale
   * from here on. Nothing reads it — the caller only mints a session — and
   * /auth/me re-reads the row on the next request.
   */
  await setTourPending(created.id, true);

  return { user: created };
}

// --------------------------------------------------------------- the routes --

export function registerGoogleAuthRoutes(app: FastifyInstance) {
  /**
   * What sign-in doors this deployment has. The dashboard fetches it once on
   * the login page to decide whether to render the Google button — a build-time
   * flag would have meant one dashboard bundle per deployment, and a hidden
   * button that 404s is worse than no button.
   *
   * B1 puts `signupMode` here for the same reason and on the same trip: the
   * login page has to know whether to offer "Create an account" or "Request
   * access", and it already asks this question. Publishing the mode leaks
   * nothing — anyone can discover it by trying to sign up, and a beta that
   * hides the fact that it is a beta just wastes the applicant's time.
   */
  app.get(
    '/auth/methods',
    { preHandler: [ipRateLimit('auth-methods', GOOGLE_PER_MIN)] },
    async () => ({ google: googleAuthEnabled(), signupMode: env.signupMode }),
  );

  /** Step 1: mint state + PKCE, park them in a cookie, bounce to Google. */
  app.get(
    '/auth/google',
    { preHandler: [ipRateLimit('google-auth', GOOGLE_PER_MIN)] },
    async (_req, reply) => {
      if (!googleAuthEnabled()) return reply.code(404).send({ error: 'not found' });

      // state: CSRF. Only a browser that started here holds the cookie half,
      // so a callback forged by another site cannot match it.
      const state = randomBytes(32).toString('hex');
      // PKCE: 43 chars of base64url, at the low end of the legal 43-128 range.
      // It binds the authorization code to THIS browser's session — a stolen
      // code is useless without the verifier, which never leaves this server.
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');

      setOauthCookie(reply, `${state}.${verifier}`);

      const url = new URL(AUTHORIZE_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: env.google.clientId,
        redirect_uri: await googleRedirectUri(),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        // Always show the account chooser: without it Google silently reuses
        // whichever account the browser is already signed into, which is the
        // wrong default for a tool people use with a work account on a
        // personal machine.
        prompt: 'select_account',
      }).toString();

      return reply.redirect(url.toString(), 302);
    },
  );

  /** Step 2: Google sends the browser back here with a code. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    { preHandler: [ipRateLimit('google-callback', GOOGLE_PER_MIN)] },
    async (req, reply) => {
      if (!googleAuthEnabled()) return reply.code(404).send({ error: 'not found' });

      const cookie = readCookie(req, COOKIE_NAME);
      // Spent either way: one cookie buys one callback, so a replayed callback
      // URL out of someone's history finds nothing to match against.
      clearOauthCookie(reply);

      if (req.query.error) {
        return signInErrorPage(reply, 400, 'Google sign-in was cancelled. You can try again.');
      }

      const dot = cookie ? cookie.indexOf('.') : -1;
      const cookieState = dot > 0 ? cookie!.slice(0, dot) : '';
      const verifier = dot > 0 ? cookie!.slice(dot + 1) : '';
      const { code, state } = req.query;

      if (!code || !state || !cookieState || !verifier || !sameString(cookieState, state)) {
        return signInErrorPage(reply, 400, TRY_AGAIN);
      }

      let idToken: string;
      try {
        idToken = await exchangeCode(code, verifier, await googleRedirectUri());
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'google sign-in: code exchange failed');
        return signInErrorPage(reply, 400, TRY_AGAIN);
      }

      const claims = validateIdTokenClaims(
        decodeIdTokenPayload(idToken),
        env.google.clientId,
      );
      if ('error' in claims) {
        logger.warn({ reason: claims.error }, 'google sign-in: id_token rejected');
        return signInErrorPage(
          reply,
          400,
          'Google could not confirm this account. Make sure the email address on it is verified, then try again.',
        );
      }

      const resolved = await findOrCreateGoogleUser(claims.identity);

      /**
       * B1 — the beta bounce. Not an error page: this person did everything
       * right, they are simply not on the list yet, so they get sent to the
       * login page with `?gate=request`, which renders the request-access form
       * with a line explaining why. Nothing was created for them.
       */
      if ('refused' in resolved && resolved.refused === 'invite') {
        logger.info({ email: claims.identity.email }, 'google sign-in: no invite, bounced to request form');
        return reply.redirect(`${env.google.postLoginOrigin}/login?gate=request`, 302);
      }

      if ('refused' in resolved) {
        logger.warn({ sub: claims.identity.sub }, 'google sign-in: could not resolve a user');
        return signInErrorPage(
          reply,
          400,
          'An account already exists for this email address. Log in with your password instead.',
        );
      }
      const { user } = resolved;

      /**
       * THE ONE-TIME-CODE HOP. Two reasons the tokens are not simply put in
       * this redirect:
       *
       *  1. Tokens must never ride a URL. A URL lands in browser history, in
       *     the Referer of anything the next page loads, and in every proxy
       *     and access log on the way — a session token there outlives the
       *     session by however long the logs do.
       *  2. In dev this callback is served by the API on :3000 while the SPA
       *     lives on :5173. Only the SPA's own origin may write the
       *     localStorage the session lives in, so the browser has to be
       *     standing on that origin when the tokens are handed over. The code
       *     is the thing that survives the origin change; the SPA redeems it
       *     from home.
       *
       * Single-use (GETDEL) with a 5-minute TTL: it is worthless the instant
       * it is spent and it expires on its own if the tab is closed.
       */
      const loginCode = randomBytes(32).toString('hex');
      await redis.set(loginCodeKey(loginCode), user.id, 'EX', LOGIN_CODE_TTL_S);

      // Empty origin = same origin (production, one host behind Caddy).
      return reply.redirect(`${env.google.postLoginOrigin}/login?gcode=${loginCode}`, 302);
    },
  );

  /** Step 3: the SPA, on its own origin, trades the code for a session. */
  app.post(
    '/auth/google/redeem',
    { preHandler: [ipRateLimit('google-redeem', GOOGLE_PER_MIN)] },
    async (req, reply) => {
      if (!googleAuthEnabled()) return reply.code(404).send({ error: 'not found' });

      const parsed = RedeemSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

      // GETDEL, not GET-then-DEL: the read and the burn are one atomic step,
      // so two tabs racing the same code cannot both get a session out of it.
      const userId = await redis.getdel(loginCodeKey(parsed.data.code));
      if (!userId) return reply.code(401).send({ error: 'sign-in expired — try again' });

      const user = await getUserById(userId);
      if (!user) return reply.code(401).send({ error: 'sign-in expired — try again' });

      return sessionResponse(app, user);
    },
  );
}
