import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { hashPassword, verifyPassword } from '../../auth/password';
import {
  addMember,
  createApiKey,
  createEnvironment,
  createOrganization,
  createUser,
  getUserByEmail,
  getUserById,
  organizationsForUser,
} from '../../db/accounts.repo';
import { requireUser } from '../jwt-auth';

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

export function registerAuthRoutes(app: FastifyInstance) {
  const tokens = (userId: string) => ({
    accessToken: app.jwt.sign({ sub: userId, type: 'access' }, { expiresIn: env.accessTokenTtl }),
    refreshToken: app.jwt.sign(
      { sub: userId, type: 'refresh' },
      { expiresIn: env.refreshTokenTtl },
    ),
  });

  /**
   * Self-serve onboarding: one call creates the user, their organization,
   * Development + Production environments, and one API key per environment.
   * The plaintext keys appear in THIS response only — they are stored hashed.
   */
  app.post('/auth/signup', async (req, reply) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const body = parsed.data;

    const user = await createUser(body.email, body.name, await hashPassword(body.password));
    if (!user) {
      return reply.code(409).send({ error: 'an account with this email already exists' });
    }

    const organization = await createOrganization(body.organizationName);
    await addMember(organization.id, user.id, 'owner');

    const environments = [];
    for (const envName of ['Development', 'Production']) {
      const environment = await createEnvironment(organization.id, envName);
      const key = await createApiKey(environment.id, 'default', envName, user.id);
      environments.push({
        id: environment.id,
        name: envName,
        apiKey: key.plaintext, // shown once, never retrievable again
      });
    }

    return reply.code(201).send({
      user: { id: user.id, name: user.name, email: user.email },
      organization,
      environments,
      ...tokens(user.id),
    });
  });

  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body' });
    }
    const user = await getUserByEmail(parsed.data.email);
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      // Same response for unknown email and wrong password.
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    return {
      user: { id: user.id, name: user.name, email: user.email },
      organizations: await organizationsForUser(user.id),
      ...tokens(user.id),
    };
  });

  app.post('/auth/refresh', async (req, reply) => {
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
