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
    // Shell's switcher) must hear about this, or a controlled <select> snaps
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
}

export const fetchMe = () => api<Me>('/auth/me');

export async function login(email: string, password: string) {
  const res = await api<Me & { accessToken: string; refreshToken: string }>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  session.setTokens(res.accessToken, res.refreshToken);
  const firstEnv = res.organizations[0]?.environments[0];
  if (firstEnv && !session.envId) session.setEnv(firstEnv.id);
  return res;
}

export async function signup(input: {
  name: string;
  email: string;
  password: string;
  organizationName: string;
}) {
  const res = await api<{
    accessToken: string;
    refreshToken: string;
    environments: Array<{ id: string; name: string; apiKey: string }>;
  }>('/auth/signup', { method: 'POST', body: input });
  session.setTokens(res.accessToken, res.refreshToken);
  const dev = res.environments.find((e) => e.name === 'Development') ?? res.environments[0];
  if (dev) session.setEnv(dev.id);
  return res;
}

export function logout() {
  session.clear();
  window.location.href = '/login';
}
