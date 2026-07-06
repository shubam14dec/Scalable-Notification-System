import { createHash, randomBytes } from 'node:crypto';
import { pool } from './pool';
import type { Tenant } from './repositories';

export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

export interface Organization {
  id: string;
  name: string;
}

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
}

// ---------- users ----------

export async function createUser(
  email: string,
  name: string,
  passwordHash: string,
): Promise<User | null> {
  const { rows } = await pool.query(
    `insert into users (email, name, password_hash) values ($1, $2, $3)
     on conflict (email) do nothing
     returning *`,
    [email.toLowerCase(), name, passwordHash],
  );
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const { rows } = await pool.query('select * from users where email = $1', [
    email.toLowerCase(),
  ]);
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<User | null> {
  const { rows } = await pool.query('select * from users where id = $1', [id]);
  return rows[0] ?? null;
}

// ---------- organizations & membership ----------

export async function createOrganization(name: string): Promise<Organization> {
  const { rows } = await pool.query(
    'insert into organizations (name) values ($1) returning *',
    [name],
  );
  return rows[0];
}

export async function addMember(
  organizationId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<void> {
  await pool.query(
    `insert into org_members (organization_id, user_id, role) values ($1, $2, $3)
     on conflict (organization_id, user_id) do update set role = excluded.role`,
    [organizationId, userId, role],
  );
}

export async function membershipRole(
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    'select role from org_members where organization_id = $1 and user_id = $2',
    [organizationId, userId],
  );
  return rows[0]?.role ?? null;
}

/** All orgs a user belongs to, each with its environments. */
export async function organizationsForUser(userId: string) {
  const { rows } = await pool.query(
    `select o.id as org_id, o.name as org_name, m.role,
            t.id as env_id, t.name as env_name, t.rate_limit_per_sec
     from org_members m
     join organizations o on o.id = m.organization_id
     left join tenants t on t.organization_id = o.id
     where m.user_id = $1
     order by o.name, t.name`,
    [userId],
  );
  const orgs = new Map<
    string,
    {
      id: string;
      name: string;
      role: string;
      environments: Array<{ id: string; name: string; rateLimitPerSec: number }>;
    }
  >();
  for (const r of rows) {
    let org = orgs.get(r.org_id);
    if (!org) {
      org = { id: r.org_id, name: r.org_name, role: r.role, environments: [] };
      orgs.set(r.org_id, org);
    }
    if (r.env_id) {
      org.environments.push({
        id: r.env_id,
        name: r.env_name,
        rateLimitPerSec: r.rate_limit_per_sec,
      });
    }
  }
  return [...orgs.values()];
}

// ---------- environments (rows in `tenants`) ----------

export async function createEnvironment(
  organizationId: string,
  name: string,
  rateLimitPerSec = 50,
): Promise<Tenant> {
  const { rows } = await pool.query(
    `insert into tenants (name, organization_id, rate_limit_per_sec)
     values ($1, $2, $3) returning *`,
    [name, organizationId, rateLimitPerSec],
  );
  return rows[0];
}

export async function getEnvironment(
  envId: string,
): Promise<(Tenant & { organization_id: string | null }) | null> {
  const { rows } = await pool.query('select * from tenants where id = $1', [envId]);
  return rows[0] ?? null;
}

// ---------- api keys (hashed; plaintext returned exactly once) ----------

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function createApiKey(
  tenantId: string,
  name: string,
  envName: string,
  createdBy: string | null,
): Promise<{ row: ApiKeyRow; plaintext: string }> {
  // ak_ = "asyncify key". Legacy nk_ keys keep working (hashed lookup).
  const envSlug = envName.toLowerCase().startsWith('prod') ? 'live' : 'dev';
  const plaintext = `ak_${envSlug}_${randomBytes(24).toString('hex')}`;
  const { rows } = await pool.query(
    `insert into api_keys (tenant_id, name, key_prefix, key_hash, created_by)
     values ($1, $2, $3, $4, $5)
     returning id, tenant_id, name, key_prefix, created_at, revoked_at`,
    [tenantId, name, plaintext.slice(0, 11), hashApiKey(plaintext), createdBy],
  );
  return { row: rows[0], plaintext };
}

export async function listApiKeys(tenantId: string): Promise<ApiKeyRow[]> {
  const { rows } = await pool.query(
    `select id, tenant_id, name, key_prefix, created_at, revoked_at
     from api_keys where tenant_id = $1 order by created_at desc`,
    [tenantId],
  );
  return rows;
}

/** Returns the revoked key's hash (for auth-cache invalidation), or null. */
export async function revokeApiKey(keyId: string, tenantId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `update api_keys set revoked_at = now()
     where id = $1 and tenant_id = $2 and revoked_at is null
     returning key_hash`,
    [keyId, tenantId],
  );
  return rows[0]?.key_hash ?? null;
}

/** Resolve a plaintext API key to its environment (hashed lookup). */
export async function tenantForApiKeyHash(plaintext: string): Promise<Tenant | null> {
  const { rows } = await pool.query(
    `select t.* from api_keys k
     join tenants t on t.id = k.tenant_id
     where k.key_hash = $1 and k.revoked_at is null`,
    [hashApiKey(plaintext)],
  );
  return rows[0] ?? null;
}
