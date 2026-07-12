/**
 * Thin fetch wrapper for the Asyncify ops API. No retries — callers decide
 * (rewire retries a single reconnect; the watchdog handles rotation).
 */

export interface ApiResponse {
  status: number;
  json: unknown;
}

export async function apiFetch(
  baseUrl: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
