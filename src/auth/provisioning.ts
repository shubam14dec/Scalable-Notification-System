import {
  addMember,
  createApiKey,
  createEnvironment,
  createOrganization,
  type Organization,
  type User,
} from '../db/accounts.repo';

/**
 * What a brand-new account gets, once, whichever door it came through.
 *
 * Extracted from the /auth/signup handler in S1.6, when "Continue with Google"
 * became a SECOND way to create an account. Two copies of this block would
 * have drifted the first time the shape changed — a third environment, a
 * different default rate limit, a starter workflow — and the drift would be
 * invisible until a Google-created tenant hit a feature the password-created
 * ones had. One function, one meaning of "a new account".
 */

/** The environments a fresh account starts with, in creation order. */
const STARTER_ENVIRONMENTS = ['Development', 'Production'] as const;

export interface ProvisionedEnvironment {
  id: string;
  name: string;
  /** Plaintext API key — returned to this ONE response and never again. */
  apiKey: string;
}

export interface ProvisionedAccount {
  organization: Organization;
  environments: ProvisionedEnvironment[];
}

/**
 * Give `user` an organization (as its owner), the starter environments, and
 * one API key per environment. The plaintext keys travel back to the caller so
 * the sign-up response can show them once; only their hashes are stored.
 */
export async function provisionAccount(
  user: User,
  organizationName: string,
): Promise<ProvisionedAccount> {
  const organization = await createOrganization(organizationName);
  await addMember(organization.id, user.id, 'owner');

  const environments: ProvisionedEnvironment[] = [];
  for (const envName of STARTER_ENVIRONMENTS) {
    const environment = await createEnvironment(organization.id, envName);
    const key = await createApiKey(environment.id, 'default', envName, user.id);
    environments.push({
      id: environment.id,
      name: envName,
      apiKey: key.plaintext, // shown once, never retrievable again
    });
  }

  return { organization, environments };
}

/**
 * The organization name for an account created through an identity provider,
 * where the user never typed one. Their display name is the closest thing to
 * an intent we have; the email local part is the fallback when the provider
 * sent no name. Renameable in the dashboard afterwards like any other org.
 */
export function defaultOrganizationName(displayName: string, email: string): string {
  const who = displayName.trim() || email.split('@')[0];
  return `${who}'s Organization`;
}
