/**
 * Phase 25 slice C — the ADMIN live-events client.
 *
 * Doctrine (locked in the phase plan): "the socket is a hint, Postgres is the
 * truth." The gateway pushes tiny invalidation HINTS on a tenant-scoped admin
 * channel; this module turns each hint into ONE react-query invalidation
 * through the unchanged REST API. No row data rides the socket (queue.depths is
 * the single infra-gauge exception — same shape the /ops/queues REST endpoint
 * returns — and it is written straight into the cache, never refetched).
 *
 * Missing an event costs nothing: every (re)connect runs a catch-up sweep that
 * invalidates every mapped key once, and a 60s safety poll (per page) covers
 * total socket loss.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { session } from './api';

/**
 * The frozen union of tenant hint types (phase-25 D3). `queue.depths` is NOT a
 * member — it carries data and is handled out-of-band (setQueryData), so it can
 * never appear in the invalidation table.
 */
export type TenantEventType =
  | 'conversation.changed'
  | 'approval.changed'
  | 'eval.finished'
  | 'knowledge.changed'
  | 'message.changed'
  | 'connection.changed'
  | 'memory.changed'
  | 'queue.deadletter';

/** A react-query key prefix: invalidation matches every query whose key STARTS
 *  with this tuple (react-query's default partial match). */
export type QueryKeyPrefix = readonly unknown[];

/**
 * Single source of truth: every hint type → the react-query key prefixes to
 * invalidate. `Record<TenantEventType, …>` makes this EXHAUSTIVE at compile
 * time — add a member to the union and this object fails to typecheck until the
 * new event is mapped, so a future type can never be silently unmapped.
 *
 * Each entry is a function of the optional row id. Hints that carry an id
 * (conversation / message) refine to the specific open resource when it is
 * present and fall back to the list-level prefix when it is not; the rest
 * ignore the id.
 */
export const INVALIDATION_TABLE: Record<TenantEventType, (id?: string) => QueryKeyPrefix[]> = {
  // list refetches; when the changed conversation is known, also the open detail
  'conversation.changed': (id) =>
    id ? [['conversations'], ['conversation', id]] : [['conversations']],
  // Approvals page keys on ['approvals', status]; no sidebar badge/count query
  // exists in the dashboard today, so this prefix is the whole surface.
  'approval.changed': () => [['approvals']],
  // the runs list, the open run detail, and the eval definitions list
  'eval.finished': () => [['agent-eval-runs'], ['agent-eval-run'], ['agent-evals']],
  'knowledge.changed': () => [['agent-knowledge']],
  // id = messageId. MessageDetail keys on ['timeline', transactionId] (NOT
  // messageId — the client cannot map one to the other), so the open timeline
  // is invalidated as a prefix. ['message', id] is kept for forward-compat and
  // ['activity'] refreshes the list. See report for this deviation from D7.
  'message.changed': (id) =>
    id ? [['message', id], ['activity'], ['timeline']] : [['activity'], ['timeline']],
  'connection.changed': () => [['connections']],
  // Memory modal + conversation-detail memory block both key on ['agent-memories', …]
  'memory.changed': () => [['agent-memories']],
  // a dead-lettered job shows up in the queue gauge and the activity feed
  'queue.deadletter': () => [['queues'], ['activity']],
};

/** All hint types — used by the catch-up sweep and by tests. */
export const TENANT_EVENT_TYPES = Object.keys(INVALIDATION_TABLE) as TenantEventType[];

/**
 * WS gateway origin. The dashboard already talks to the gateway at this literal
 * (see InboxPreview's widget `wsUrl`); we reuse that mechanism rather than
 * invent an env var. Production WS-origin resolution is a deployment concern
 * (tracked in the report / DEPLOYMENT docs), shared with the existing widget.
 */
const WS_ORIGIN = 'ws://localhost:3001';

/** Auth-failure close code from the gateway (token expired / wrong org). */
const CLOSE_AUTH_FAILURE = 4401;
const NETWORK_BACKOFF_START = 1_000;
const NETWORK_BACKOFF_MAX = 30_000;
const AUTH_RETRY_DELAY = 60_000;

interface HintFrame {
  type: string;
  id?: string;
  at?: string;
  counts?: Record<string, Record<string, number>>;
}

/**
 * Opens ONE admin socket for the current env and translates hints into
 * react-query invalidations. Mount exactly once, somewhere that only renders
 * when the user is logged in AND an env is selected (the Shell). Pass the
 * selected env id: when it changes the old socket is closed and a new one is
 * opened for the new tenant.
 *
 * Reconnect policy:
 *  - network failure  → capped exponential backoff 1s → 30s (reset on connect)
 *  - auth failure 4401 → NO tight loop; retry after 60s. `session.access` is
 *    read fresh at every (re)connect, so a token the auth layer refreshed in
 *    the meantime (any REST 401 triggers one) is picked up automatically.
 *
 * On every `connected` frame it runs a catch-up sweep (invalidate all mapped
 * keys once) so events missed while disconnected cost a single refetch, never
 * staleness.
 *
 * Returns `{ connected }` for the sidebar live dot (D9).
 */
export function useAdminEvents(envId: string | undefined): { connected: boolean } {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!envId || !session.access) return;

    let closedByUs = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = NETWORK_BACKOFF_START;

    const invalidate = (keys: QueryKeyPrefix[]) => {
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    };

    // Catch-up: one invalidation of every mapped key. Cheap, idempotent.
    const catchUpSweep = () => {
      for (const type of TENANT_EVENT_TYPES) invalidate(INVALIDATION_TABLE[type]());
    };

    const connect = () => {
      const token = session.access;
      if (!token) return; // logged out mid-retry — stop
      const url = `${WS_ORIGIN}/?admin=1&token=${encodeURIComponent(token)}&env=${encodeURIComponent(envId)}`;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, NETWORK_BACKOFF_MAX);
        return;
      }
      ws = socket;

      socket.onmessage = (ev) => {
        let frame: HintFrame;
        try {
          frame = JSON.parse(ev.data as string) as HintFrame;
        } catch {
          return; // ignore non-JSON
        }

        if (frame.type === 'connected') {
          setConnected(true);
          backoff = NETWORK_BACKOFF_START;
          catchUpSweep();
          return;
        }

        if (frame.type === 'queue.depths') {
          // The one frame carrying data: infra gauge, same shape Overview's
          // ['queues'] query returns. Write it straight in — no refetch.
          if (frame.counts) queryClient.setQueryData(['queues'], frame.counts);
          return;
        }

        if (frame.type in INVALIDATION_TABLE) {
          invalidate(INVALIDATION_TABLE[frame.type as TenantEventType](frame.id));
        }
        // unknown types (e.g. a future hint before this client learns it) are
        // ignored; the safety poll and the next catch-up sweep cover the gap.
      };

      socket.onclose = (ev) => {
        setConnected(false);
        if (closedByUs) return;
        if (ev.code === CLOSE_AUTH_FAILURE) {
          // token expired / not authorized for this env: do NOT reconnect-loop.
          // Wait 60s, then retry with whatever token the auth layer now holds.
          reconnectTimer = setTimeout(connect, AUTH_RETRY_DELAY);
          return;
        }
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, NETWORK_BACKOFF_MAX);
      };

      // onerror is followed by onclose in browsers; let onclose drive reconnect.
      socket.onerror = () => {};
    };

    connect();

    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setConnected(false);
      if (ws) {
        // drop handlers before close so a late event can't fire post-unmount
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.close();
      }
    };
  }, [envId, queryClient]);

  return { connected };
}
