import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * @asyncify-hq/react — drop-in notification inbox for Asyncify.
 *
 *   const { token } = await asyncify.subscriberToken(userId);  // your backend
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
  /**
   * Which side the panel opens toward. 'right' (default) aligns the panel's
   * right edge with the bell — for bells in a top-right corner. Use 'left'
   * when the bell sits near a left sidebar or inside a clipping container.
   */
  align?: 'left' | 'right';
}

/* ------------------------------------------------------------------ */
/* Agent chat — talk to an Asyncify agent from your app.               */
/* ------------------------------------------------------------------ */

export interface ChatButton {
  id: string;
  label: string;
}

/** One choice in a select card. */
export interface CardOption {
  id: string;
  label: string;
}

/**
 * An interactive card under an agent reply — a single-select list of choices
 * or a free-text field. The answer posts an action, same as a button click.
 */
export type Card =
  | { type: 'select'; id: string; prompt?: string; options: CardOption[] }
  | { type: 'text_input'; id: string; prompt?: string; placeholder?: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  createdAt: string;
  /** Buttons offered under an agent reply; a click posts an action. */
  buttons?: ChatButton[];
  /** A card (select / text input) offered under an agent reply. */
  card?: Card;
  /** True while the optimistic copy waits for the server's 202. */
  pending?: boolean;
  /** Set when the message was edited; drives the "(edited)" marker. */
  editedAt?: string | null;
  /** Set when the message was deleted; renders a tombstone. */
  deletedAt?: string | null;
}

export interface UseAgentChatOptions {
  token: string;
  subscriberId: string;
  /** The agent's identifier from the Asyncify dashboard. */
  agentIdentifier: string;
  apiUrl?: string;
  wsUrl?: string;
}

export function useAgentChat({
  token,
  subscriberId,
  agentIdentifier,
  apiUrl = '',
  wsUrl,
}: UseAgentChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<'active' | 'resolved'>('active');
  const [connected, setConnected] = useState(false);
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const headers = useCallback(
    () => ({ 'content-type': 'application/json', 'x-subscriber-token': token }),
    [token],
  );

  const clearTyping = useCallback(() => {
    if (typingTimer.current) {
      clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    setTyping(false);
  }, []);

  // A live typing signal auto-expires after 15s if nothing follows it.
  useEffect(() => () => clearTyping(), [clearTyping]);

  // Durable transcript over REST.
  useEffect(() => {
    let alive = true;
    fetch(
      `${apiUrl}/v1/agents/${encodeURIComponent(agentIdentifier)}/conversation?subscriberId=${encodeURIComponent(subscriberId)}`,
      { headers: headers() },
    )
      .then((res) => res.json())
      .then((data: { conversation: { status: 'active' | 'resolved' } | null; messages: ChatMessage[] }) => {
        if (!alive) return;
        setMessages(data.messages ?? []);
        if (data.conversation) setStatus(data.conversation.status);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [apiUrl, agentIdentifier, subscriberId, headers]);

  // Live agent replies over the same WebSocket the inbox uses.
  useEffect(() => {
    if (!wsUrl) return;
    const ws = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(token)}`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type: string;
          conversation?: { agentIdentifier: string };
          message?: {
            id: string;
            role: 'agent';
            text: string;
            createdAt: string;
            buttons?: ChatButton[];
            card?: Card;
            editedAt?: string | null;
            deletedAt?: string | null;
          };
        };
        if (msg.conversation?.agentIdentifier !== agentIdentifier) return;
        if (msg.type === 'conversation.typing') {
          setTyping(true);
          if (typingTimer.current) clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setTyping(false), 15_000);
          return;
        }
        // Any concrete message activity retires a pending typing signal.
        if (msg.type.startsWith('conversation.message')) clearTyping();
        if (msg.type === 'conversation.message' && msg.message) {
          const incoming: ChatMessage = {
            id: msg.message.id,
            role: 'agent',
            content: msg.message.text,
            createdAt: msg.message.createdAt,
            buttons: msg.message.buttons,
            card: msg.message.card,
          };
          setMessages((prev) =>
            prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming],
          );
          setStatus('active');
        } else if (msg.type === 'conversation.message.updated' && msg.message) {
          // Plan-card finalize rides .updated: it carries the reply text and
          // its presentation (buttons/card) but no editedAt — remap those
          // only when present, and never fabricate an "(edited)" marker.
          const { id, text, editedAt, buttons, card } = msg.message;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id
                ? {
                    ...m,
                    content: text,
                    editedAt: editedAt ?? null,
                    ...(buttons !== undefined ? { buttons } : {}),
                    ...(card !== undefined ? { card } : {}),
                  }
                : m,
            ),
          );
        } else if (msg.type === 'conversation.message.deleted' && msg.message) {
          const { id, deletedAt } = msg.message;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id ? { ...m, content: '', deletedAt: deletedAt ?? null, buttons: undefined } : m,
            ),
          );
        } else if (msg.type === 'conversation.resolved') {
          setStatus('resolved');
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => ws.close();
  }, [wsUrl, token, agentIdentifier]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const messageId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Optimistic: the user's turn appears immediately.
      setMessages((prev) => [
        ...prev,
        { id: messageId, role: 'user', content: trimmed, createdAt: new Date().toISOString(), pending: true },
      ]);
      setStatus('active');
      try {
        const res = await fetch(
          `${apiUrl}/v1/agents/${encodeURIComponent(agentIdentifier)}/messages`,
          {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ subscriberId, text: trimmed, messageId }),
          },
        );
        if (!res.ok) throw new Error(`send failed (${res.status})`);
        // The 202 body carries the durable DB row id — adopt it so a later
        // edit/delete targets a real row. A duplicate:true 200 has no
        // messageId; keep the client id in that case.
        const body = (await res.json().catch(() => ({}))) as { messageId?: string };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, id: body.messageId ?? m.id, pending: false } : m,
          ),
        );
      } catch {
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
        throw new Error('message not sent — check your connection and try again');
      }
    },
    [apiUrl, agentIdentifier, subscriberId, headers],
  );

  /**
   * Answer an interactive element — a button click, a card select, or a card
   * text input. Appears in the transcript as the label (or the typed value),
   * like a normal reply. `label` rides plain buttons and select answers;
   * `value` rides select (the option id) and text-input (the typed text).
   */
  const sendAction = useCallback(
    async (action: { id: string; label?: string; value?: string }) => {
      const actionEventId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const bubble = action.label ?? action.value ?? '';
      setMessages((prev) => [
        ...prev,
        { id: actionEventId, role: 'user', content: bubble, createdAt: new Date().toISOString(), pending: true },
      ]);
      setStatus('active');
      try {
        const res = await fetch(
          `${apiUrl}/v1/agents/${encodeURIComponent(agentIdentifier)}/actions`,
          {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({
              subscriberId,
              actionId: action.id,
              ...(action.label !== undefined ? { label: action.label } : {}),
              ...(action.value !== undefined ? { value: action.value } : {}),
              actionEventId,
            }),
          },
        );
        if (!res.ok) throw new Error(`action failed (${res.status})`);
        // Same id swap as send(): the 202 body's messageId is the durable row.
        const body = (await res.json().catch(() => ({}))) as { messageId?: string };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === actionEventId ? { ...m, id: body.messageId ?? m.id, pending: false } : m,
          ),
        );
      } catch {
        setMessages((prev) => prev.filter((m) => m.id !== actionEventId));
        throw new Error('action not sent — check your connection and try again');
      }
    },
    [apiUrl, agentIdentifier, subscriberId, headers],
  );

  /** Edit an own message. Optimistic content swap; reverts if the PATCH fails. */
  const editMessage = useCallback(
    async (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      let previous: ChatMessage | undefined;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== id) return m;
          previous = m;
          return { ...m, content: trimmed, editedAt: new Date().toISOString() };
        }),
      );
      try {
        const res = await fetch(
          `${apiUrl}/v1/agents/${encodeURIComponent(agentIdentifier)}/messages/${encodeURIComponent(id)}`,
          { method: 'PATCH', headers: headers(), body: JSON.stringify({ subscriberId, text: trimmed }) },
        );
        if (!res.ok) throw new Error(`edit failed (${res.status})`);
      } catch {
        if (previous) setMessages((prev) => prev.map((m) => (m.id === id ? previous! : m)));
        throw new Error('edit not saved — check your connection and try again');
      }
    },
    [apiUrl, agentIdentifier, subscriberId, headers],
  );

  /** Delete an own message. Optimistic tombstone; reverts if the DELETE fails. */
  const deleteMessage = useCallback(
    async (id: string) => {
      let previous: ChatMessage | undefined;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== id) return m;
          previous = m;
          return { ...m, content: '', deletedAt: new Date().toISOString(), buttons: undefined };
        }),
      );
      try {
        const res = await fetch(
          `${apiUrl}/v1/agents/${encodeURIComponent(agentIdentifier)}/messages/${encodeURIComponent(id)}?subscriberId=${encodeURIComponent(subscriberId)}`,
          { method: 'DELETE', headers: headers() },
        );
        if (!res.ok) throw new Error(`delete failed (${res.status})`);
      } catch {
        if (previous) setMessages((prev) => prev.map((m) => (m.id === id ? previous! : m)));
        throw new Error('delete not saved — check your connection and try again');
      }
    },
    [apiUrl, agentIdentifier, subscriberId, headers],
  );

  return { messages, status, connected, typing, send, sendAction, editMessage, deleteMessage };
}

export interface AgentChatProps extends UseAgentChatOptions {
  theme?: 'dark' | 'light';
  /** Header title; defaults to the agent identifier. */
  title?: string;
  placeholder?: string;
  height?: number;
}

export function AgentChat(props: AgentChatProps) {
  const { theme = 'dark', title = props.agentIdentifier, placeholder = 'Type a message…', height = 380 } = props;
  const { messages, status, connected, typing, send, sendAction, editMessage, deleteMessage } =
    useAgentChat(props);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [clicking, setClicking] = useState(false);
  // One draft suffices: only the last message's text-input card is ever live.
  const [cardDraft, setCardDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const c = palettes[theme];
  const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, typing]);

  const beginEdit = (m: ChatMessage) => {
    setError('');
    setEditingId(m.id);
    setEditDraft(m.content);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft('');
  };
  const saveEdit = async (id: string) => {
    const text = editDraft;
    setEditingId(null);
    setEditDraft('');
    try {
      await editMessage(id, text);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const removeMessage = (id: string) => {
    setError('');
    deleteMessage(id).catch((err) => setError((err as Error).message));
  };

  const ctrlBtn: CSSProperties = {
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: c.text2,
    fontSize: 11,
    fontFamily: font,
    cursor: 'pointer',
  };

  const submit = async () => {
    const text = draft;
    setDraft('');
    setError('');
    try {
      await send(text);
    } catch (err) {
      setDraft(text);
      setError((err as Error).message);
    }
  };

  // A card select answer — same optimistic/revert flow a button click uses.
  const answerSelect = (action: { id: string; label: string; value: string }) => {
    setError('');
    setClicking(true);
    sendAction(action)
      .catch((err) => setError((err as Error).message))
      .finally(() => setClicking(false));
  };

  // A card text-input answer — clear the field optimistically, restore on fail.
  const submitCard = (cardId: string) => {
    const value = cardDraft.trim();
    if (!value) return;
    setCardDraft('');
    setError('');
    setClicking(true);
    sendAction({ id: cardId, value })
      .catch((err) => {
        setCardDraft(value);
        setError((err as Error).message);
      })
      .finally(() => setClicking(false));
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 360,
        height,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 10,
        fontFamily: font,
        overflow: 'hidden',
      }}
    >
      <style>{`@keyframes asyncify-typing{0%,60%,100%{opacity:0.25}30%{opacity:1}}`}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: `1px solid ${c.border}`,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>{title}</span>
        <span style={{ fontSize: 11, color: c.text2 }}>
          {status === 'resolved' ? 'resolved' : connected ? 'online' : 'offline'}
        </span>
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {messages.length === 0 ? (
          <p style={{ padding: '24px 8px', textAlign: 'center', fontSize: 12, color: c.text2 }}>
            Start the conversation — the agent answers right here.
          </p>
        ) : (
          messages.map((m, i) => {
            // Buttons stay clickable only while theirs is the latest turn;
            // any newer message (a click included) retires them to context.
            const buttonsLive =
              m.role === 'agent' && !!m.buttons?.length && i === messages.length - 1 && !clicking;
            // Cards follow the same gating: interactive only while last, else inert.
            const card = m.role === 'agent' ? m.card : undefined;
            const cardLive = !!card && i === messages.length - 1 && !clicking;
            const isDeleted = !!m.deletedAt;
            const isEditing = editingId === m.id;
            const canControl = m.role === 'user' && !m.pending && !isDeleted;
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
                  marginBottom: 8,
                }}
              >
                {isDeleted ? (
                  <div
                    style={{
                      maxWidth: '80%',
                      padding: '7px 10px',
                      borderRadius: 10,
                      fontSize: 13,
                      fontStyle: 'italic',
                      color: c.text2,
                      background: 'transparent',
                      border: `1px solid ${c.border}`,
                      ...(m.role === 'user'
                        ? { borderBottomRightRadius: 3 }
                        : { borderBottomLeftRadius: 3 }),
                    }}
                  >
                    message deleted
                  </div>
                ) : isEditing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '80%', alignItems: 'flex-end' }}>
                    <input
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void saveEdit(m.id);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                      autoFocus
                      aria-label="Edit message"
                      style={{
                        width: '100%',
                        height: 30,
                        padding: '0 10px',
                        borderRadius: 8,
                        border: `1px solid ${c.border}`,
                        background: 'transparent',
                        color: c.text,
                        fontSize: 13,
                        fontFamily: font,
                        outline: 'none',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button type="button" style={ctrlBtn} onClick={() => void saveEdit(m.id)}>
                        save
                      </button>
                      <button type="button" style={ctrlBtn} onClick={cancelEdit}>
                        cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div
                      style={{
                        maxWidth: '80%',
                        padding: '7px 10px',
                        borderRadius: 10,
                        fontSize: 13,
                        lineHeight: 1.45,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        opacity: m.pending ? 0.6 : 1,
                        ...(m.role === 'user'
                          ? { background: c.badge, color: c.badgeText, borderBottomRightRadius: 3 }
                          : {
                              background: c.hover,
                              color: c.text,
                              border: `1px solid ${c.border}`,
                              borderBottomLeftRadius: 3,
                            }),
                      }}
                    >
                      {m.content}
                    </div>
                    {m.editedAt && (
                      <span style={{ marginTop: 2, fontSize: 10, color: c.text2 }}>(edited)</span>
                    )}
                    {m.role === 'agent' && !!m.buttons?.length && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, maxWidth: '80%' }}>
                        {m.buttons.map((b) => (
                          <button
                            key={b.id}
                            type="button"
                            disabled={!buttonsLive}
                            onClick={() => {
                              setError('');
                              setClicking(true);
                              sendAction(b)
                                .catch((err) => setError((err as Error).message))
                                .finally(() => setClicking(false));
                            }}
                            style={{
                              padding: '5px 10px',
                              borderRadius: 8,
                              border: `1px solid ${c.border}`,
                              background: 'transparent',
                              color: buttonsLive ? c.text : c.text2,
                              fontSize: 12,
                              fontFamily: font,
                              cursor: buttonsLive ? 'pointer' : 'default',
                              opacity: buttonsLive ? 1 : 0.55,
                            }}
                          >
                            {b.label}
                          </button>
                        ))}
                      </div>
                    )}
                    {card?.type === 'select' && (
                      <select
                        aria-label={card.prompt ?? 'Choose an option'}
                        disabled={!cardLive}
                        defaultValue=""
                        onChange={(e) => {
                          const opt = card.options.find((o) => o.id === e.target.value);
                          if (opt) answerSelect({ id: card.id, label: opt.label, value: opt.id });
                        }}
                        style={{
                          marginTop: 6,
                          maxWidth: '80%',
                          height: 30,
                          padding: '0 8px',
                          borderRadius: 8,
                          border: `1px solid ${c.border}`,
                          // A solid themed surface + colorScheme make the
                          // browser render the NATIVE dropdown popup in the
                          // widget's theme instead of defaulting to light.
                          background: c.hover,
                          colorScheme: theme,
                          color: cardLive ? c.text : c.text2,
                          fontSize: 13,
                          fontFamily: font,
                          outline: 'none',
                          cursor: cardLive ? 'pointer' : 'default',
                          opacity: cardLive ? 1 : 0.55,
                        }}
                      >
                        <option value="" disabled style={{ background: c.hover, color: c.text2 }}>
                          {card.prompt ?? 'Choose…'}
                        </option>
                        {card.options.map((o) => (
                          <option key={o.id} value={o.id} style={{ background: c.hover, color: c.text }}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {card?.type === 'text_input' && cardLive && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, width: '80%' }}>
                        <input
                          value={cardDraft}
                          onChange={(e) => setCardDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              submitCard(card.id);
                            }
                          }}
                          placeholder={card.placeholder ?? ''}
                          maxLength={3000}
                          aria-label={card.prompt ?? 'Your answer'}
                          style={{
                            flex: 1,
                            height: 30,
                            padding: '0 10px',
                            borderRadius: 8,
                            border: `1px solid ${c.border}`,
                            background: 'transparent',
                            color: c.text,
                            fontSize: 13,
                            fontFamily: font,
                            outline: 'none',
                          }}
                        />
                        <button
                          type="button"
                          style={ctrlBtn}
                          disabled={!cardDraft.trim()}
                          onClick={() => submitCard(card.id)}
                        >
                          send
                        </button>
                      </div>
                    )}
                    {canControl && (
                      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                        <button type="button" style={ctrlBtn} onClick={() => beginEdit(m)}>
                          edit
                        </button>
                        <button type="button" style={ctrlBtn} onClick={() => removeMessage(m.id)}>
                          delete
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
        {typing && status === 'active' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              marginBottom: 8,
            }}
          >
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '9px 12px',
                borderRadius: 10,
                borderBottomLeftRadius: 3,
                background: c.hover,
                border: `1px solid ${c.border}`,
              }}
              aria-label="Agent is typing"
            >
              {[0, 1, 2].map((n) => (
                <span
                  key={n}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: c.text2,
                    animation: 'asyncify-typing 1.2s ease-in-out infinite',
                    animationDelay: `${n * 0.18}s`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
        {status === 'resolved' && (
          <p style={{ margin: '10px 0 2px', textAlign: 'center', fontSize: 11, color: c.text2 }}>
            Conversation resolved — send a message to reopen it.
          </p>
        )}
      </div>

      {error && (
        <p style={{ margin: 0, padding: '6px 14px', fontSize: 11, color: c.text2 }}>{error}</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: 'flex', gap: 8, borderTop: `1px solid ${c.border}`, padding: 10 }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label="Message"
          style={{
            flex: 1,
            height: 32,
            padding: '0 10px',
            borderRadius: 8,
            border: `1px solid ${c.border}`,
            background: 'transparent',
            color: c.text,
            fontSize: 13,
            fontFamily: font,
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label="Send message"
          style={{
            height: 32,
            padding: '0 14px',
            borderRadius: 8,
            border: 'none',
            background: c.badge,
            color: c.badgeText,
            fontSize: 13,
            fontWeight: 600,
            cursor: draft.trim() ? 'pointer' : 'default',
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

export function NotificationInbox(props: NotificationInboxProps) {
  const { theme = 'dark', title = 'Notifications', align = 'right' } = props;
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
            ...(align === 'right' ? { right: 0 } : { left: 0 }),
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
