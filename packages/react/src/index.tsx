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

/* ------------------------------------------------------------------ */
/* Custom select card. Native <select> popups can't be themed (the OS  */
/* paints them), so the dropdown is real elements the palette owns.    */
/* ------------------------------------------------------------------ */

function CardSelect({
  card,
  c,
  font,
  live,
  onPick,
}: {
  card: Extract<Card, { type: 'select' }>;
  c: (typeof palettes)['dark'];
  font: string;
  live: boolean;
  onPick: (option: CardOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<CardOption | null>(null);
  // One index drives both mouse hover and arrow-key navigation.
  const [highlight, setHighlight] = useState(0);
  // Open upward when a downward panel would spill past the scroll container.
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const inert = !live || !!picked;

  // A click anywhere outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = () => {
    if (inert) return;
    if (open) {
      setOpen(false);
      return;
    }
    const el = wrapRef.current;
    if (el) {
      // Nearest scrollable ancestor = the message list; viewport as fallback.
      // 190 ≈ panel maxHeight (180) + the 4px gap + borders.
      let p = el.parentElement;
      while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
      const limit = p ? p.getBoundingClientRect().bottom : window.innerHeight;
      setOpenUp(el.getBoundingClientRect().bottom + 190 > limit);
    }
    setHighlight(0);
    setOpen(true);
  };

  const pick = (option: CardOption) => {
    setPicked(option);
    setOpen(false);
    onPick(option);
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', marginTop: 6, maxWidth: '80%', minWidth: 180 }}
      onKeyDown={(e) => {
        if (inert) return;
        if (e.key === 'Escape') {
          setOpen(false);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!open) {
            toggle();
            return;
          }
          const n = card.options.length;
          setHighlight((h) => (e.key === 'ArrowDown' ? (h + 1) % n : (h - 1 + n) % n));
        } else if (e.key === 'Enter' && open) {
          e.preventDefault();
          const option = card.options[highlight];
          if (option) pick(option);
        }
      }}
    >
      <button
        type="button"
        disabled={inert}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        style={{
          width: '100%',
          height: 30,
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          borderRadius: 8,
          border: `1px solid ${c.border}`,
          background: c.hover,
          color: picked ? c.text : c.text2,
          fontSize: 13,
          fontFamily: font,
          cursor: inert ? 'default' : 'pointer',
          opacity: inert ? 0.55 : 1,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {picked?.label ?? card.prompt ?? 'Choose…'}
        </span>
        <span style={{ fontSize: 10, color: c.text2, flexShrink: 0 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={card.prompt ?? 'Choose an option'}
          style={{
            position: 'absolute',
            ...(openUp ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
            left: 0,
            minWidth: '100%',
            zIndex: 10,
            background: c.bg,
            border: `1px solid ${c.border}`,
            borderRadius: 8,
            padding: 4,
            maxHeight: 180,
            overflowY: 'auto',
          }}
        >
          {card.options.map((o, idx) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={picked?.id === o.id}
              onMouseEnter={() => setHighlight(idx)}
              onClick={() => pick(o)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '7px 10px',
                borderRadius: 6,
                border: 'none',
                background: highlight === idx ? c.hover : 'transparent',
                color: c.text,
                fontSize: 13,
                fontFamily: font,
                cursor: 'pointer',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
  const [cardFocus, setCardFocus] = useState(false);
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
      <style>{`@keyframes asyncify-typing{0%,60%,100%{opacity:0.25}30%{opacity:1}}.asy-card-input::placeholder{color:${c.text2}}.asy-card-send:hover:enabled{background:${c.hover}}`}</style>
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
                      <CardSelect
                        card={card}
                        c={c}
                        font={font}
                        live={cardLive}
                        onPick={(o) => answerSelect({ id: card.id, label: o.label, value: o.id })}
                      />
                    )}
                    {card?.type === 'text_input' && cardLive && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, width: '80%' }}>
                        {card.prompt && (
                          <span style={{ fontSize: 12, color: c.text2 }}>{card.prompt}</span>
                        )}
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input
                            className="asy-card-input"
                            value={cardDraft}
                            onChange={(e) => setCardDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                submitCard(card.id);
                              }
                            }}
                            onFocus={() => setCardFocus(true)}
                            onBlur={() => setCardFocus(false)}
                            placeholder={card.placeholder ?? ''}
                            maxLength={3000}
                            aria-label={card.prompt ?? 'Your answer'}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              height: 30,
                              padding: '0 10px',
                              borderRadius: 8,
                              border: `1px solid ${cardFocus ? c.text2 : c.border}`,
                              background: c.hover,
                              color: c.text,
                              fontSize: 13,
                              fontFamily: font,
                              outline: 'none',
                            }}
                          />
                          <button
                            type="button"
                            className="asy-card-send"
                            disabled={!cardDraft.trim()}
                            onClick={() => submitCard(card.id)}
                            style={{
                              padding: '5px 12px',
                              borderRadius: 8,
                              border: `1px solid ${c.border}`,
                              background: 'transparent',
                              color: cardDraft.trim() ? c.text : c.text2,
                              fontSize: 12,
                              fontFamily: font,
                              cursor: cardDraft.trim() ? 'pointer' : 'default',
                            }}
                          >
                            send
                          </button>
                        </div>
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

/* ------------------------------------------------------------------ */
/* Connect channels — end users link their own Telegram/Slack identity */
/* (and see email auto-links) from any app embedding the widget.       */
/* ------------------------------------------------------------------ */

export interface ConnectChannelRow {
  connectionId: string | null;
  channel: 'telegram' | 'slack' | 'email';
  label: string;
  linked: boolean;
  identities: Array<{ externalKey: string; linkedAt: string }>;
}

export interface UseConnectChannelsOptions {
  token: string;
  apiUrl?: string;
}

export function useConnectChannels({ token, apiUrl = '' }: UseConnectChannelsOptions) {
  const [channels, setChannels] = useState<ConnectChannelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const headers = useCallback(
    () => ({ 'content-type': 'application/json', 'x-subscriber-token': token }),
    [token],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/v1/me/channels`, { headers: headers() });
      const data = (await res.json()) as { channels?: ConnectChannelRow[] };
      setChannels(data.channels ?? []);
    } catch {
      /* keep the last-known rows on a transient failure */
    } finally {
      setLoading(false);
    }
  }, [apiUrl, headers]);

  // Mount fetch, then refetch whenever the tab regains focus or becomes
  // visible — the actual link completes in Telegram/Slack (often another tab
  // or app), so returning here is the natural moment to reflect the new state.
  useEffect(() => {
    let alive = true;
    const run = () => {
      if (alive) void load();
    };
    run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const connect = useCallback(
    async (connectionId: string) => {
      setBusy(connectionId);
      try {
        const res = await fetch(`${apiUrl}/v1/me/link-tokens`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ connectionId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          const message = body.error ?? 'could not start linking';
          setRowErrors((prev) => ({ ...prev, [connectionId]: message }));
          console.warn(`[asyncify] link-token failed (${connectionId}): ${message}`);
          return;
        }
        const body = (await res.json()) as { url: string };
        setRowErrors((prev) => {
          const next = { ...prev };
          delete next[connectionId];
          return next;
        });
        window.open(body.url, '_blank', 'noopener,noreferrer');
      } catch {
        const message = 'could not start linking';
        setRowErrors((prev) => ({ ...prev, [connectionId]: message }));
        console.warn(`[asyncify] link-token failed (${connectionId}): ${message}`);
      } finally {
        setBusy(null);
      }
    },
    [apiUrl, headers],
  );

  const unlink = useCallback(
    async (channel: string, externalKey: string) => {
      try {
        await fetch(`${apiUrl}/v1/me/identities`, {
          method: 'DELETE',
          headers: headers(),
          body: JSON.stringify({ channel, externalKey }),
        });
      } catch {
        /* the refetch below is the source of truth either way */
      }
      await load();
    },
    [apiUrl, headers, load],
  );

  return { channels, loading, rowErrors, busy, connect, unlink, refresh: load };
}

export interface ConnectChannelsProps {
  token: string;
  apiUrl?: string;
  theme?: 'dark' | 'light';
  title?: string;
}

export function ConnectChannels(props: ConnectChannelsProps) {
  const { theme = 'dark', title = 'Connected channels' } = props;
  const { channels, loading, rowErrors, busy, connect, unlink, refresh } = useConnectChannels(props);
  // Two-step unlink confirm, keyed by `${channel}:${externalKey}`, auto-reverts
  // after 3s — mirrors AgentChat's lightweight text-button control idiom.
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Rows the user just started connecting; the hint shows until a refetch
  // flips `linked` (or an error surfaces), no server round-trip needed.
  const [pendingConnect, setPendingConnect] = useState<Record<string, boolean>>({});
  const c = palettes[theme];
  const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const textBtn: CSSProperties = {
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: c.text2,
    fontSize: 11,
    fontFamily: font,
    cursor: 'pointer',
  };

  const askConfirm = (key: string) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(key);
    confirmTimer.current = setTimeout(() => setConfirming(null), 3000);
  };
  const cancelConfirm = () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(null);
  };
  const doUnlink = (channel: string, externalKey: string) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(null);
    void unlink(channel, externalKey);
  };

  const onConnect = (connectionId: string) => {
    setPendingConnect((prev) => ({ ...prev, [connectionId]: true }));
    void connect(connectionId);
  };

  return (
    <div
      style={{
        border: `1px solid ${c.border}`,
        borderRadius: 12,
        background: c.bg,
        padding: 14,
        fontFamily: font,
        boxSizing: 'border-box',
      }}
    >
      <style>{`.asy-cc-refresh{color:${c.text2};background:transparent;border:none;padding:0;cursor:pointer;font-size:11px;font-family:${font};}.asy-cc-refresh:hover{color:${c.text};}.asy-cc-pill:hover:enabled{background:${c.hover};}`}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>{title}</span>
        <button type="button" className="asy-cc-refresh" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p style={{ margin: '6px 0 0', fontSize: 12, color: c.text2 }}>Loading channels…</p>
      ) : channels.length === 0 ? (
        <p style={{ margin: '6px 0 0', fontSize: 12, color: c.text2 }}>No channels available yet.</p>
      ) : (
        <div>
          {channels.map((row, idx) => {
            const cid = row.connectionId;
            const err = cid ? rowErrors[cid] : undefined;
            const isBusy = cid !== null && busy === cid;
            const showHint = cid !== null && !!pendingConnect[cid] && !row.linked && !err;
            const name = row.channel.charAt(0).toUpperCase() + row.channel.slice(1);
            // @handles / addresses read best in mono; a Slack team name is prose.
            const labelMono = row.channel !== 'slack';
            return (
              <div
                key={cid ?? row.channel}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 0',
                  borderTop: idx === 0 ? 'none' : `1px solid ${c.border}`,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: c.text }}>
                    {name}
                    <span style={{ color: c.text2 }}> — </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: c.text2,
                        fontFamily: labelMono ? mono : font,
                      }}
                    >
                      {row.label}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        flexShrink: 0,
                        background: row.linked ? c.text : 'transparent',
                        border: row.linked ? 'none' : `1px solid ${c.border}`,
                      }}
                    />
                    <span style={{ fontSize: 12, color: c.text2 }}>
                      {row.linked ? 'Linked' : 'Not linked'}
                    </span>
                    {(row.channel === 'telegram' || row.channel === 'slack') &&
                      row.identities.map((id) => (
                        <span
                          key={id.externalKey}
                          style={{ fontSize: 11, color: c.text2, fontFamily: mono }}
                        >
                          {id.externalKey}
                        </span>
                      ))}
                  </div>
                  {showHint && (
                    <span style={{ fontSize: 11, color: c.text2 }}>
                      {row.channel === 'telegram'
                        ? 'Finish in Telegram, then return here.'
                        : 'Finish in Slack, then return here.'}
                    </span>
                  )}
                  {err && <span style={{ fontSize: 11, color: c.text2 }}>{err}</span>}
                </div>

                <div style={{ flexShrink: 0 }}>
                  {row.channel === 'email' ? (
                    <span style={{ fontSize: 11, color: c.text2 }}>Linked automatically</span>
                  ) : row.linked ? (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        alignItems: 'flex-end',
                      }}
                    >
                      {row.identities.map((id) => {
                        const key = `${row.channel}:${id.externalKey}`;
                        return confirming === key ? (
                          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 11, color: c.text2 }}>Unlink?</span>
                            <button
                              type="button"
                              style={textBtn}
                              onClick={() => doUnlink(row.channel, id.externalKey)}
                            >
                              Confirm
                            </button>
                            <span style={{ fontSize: 11, color: c.text2 }}>·</span>
                            <button type="button" style={textBtn} onClick={cancelConfirm}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            key={key}
                            type="button"
                            style={textBtn}
                            onClick={() => askConfirm(key)}
                          >
                            Unlink
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="asy-cc-pill"
                      disabled={isBusy}
                      onClick={() => cid && onConnect(cid)}
                      style={{
                        padding: '5px 12px',
                        borderRadius: 8,
                        border: `1px solid ${c.border}`,
                        background: 'transparent',
                        color: c.text,
                        fontSize: 12,
                        fontFamily: font,
                        cursor: isBusy ? 'default' : 'pointer',
                        opacity: isBusy ? 0.6 : 1,
                      }}
                    >
                      {isBusy ? 'Opening…' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
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
