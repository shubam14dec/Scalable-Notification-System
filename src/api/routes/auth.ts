import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../../auth/password';
import {
  createUser,
  getUserByEmail,
  getUserById,
  organizationsForUser,
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
 */
const LOGIN_PER_MIN = 10;
const SIGNUP_PER_MIN = 3;
const REFRESH_PER_MIN = 30;

const SignupSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  organizationName: z.string().min(1).max(255),
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
    };
  });
}
