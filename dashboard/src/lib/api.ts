/**
 * API client for the dashboard. JWT access/refresh tokens + the selected
 * environment id travel on every request; a 401 triggers one silent refresh
 * before giving up and returning to /login.
 */

const KEYS = {
  access: 'nk_access',
  refresh: 'nk_refresh',
  env: 'nk_env',
} as const;

export const session = {
  get access() {
    return localStorage.getItem(KEYS.access);
  },
  get refresh() {
    return localStorage.getItem(KEYS.refresh);
  },
  get envId() {
    return localStorage.getItem(KEYS.env);
  },
  setTokens(access: string, refresh?: string) {
    localStorage.setItem(KEYS.access, access);
    if (refresh) localStorage.setItem(KEYS.refresh, refresh);
  },
  setEnv(envId: string) {
    localStorage.setItem(KEYS.env, envId);
    // localStorage is not reactive: anything RENDERING the selected env (the
    // Shell's switcher) must hear about this, or a controlled dropdown snaps
    // back to the stale value while the data pages move on (caught in A10
    // manual E2E). One event covers every setEnv call site — the switcher
    // itself, login, and a cross-env promote's "switch and open it".
    window.dispatchEvent(new Event('asyncify:env-changed'));
  },
  clear() {
    Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  },
  get authed() {
    return Boolean(this.access);
  },
};

/**
 * Subscribe to `setEnv` (above) — the other half of the event it dispatches,
 * shaped for `useSyncExternalStore`. It lives here rather than in one consumer
 * because more than one screen renders the selected environment (the Shell's
 * switcher, Settings' organization card), and localStorage is not reactive:
 * without this they read a stale value until something else re-renders them.
 */
export function subscribeToEnv(onChange: () => void) {
  window.addEventListener('asyncify:env-changed', onChange);
  return () => window.removeEventListener('asyncify:env-changed', onChange);
}

/* ---------- U6: the keys a brand-new account was provisioned with ---------- */

/**
 * One API key minted during sign-up, as both doors hand it over. The shape is
 * the server's (`src/auth/provisioning.ts`).
 */
export interface InitialApiKey {
  environmentId: string;
  environmentName: string;
  apiKey: string;
}

/**
 * U6 — the one-time reveal's carrier, between "the account was just created"
 * and "the API keys page is on screen".
 *
 * MODULE MEMORY, deliberately, and never localStorage/sessionStorage: these are
 * plaintext API keys, and the entire premise of showing them once is that they
 * are not persisted anywhere. A page reload loses them, which is the SAME
 * outcome as dismissing the modal — the account is fine, and a replacement key
 * is two clicks away on the page they are standing on. Persisting them to buy a
 * refresh-proof reveal would trade the property that makes them safe for a
 * convenience nobody asked for.
 *
 * Client-side navigation does NOT lose them (this module outlives every route),
 * which is what lets a new user land on Overview, wander, and still be shown
 * their keys when they reach /keys.
 */
let stashedInitialApiKeys: InitialApiKey[] | null = null;

export function setInitialApiKeys(keys: InitialApiKey[] | undefined): void {
  stashedInitialApiKeys = keys && keys.length > 0 ? keys : null;
}

/** Read AND clear — a reveal happens once, so the second reader gets nothing. */
export function takeInitialApiKeys(): InitialApiKey[] | null {
  const keys = stashedInitialApiKeys;
  stashedInitialApiKeys = null;
  return keys;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The full parsed error body — carries structured fields like a 409's
     *  `currentKeys`/`limits`. Optional so existing throwers stay unchanged. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function rawRequest(path: string, options: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (session.access) headers.authorization = `Bearer ${session.access}`;
  // The selected environment is the DEFAULT, not a floor: an explicit
  // `x-environment-id` from the caller wins. That is what lets one screen talk
  // to a SIBLING environment without switching the whole app into it (A10
  // promote reads from here and writes to there, in one flow).
  //
  // This does not widen anything: the access token identifies the USER, not an
  // environment, and the server authorizes every request by looking the env up
  // and checking the user's membership of its organization (src/api/auth.ts).
  // Naming another env in this header can only reach environments the signed-in
  // user is already a member of — the same check that guards the switcher.
  if (!headers['x-environment-id'] && session.envId) {
    headers['x-environment-id'] = session.envId;
  }
  return fetch(path, { ...options, headers });
}

async function tryRefresh(): Promise<boolean> {
  if (!session.refresh) return false;
  const res = await fetch('/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refresh }),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { accessToken: string };
  session.setTokens(body.accessToken);
  return true;
}

export async function api<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    /**
     * Run this ONE request against another environment of the user's org,
     * leaving the app's selected environment (and therefore the whole query
     * cache) alone. Used by promote; see the note in `rawRequest`.
     */
    envId?: string;
  } = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.envId ? { headers: { 'x-environment-id': options.envId } } : {}),
  };

  let res = await rawRequest(path, init);
  if (res.status === 401 && session.refresh && !path.startsWith('/auth/')) {
    if (await tryRefresh()) {
      res = await rawRequest(path, init);
    } else {
      session.clear();
      window.location.href = '/login';
    }
  }

  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `request failed (${res.status})`, body);
  }
  return body as T;
}

// ---------- typed helpers ----------

export interface Environment {
  id: string;
  name: string;
  rateLimitPerSec: number;
}

export interface Org {
  id: string;
  name: string;
  role: string;
  environments: Environment[];
}

export interface Me {
  user: { id: string; name: string; email: string };
  organizations: Org[];
  /**
   * S1.7a — whether this account has a password at all. False for an account
   * that has only ever signed in with Google, which is what makes the Password
   * card show "Set a password" instead of asking for a current one.
   *
   * Optional in the type because the sign-in responses below reuse `Me` and do
   * not carry it; only /auth/me does.
   */
  hasPassword?: boolean;
  /**
   * B1 — whether this account holds the human operator seat (its address is in
   * the deployment's OPERATOR_EMAILS). It decides ONE thing here: whether the
   * Requests nav item and page render. It is not a permission — every operator
   * route re-checks server-side, so flipping this in a console buys a 403.
   *
   * Optional for the same reason as `hasPassword`: only /auth/me carries it.
   */
  operator?: boolean;
  /**
   * U5 — whether this account still owes its first-run product tour. Set true
   * by the sign-up doors, cleared by the first exit from the tour (finish or
   * skip). The server owns it, so the tour survives signing up on one machine
   * and first opening the dashboard on another.
   *
   * Optional for the same reason as the two above: only /auth/me carries it.
   */
  tourPending?: boolean;
}

export const fetchMe = () => api<Me>('/auth/me');

type SignedIn = Me & { accessToken: string; refreshToken: string };

/** Store a fresh session and pick a default environment. One code path for
 *  every sign-in door — password today, Google (S1.6) alongside it. */
function adoptSession(res: SignedIn): SignedIn {
  session.setTokens(res.accessToken, res.refreshToken);
  const firstEnv = res.organizations[0]?.environments[0];
  if (firstEnv && !session.envId) session.setEnv(firstEnv.id);
  return res;
}

export async function login(email: string, password: string) {
  return adoptSession(
    await api<SignedIn>('/auth/login', { method: 'POST', body: { email, password } }),
  );
}

export interface AuthMethods {
  google: boolean;
  /**
   * B1 — 'open' is self-serve signup; 'invite' replaces the signup card with a
   * request-access form everywhere except a URL that already carries a code.
   */
  signupMode: 'open' | 'invite';
}

/** Which sign-in doors this deployment offers. Cheap and public — the login
 *  page asks once so the Google button only appears where it works, and so it
 *  knows whether new people sign up or ask. */
export const fetchAuthMethods = () => api<AuthMethods>('/auth/methods');

/**
 * Trade the one-time code the Google callback put in our URL for a real
 * session. This runs on the SPA's OWN origin, which is the whole point of the
 * code hop: the callback lands on the API's origin, and only this origin may
 * write the localStorage the session lives in (src/api/routes/google-auth.ts).
 */
export async function redeemGoogleCode(code: string) {
  const res = await api<SignedIn & { initialApiKeys?: InitialApiKey[] }>('/auth/google/redeem', {
    method: 'POST',
    body: { code },
  });
  // U6 — present only when THIS sign-in created the account. A returning user
  // (or a password account that just gained the Google door) gets no field at
  // all, so nothing is stashed and nothing is revealed.
  setInitialApiKeys(res.initialApiKeys);
  return adoptSession(res);
}

export async function signup(input: {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  /**
   * B1 — the code out of an invite email. Required by the server only when the
   * deployment runs SIGNUP_MODE=invite; sent as undefined otherwise, where it
   * is ignored entirely.
   */
  inviteCode?: string;
}) {
  const res = await api<{
    accessToken: string;
    refreshToken: string;
    environments: Array<{ id: string; name: string; apiKey: string }>;
    initialApiKeys?: InitialApiKey[];
  }>('/auth/signup', { method: 'POST', body: input });
  session.setTokens(res.accessToken, res.refreshToken);
  // U6 — every signup created an account, so these are always here.
  setInitialApiKeys(res.initialApiKeys);
  const dev = res.environments.find((e) => e.name === 'Development') ?? res.environments[0];
  if (dev) session.setEnv(dev.id);
  return res;
}

/* ---------- U2: organization ---------- */

/**
 * Rename the caller's organization. Which organization that is comes from the
 * `x-environment-id` every request already carries — the server resolves it
 * through the environment's owner and checks the caller's membership role, so
 * this body is just the new name. Owner/admin only; a member gets a 403 whose
 * message the Settings card shows verbatim.
 */
export const renameOrganization = (name: string) =>
  api<{ organization: { id: string; name: string } }>('/v1/account/organization', {
    method: 'PATCH',
    body: { name },
  });

/* ---------- S1.7a: passwords ---------- */

/**
 * Set or change the signed-in user's password. `currentPassword` is omitted
 * for an account that has none yet (Google-only) — the server decides which
 * shape applies from the row, so sending it there would just be ignored.
 */
export const changePassword = (input: { currentPassword?: string; newPassword: string }) =>
  api<{ ok: true }>('/auth/password', { method: 'POST', body: input });

/**
 * Ask for a reset link. ALWAYS resolves — the server answers 200 whether or
 * not the address is registered, and the UI must say the same thing either
 * way, or the dashboard becomes the enumeration oracle the endpoint isn't.
 */
export const requestPasswordReset = (email: string) =>
  api<{ ok: true }>('/auth/forgot', { method: 'POST', body: { email } });

/** Spend a reset token. Mints no session: the user logs in with the new one. */
export const resetPassword = (token: string, newPassword: string) =>
  api<{ ok: true }>('/auth/reset', { method: 'POST', body: { token, newPassword } });

/* ---------- U5: the first-run tour ---------- */

/**
 * "I have seen the tour." One call, no body, fired on ANY exit — finishing the
 * last stop, closing it, or pressing Escape. Idempotent server-side, which is
 * what lets the caller fire it without awaiting or retrying: the worst case is
 * a second identical write.
 */
export const markTourDone = () => api<{ ok: true }>('/auth/tour-done', { method: 'POST' });

/* ---------- B1: the beta gate ---------- */

/**
 * Ask to be let in. ALWAYS resolves for a well-formed body — the server answers
 * the same 200 whether this is a first ask, a repeat, an address that was
 * already declined, or one that already has an account, and the UI must say the
 * same thing to all four or it becomes the enumeration oracle the endpoint
 * refuses to be.
 */
export const requestAccess = (input: { name: string; email: string; useCase: string }) =>
  api<{ ok: true }>('/auth/request-access', { method: 'POST', body: input });

export interface AccessRequestRow {
  id: string;
  name: string;
  email: string;
  useCase: string;
  status: 'pending' | 'approved' | 'declined';
  createdAt: string;
  decidedAt: string | null;
  inviteExpiresAt: string | null;
  consumedAt: string | null;
}

/** Operator-only (OPERATOR_EMAILS); anyone else gets a 403 from all three. */
export const listAccessRequests = (status: 'pending' | 'approved' | 'declined') =>
  api<{ requests: AccessRequestRow[] }>(`/v1/ops/access-requests?status=${status}`);

/** Also the RESEND path: approving an already-approved row re-mints its code. */
export const approveAccessRequest = (id: string) =>
  api<{ request: AccessRequestRow }>(`/v1/ops/access-requests/${id}/approve`, { method: 'POST' });

export const declineAccessRequest = (id: string) =>
  api<{ request: AccessRequestRow }>(`/v1/ops/access-requests/${id}/decline`, { method: 'POST' });

export function logout() {
  session.clear();
  window.location.href = '/login';
}
