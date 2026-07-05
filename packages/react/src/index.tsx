import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @notify/react — drop-in notification inbox.
 *
 *   const { token } = await notify.subscriberToken(userId);  // your backend
 *   <NotificationInbox token={token} subscriberId={userId}
 *                      apiUrl="https://api.you.com" wsUrl="wss://ws.you.com" />
 *
 * The token is subscriber-scoped and short-lived — no api key ever reaches
 * the browser. Live pushes arrive over WebSocket; the durable inbox loads
 * over REST on mount/reconnect.
 */

export interface InboxItem {
  id: string;
  subject: string | null;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface UseNotificationsOptions {
  token: string;
  subscriberId: string;
  /** REST base, e.g. "https://api.example.com". Empty string = same origin. */
  apiUrl?: string;
  /** WebSocket base, e.g. "wss://ws.example.com". Omit to skip live updates. */
  wsUrl?: string;
}

export function useNotifications({ token, subscriberId, apiUrl = '', wsUrl }: UseNotificationsOptions) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const headers = useCallback(
    () => ({ 'content-type': 'application/json', 'x-subscriber-token': token }),
    [token],
  );

  // Durable inbox over REST.
  useEffect(() => {
    let alive = true;
    fetch(`${apiUrl}/v1/inbox/${encodeURIComponent(subscriberId)}`, { headers: headers() })
      .then((res) => res.json())
      .then((data: { messages: InboxItem[]; unreadCount: number }) => {
        if (!alive) return;
        setItems(data.messages ?? []);
        setUnread(data.unreadCount ?? 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [apiUrl, subscriberId, headers]);

  // Live pushes over WebSocket.
  useEffect(() => {
    if (!wsUrl) return;
    const ws = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as
          | { type: 'connected'; unreadCount: number }
          | { type: 'notification'; message: { id: string; subject: string | null; body: string; createdAt: string } };
        if (msg.type === 'connected') {
          setUnread(msg.unreadCount);
        } else if (msg.type === 'notification') {
          setItems((prev) => [
            {
              id: msg.message.id,
              subject: msg.message.subject,
              body: msg.message.body,
              read_at: null,
              created_at: msg.message.createdAt,
            },
            ...prev,
          ]);
          setUnread((n) => n + 1);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => ws.close();
  }, [wsUrl, token]);

  const markAllRead = useCallback(async () => {
    setUnread(0);
    setItems((prev) => prev.map((i) => ({ ...i, read_at: i.read_at ?? new Date().toISOString() })));
    await fetch(`${apiUrl}/v1/inbox/${encodeURIComponent(subscriberId)}/read`, {
      method: 'POST',
      headers: headers(),
      body: '{}',
    }).catch(() => undefined);
  }, [apiUrl, subscriberId, headers]);

  return { items, unread, connected, markAllRead };
}

/* ------------------------------------------------------------------ */
/* Styled drop-in component. Neutral, self-contained, themable.        */
/* ------------------------------------------------------------------ */

const palettes = {
  dark: {
    bg: '#111111',
    border: '#2a2a2a',
    text: '#ededed',
    text2: '#a1a1a1',
    hover: '#1a1a1a',
    badge: '#ededed',
    badgeText: '#111111',
  },
  light: {
    bg: '#ffffff',
    border: '#e4e4e4',
    text: '#171717',
    text2: '#666666',
    hover: '#f5f5f5',
    badge: '#171717',
    badgeText: '#ffffff',
  },
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export interface NotificationInboxProps extends UseNotificationsOptions {
  theme?: 'dark' | 'light';
  title?: string;
}

export function NotificationInbox(props: NotificationInboxProps) {
  const { theme = 'dark', title = 'Notifications' } = props;
  const { items, unread, connected, markAllRead } = useNotifications(props);
  const [open, setOpen] = useState(false);
  const c = palettes[theme];
  const font =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  return (
    <div style={{ position: 'relative', display: 'inline-block', fontFamily: font }}>
      <button
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        onClick={() => setOpen((o) => !o)}
        style={{
          position: 'relative',
          width: 34,
          height: 34,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 8,
          border: `1px solid ${c.border}`,
          background: c.bg,
          color: c.text2,
          cursor: 'pointer',
        }}
      >
        {/* bell */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -5,
              right: -5,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 8,
              background: c.badge,
              color: c.badgeText,
              fontSize: 10,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={title}
          style={{
            position: 'absolute',
            right: 0,
            top: 42,
            width: 340,
            maxHeight: 420,
            overflowY: 'auto',
            background: c.bg,
            border: `1px solid ${c.border}`,
            borderRadius: 10,
            zIndex: 1000,
            boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              borderBottom: `1px solid ${c.border}`,
              position: 'sticky',
              top: 0,
              background: c.bg,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>
              {title}
              {!connected && props.wsUrl && (
                <span style={{ marginLeft: 8, fontSize: 11, color: c.text2 }}>(offline)</span>
              )}
            </span>
            {unread > 0 && (
              <button
                onClick={() => void markAllRead()}
                style={{
                  fontSize: 12,
                  color: c.text2,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p style={{ padding: '28px 14px', textAlign: 'center', fontSize: 13, color: c.text2 }}>
              No notifications yet
            </p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                style={{
                  padding: '10px 14px',
                  borderBottom: `1px solid ${c.border}`,
                  background: item.read_at ? 'transparent' : c.hover,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: item.read_at ? 400 : 600, color: c.text }}>
                    {item.subject ?? 'Notification'}
                  </span>
                  <span style={{ fontSize: 11, color: c.text2, flexShrink: 0 }}>
                    {timeAgo(item.created_at)}
                  </span>
                </div>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: c.text2, lineHeight: 1.45 }}>
                  {item.body}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
