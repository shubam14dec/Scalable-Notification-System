import { Fragment, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, session } from '../lib/api';
// Dogfooding: the same QR component customers get from the published package.
import { QrCode } from '../../../packages/react/src';
import {
  Button,
  Card,
  CopyField,
  EmptyState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Skeleton,
  StatusBadge,
  td,
  th,
} from '../ui';
import { timeAgo } from './Activity';

interface Connection {
  id: string;
  channel: 'telegram' | 'email' | 'slack';
  status: 'active' | 'disabled' | 'pending';
  config: {
    botUsername?: string;
    botId?: string;
    address?: string;
    teamId?: string;
    teamName?: string;
    botUserId?: string;
    /** Slack quick-setup only: 'on' when a refresh token keeps URLs current,
     *  'broken' once that token expired. Absent on manual/plain connections. */
    manifestAutoUpdate?: 'on' | 'broken';
  };
  agent: { identifier: string; name: string };
  webhook: {
    url?: string;
    expectedUrl?: string;
    pendingUpdates?: number;
    lastError?: string | null;
    eventsUrl?: string;
    interactivityUrl?: string;
  } | null;
  createdAt: string;
}

interface AgentOption {
  identifier: string;
  name: string;
  status: string;
}

/** The identity a connection answers on — a telegram @handle, an inbox address, or a Slack workspace. */
function identityLabel(c: Connection): string {
  if (c.channel === 'telegram') return `@${c.config.botUsername ?? '—'}`;
  if (c.channel === 'slack') return c.config.teamName ?? c.config.teamId ?? '—';
  return c.config.address ?? '—';
}

interface Route {
  scopeKey: string;
  agent: { identifier: string; name: string };
  createdAt: string;
}

/** Telegram bot token shape, mirrored from src/shared/botfather.ts (do NOT
 *  import across the src boundary). A "<6-12 digits>:<30+ url-safe chars>" run. */
const BOT_TOKEN_RE = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;

/** Distinct token-shaped runs in a blob — one is auto-fillable, more is ambiguous. */
function parseBotTokens(blob: string): { token: string | null; count: number } {
  const m = blob.match(BOT_TOKEN_RE);
  if (!m) return { token: null, count: 0 };
  const distinct = [...new Set(m)];
  return { token: distinct.length === 1 ? distinct[0] : null, count: distinct.length };
}

/** mm:ss from a millisecond remainder, clamped at zero. */
function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The same env auth the api() client rides, for the one raw fetch we do
 *  (the Slack install link — see openSlackInstall). */
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (session.access) h.authorization = `Bearer ${session.access}`;
  if (session.envId) h['x-environment-id'] = session.envId;
  return h;
}

/**
 * The Slack install endpoint is an AUTHED GET (header auth only, so a plain
 * window.open can't carry it). With `Accept: application/json` it returns
 * 200 {authorizeUrl} instead of its browser-facing 302 — fetch that authed,
 * then open the consent screen in a new tab. Throws the API's error message
 * on any non-200 so the caller can render it inline.
 */
async function openSlackInstall(installUrl: string): Promise<void> {
  const res = await fetch(installUrl, {
    headers: { ...authHeaders(), accept: 'application/json' },
  });
  const body = (await res.json().catch(() => ({}))) as { authorizeUrl?: string; error?: string };
  if (!res.ok || !body.authorizeUrl) {
    throw new Error(body.error ?? `install link failed (${res.status})`);
  }
  window.open(body.authorizeUrl, '_blank', 'noopener,noreferrer');
}

/** The shared "Answered by" agent picker, controlled so previews react to it. */
function AgentSelect({
  agents,
  value,
  onChange,
}: {
  agents: AgentOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Answered by">
      <select
        required
        aria-label="Answered by"
        className="h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[13px] text-t1 hover:border-bd-strong"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {agents.map((a) => (
          <option key={a.identifier} value={a.identifier} className="bg-surface">
            {a.name} ({a.identifier})
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * Connect a new channel. A segmented Telegram | Email | Slack picker; each
 * branch owns its own form, mutations, and success state.
 */
function ConnectModal({
  agents,
  onClose,
  onConnected,
}: {
  agents: AgentOption[];
  onClose: () => void;
  onConnected: () => void;
}) {
  const [channel, setChannel] = useState<'telegram' | 'email' | 'slack'>('telegram');

  return (
    <Modal open onClose={onClose} title="Connect a channel">
      <div className="mb-4 inline-flex rounded-md border border-bd p-0.5">
        {(['telegram', 'email', 'slack'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChannel(c)}
            className={`h-7 rounded px-3 text-[12px] font-medium capitalize transition-colors ${
              channel === c ? 'bg-elevated text-t1' : 'text-t2 hover:text-t1'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {channel === 'telegram' ? (
        <TelegramConnect agents={agents} onClose={onClose} onConnected={onConnected} />
      ) : channel === 'email' ? (
        <EmailConnect agents={agents} onClose={onClose} onConnected={onConnected} />
      ) : (
        <SlackConnect agents={agents} onClose={onClose} onConnected={onConnected} />
      )}
    </Modal>
  );
}

/**
 * Telegram: paste BotFather's whole message (we pull the token out), or set it
 * up from a phone via a QR handoff — the phone pastes, the token flows back
 * here exactly once. The underlying create call is unchanged.
 */
function TelegramConnect({
  agents,
  onClose,
  onConnected,
}: {
  agents: AgentOption[];
  onClose: () => void;
  onConnected: () => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.identifier ?? '');
  const [error, setError] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');

  // The token can arrive two ways: parsed from the pasted blob, or received
  // from the phone handoff. Both land in `token`.
  const [paste, setPaste] = useState('');
  const [token, setToken] = useState('');
  const [fromPhone, setFromPhone] = useState(false);
  const parsed = parseBotTokens(paste);

  const connect = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ webhookUrl: string }>('/v1/connections/telegram', { method: 'POST', body }),
    onSuccess: (res) => {
      setError('');
      setWebhookUrl(res.webhookUrl);
      onConnected();
    },
    onError: (err) => setError(err.message),
  });

  if (webhookUrl) {
    return (
      <div className="space-y-3">
        <p className="text-[12px] text-t2">
          We validated the token and registered this webhook with Telegram. Messages to the bot
          now flow to the chosen agent.
        </p>
        <CopyField value={webhookUrl} />
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const effectiveToken = token || parsed.token || '';

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (effectiveToken && agentId) connect.mutate({ botToken: effectiveToken, agentIdentifier: agentId });
      }}
    >
      <p className="text-[12px] text-t2">
        Create a bot with <Mono>@BotFather</Mono> on Telegram (<Mono>/newbot</Mono>), then paste
        its message below. We validate the token, register the webhook, and messages to the bot
        flow to this agent. Requires this server to be reachable from the internet (PUBLIC_URL) —
        locally, run a tunnel.
      </p>

      <div>
        <span className="mb-1.5 block text-[12px] font-medium text-t2">
          Paste BotFather's message (or just the token)
        </span>
        <textarea
          autoFocus
          rows={3}
          value={paste}
          onChange={(e) => {
            setPaste(e.target.value);
            // A fresh paste supersedes a phone-received token.
            if (fromPhone) {
              setFromPhone(false);
              setToken('');
            }
          }}
          placeholder="Done! Congratulations on your new bot. …  7000000000:AA…"
          className="w-full rounded-md border border-bd bg-transparent px-2.5 py-2 font-mono text-[12px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong"
        />
        {fromPhone ? (
          <span className="mt-1 block text-[11px] text-t2">✔ received from phone</span>
        ) : parsed.count > 1 ? (
          <span className="mt-1 block text-[11px] text-err">
            multiple tokens found — paste just one
          </span>
        ) : parsed.token ? (
          <span className="mt-1 block text-[11px] text-t2">token detected ✔</span>
        ) : null}
      </div>

      <AgentSelect agents={agents} value={agentId} onChange={setAgentId} />

      <PhoneHandoff
        onReceived={(botToken) => {
          setToken(botToken);
          setFromPhone(true);
          setPaste('');
        }}
      />

      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={connect.isPending || !effectiveToken || !agentId}
        >
          {connect.isPending ? 'Connecting…' : 'Connect Telegram'}
        </Button>
      </div>
    </form>
  );
}

/**
 * "Set up from your phone": mint a single-use handoff, show its URL as a QR,
 * count down to its expiry, and poll until the phone's paste lands — then hand
 * the token to the parent exactly once.
 */
function PhoneHandoff({ onReceived }: { onReceived: (botToken: string) => void }) {
  const [handoff, setHandoff] = useState<{ id: string; url: string; expiresAt: string } | null>(
    null,
  );
  const [status, setStatus] = useState<'idle' | 'waiting' | 'received' | 'expired'>('idle');
  const [now, setNow] = useState(Date.now());

  // Keep the callback out of the poll effect's deps so the 1s countdown and
  // any parent re-render (typing) can't restart the 2.5s poll loop.
  const onReceivedRef = useRef(onReceived);
  onReceivedRef.current = onReceived;

  const mint = useMutation({
    mutationFn: () => api<{ handoffId: string; url: string; expiresAt: string }>('/v1/ops/handoffs', {
      method: 'POST',
      body: { channel: 'telegram' },
    }),
    onSuccess: (res) => {
      setHandoff({ id: res.handoffId, url: res.url, expiresAt: res.expiresAt });
      setStatus('waiting');
    },
  });

  // 1s tick drives the countdown while a handoff is live.
  useEffect(() => {
    if (status !== 'waiting') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  // Poll the one-shot endpoint every 2.5s until the token lands or it expires.
  useEffect(() => {
    if (status !== 'waiting' || !handoff) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      try {
        const res = await api<{ status: string; botToken?: string }>(`/v1/ops/handoffs/${handoff.id}`);
        if (stop) return;
        if (res.status === 'received' && res.botToken) {
          setStatus('received');
          onReceivedRef.current(res.botToken); // one-shot — hand it up immediately
          return;
        }
        if (res.status === 'expired' || res.status === 'consumed') {
          setStatus('expired');
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (new Date(handoff.expiresAt).getTime() <= Date.now()) {
        setStatus('expired');
        return;
      }
      timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 2500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [status, handoff]);

  if (status === 'received') {
    return (
      <div className="rounded-md border border-bd bg-elevated px-3 py-2 text-[12px] text-t2">
        ✔ Token received from your phone — it's filled in above.
      </div>
    );
  }

  const remaining = handoff ? new Date(handoff.expiresAt).getTime() - now : 0;
  const expired = status === 'expired' || remaining <= 0;

  return (
    <div className="rounded-md border border-bd bg-elevated p-3">
      {mint.isError && (
        <p className="mb-2 text-[11px] text-err">{(mint.error as Error).message}</p>
      )}
      {!handoff ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-t3">
            No bot yet? Set it up from your phone — scan a QR, paste BotFather's message there.
          </span>
          <Button type="button" onClick={() => mint.mutate()} disabled={mint.isPending}>
            {mint.isPending ? 'Preparing…' : 'Set up from your phone'}
          </Button>
        </div>
      ) : expired ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-t3">This QR expired.</span>
          <Button type="button" onClick={() => mint.mutate()} disabled={mint.isPending}>
            {mint.isPending ? 'Preparing…' : 'New QR'}
          </Button>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div
            className="shrink-0 rounded-md border border-bd p-2"
            style={{ background: '#ffffff', color: '#000000', lineHeight: 0 }}
          >
            <QrCode value={handoff.url} size={132} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <p className="text-[12px] text-t2">
              Scan with your phone, paste BotFather's message there, and the token appears here.
            </p>
            <p className="text-[11px] text-t3">
              Expires in <Mono className="text-t2">{mmss(remaining)}</Mono>
            </p>
            <CopyField value={handoff.url} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Email: unchanged — give the agent an inbound address, get a webhook URL. */
function EmailConnect({
  agents,
  onClose,
  onConnected,
}: {
  agents: AgentOption[];
  onClose: () => void;
  onConnected: () => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.identifier ?? '');
  const [error, setError] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');

  const connect = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ webhookUrl: string }>('/v1/connections/email', { method: 'POST', body }),
    onSuccess: (res) => {
      setError('');
      setWebhookUrl(res.webhookUrl);
      onConnected();
    },
    onError: (err) => setError(err.message),
  });

  if (webhookUrl) {
    return (
      <div className="space-y-3">
        <p className="text-[12px] text-t2">
          Paste this webhook URL into your provider's inbound settings (Postmark: Servers →
          Default Inbound Stream → Settings → Webhook). Emails to the address then arrive here as
          conversations.
        </p>
        <CopyField value={webhookUrl} />
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const address = String(new FormData(e.currentTarget).get('address') ?? '');
        if (address && agentId) connect.mutate({ address, agentIdentifier: agentId });
      }}
    >
      <p className="text-[12px] text-t2">
        Give this agent an email address. No DNS needed: a free Postmark account includes an
        inbound address (Servers → Default Inbound Stream) like{' '}
        <Mono>hash@inbound.postmarkapp.com</Mono> — paste it below, then paste the webhook URL we
        generate back into Postmark.
      </p>
      <Field label="Inbound address">
        <Input
          name="address"
          required
          type="email"
          placeholder="hash@inbound.postmarkapp.com"
          className="font-mono"
        />
      </Field>
      <AgentSelect agents={agents} value={agentId} onChange={setAgentId} />
      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={connect.isPending || !agentId}>
          {connect.isPending ? 'Connecting…' : 'Connect email'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Slack: Quick Setup (config token → we create + wire the app, you install)
 * or Manual (paste a bot token + signing secret against a prefilled manifest).
 */
function SlackConnect({
  agents,
  onClose,
  onConnected,
}: {
  agents: AgentOption[];
  onClose: () => void;
  onConnected: () => void;
}) {
  const [tab, setTab] = useState<'quick' | 'manual'>('quick');
  const [agentId, setAgentId] = useState(agents[0]?.identifier ?? '');

  return (
    <div>
      <div className="mb-4 inline-flex rounded-md border border-bd p-0.5">
        {(
          [
            ['quick', 'Quick setup'],
            ['manual', 'Manual'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`h-7 rounded px-3 text-[12px] font-medium transition-colors ${
              tab === id ? 'bg-elevated text-t1' : 'text-t2 hover:text-t1'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'quick' ? (
        <SlackQuickSetup
          agents={agents}
          agentId={agentId}
          setAgentId={setAgentId}
          onClose={onClose}
          onConnected={onConnected}
        />
      ) : (
        <SlackManual
          agents={agents}
          agentId={agentId}
          setAgentId={setAgentId}
          onClose={onClose}
          onConnected={onConnected}
        />
      )}
    </div>
  );
}

function SlackQuickSetup({
  agents,
  agentId,
  setAgentId,
  onClose,
  onConnected,
}: {
  agents: AgentOption[];
  agentId: string;
  setAgentId: (v: string) => void;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{
    connectionId: string;
    eventsUrl: string;
    interactivityUrl: string;
    installUrl: string;
  } | null>(null);
  const [connected, setConnected] = useState<{
    teamName?: string;
    eventsUrl?: string;
    interactivityUrl?: string;
    manifestAutoUpdate?: 'on' | 'broken';
  } | null>(null);
  const [listening, setListening] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [installError, setInstallError] = useState('');

  const createApp = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ connectionId: string; installUrl: string; eventsUrl: string; interactivityUrl: string }>(
        '/v1/connections/slack/quick-setup',
        { method: 'POST', body },
      ),
    onSuccess: (res) => {
      setError('');
      setCreated({
        connectionId: res.connectionId,
        installUrl: res.installUrl,
        eventsUrl: res.eventsUrl,
        interactivityUrl: res.interactivityUrl,
      });
      onConnected();
    },
    onError: (err) => setError(err.message),
  });

  // After the admin clicks Install, poll the connection list until this row
  // flips to 'active' (the OAuth callback landed), capped at 120s.
  useEffect(() => {
    if (!listening || !created) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 120_000;
    const tick = async () => {
      if (stop) return;
      try {
        const { connections } = await api<{ connections: Connection[] }>('/v1/connections');
        if (stop) return;
        const row = connections.find((c) => c.id === created.connectionId);
        if (row && row.status === 'active') {
          setConnected({
            teamName: row.config.teamName,
            eventsUrl: row.webhook?.eventsUrl ?? created.eventsUrl,
            interactivityUrl: row.webhook?.interactivityUrl ?? created.interactivityUrl,
            manifestAutoUpdate: row.config.manifestAutoUpdate,
          });
          setListening(false);
          onConnected();
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (Date.now() >= deadline) {
        setListening(false);
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 2500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [listening, created, onConnected]);

  if (connected) {
    return (
      <div className="space-y-3">
        <p className="text-[13px] text-t1">
          ✔ Connected{connected.teamName ? <> — <span className="text-t2">{connected.teamName}</span></> : null}
        </p>
        {connected.manifestAutoUpdate === 'on' && (
          <p className="text-[12px] text-t3">URL auto-update: on</p>
        )}
        {connected.manifestAutoUpdate === 'broken' && (
          <p className="text-[12px] text-warn">
            Config refresh token expired — re-arm auto-update from this connection's URLs section
            in the table.
          </p>
        )}
        {connected.eventsUrl && (
          <Field label="Events URL — Event Subscriptions → Request URL">
            <CopyField value={connected.eventsUrl} />
          </Field>
        )}
        {connected.interactivityUrl && (
          <Field label="Interactivity URL — Interactivity & Shortcuts → Request URL">
            <CopyField value={connected.interactivityUrl} />
          </Field>
        )}
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  // Step 3: app created, waiting for the admin to install into a workspace.
  if (created) {
    return (
      <div className="space-y-3">
        <p className="text-[12px] text-t2">
          Your Slack app is created. Install it into a workspace to finish — we'll detect it and
          confirm here.
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              setInstallError('');
              setTimedOut(false);
              try {
                await openSlackInstall(created.installUrl);
                setListening(true);
              } catch (err) {
                setInstallError((err as Error).message);
              }
            }}
          >
            Install to workspace
          </Button>
          {listening && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-t3">
              <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-t3" />
              Listening…
            </span>
          )}
        </div>
        {installError && <p className="text-[12px] text-err">{installError}</p>}
        {timedOut && (
          <p className="text-[12px] text-t3">
            Still not connected. Finish the Slack install, then reopen this — the connection shows
            up once it's active.
          </p>
        )}
      </div>
    );
  }

  // Steps 1–2: the config-token form.
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const configToken = String(form.get('configToken') ?? '').trim();
        const configRefreshToken = String(form.get('configRefreshToken') ?? '').trim();
        if (!configToken || !agentId) return;
        createApp.mutate({
          configToken,
          agentIdentifier: agentId,
          ...(configRefreshToken ? { configRefreshToken } : {}),
        });
      }}
    >
      <p className="text-[12px] text-t2">
        We create and wire the Slack app for you from an App Configuration Token — no manifest
        copy-paste. Then you install it into a workspace.
      </p>
      <a
        href="https://api.slack.com/apps"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-[12px] text-t2 underline transition-colors hover:text-t1"
      >
        Generate an App Configuration Token →
      </a>
      <p className="-mt-2 text-[11px] text-t3">
        On api.slack.com/apps, open the "App Configuration Tokens" section at the bottom and
        generate one — it lasts 12 hours.
      </p>
      <Field label="App configuration token">
        <Input
          name="configToken"
          required
          autoFocus
          placeholder="xoxe.xoxp-…"
          className="font-mono"
          type="password"
          autoComplete="off"
        />
      </Field>
      <Field label="App configuration refresh token (optional)">
        <Input
          name="configRefreshToken"
          placeholder="xoxe-1-…"
          className="font-mono"
          type="password"
          autoComplete="off"
        />
      </Field>
      <p className="-mt-2 text-[11px] text-t3">
        Optional — enables automatic URL updates when your tunnel rotates; find it next to the
        access token.
      </p>
      <AgentSelect agents={agents} value={agentId} onChange={setAgentId} />
      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={createApp.isPending || !agentId}>
          {createApp.isPending ? 'Creating…' : 'Create Slack app'}
        </Button>
      </div>
    </form>
  );
}

function SlackManual({
  agents,
  agentId,
  setAgentId,
  onClose,
  onConnected,
}: {
  agents: AgentOption[];
  agentId: string;
  setAgentId: (v: string) => void;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [error, setError] = useState('');
  const [slack, setSlack] = useState<{ eventsUrl: string; interactivityUrl: string } | null>(null);
  const [showManifest, setShowManifest] = useState(false);

  const manifest = useQuery({
    queryKey: ['slack-manifest-preview', agentId],
    queryFn: () =>
      api<{ yaml: string; prefillUrl: string }>(
        `/v1/connections/slack/manifest-preview?agentIdentifier=${encodeURIComponent(agentId)}`,
      ),
    enabled: Boolean(agentId),
  });

  const connectSlack = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ channel: 'slack'; teamName: string; eventsUrl: string; interactivityUrl: string }>(
        '/v1/connections/slack',
        { method: 'POST', body },
      ),
    onSuccess: (res) => {
      setError('');
      setSlack({ eventsUrl: res.eventsUrl, interactivityUrl: res.interactivityUrl });
      onConnected();
    },
    onError: (err) => setError(err.message),
  });

  if (slack) {
    return (
      <div className="space-y-3">
        <Field label="Events URL — Event Subscriptions → Request URL">
          <CopyField value={slack.eventsUrl} />
        </Field>
        <Field label="Interactivity URL — Interactivity & Shortcuts → Request URL">
          <CopyField value={slack.interactivityUrl} />
        </Field>
        <p className="text-[12px] text-t2">
          Slack shows Verified when the events URL is saved — that also proves the signing secret.
        </p>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const botToken = String(form.get('botToken') ?? '');
        const signingSecret = String(form.get('signingSecret') ?? '');
        if (botToken && signingSecret && agentId)
          connectSlack.mutate({ botToken, signingSecret, agentIdentifier: agentId });
      }}
    >
      <AgentSelect agents={agents} value={agentId} onChange={setAgentId} />

      <div className="space-y-2 rounded-md border border-bd bg-elevated p-3">
        <p className="text-[12px] text-t2">
          Create the app from a prefilled manifest, install it to your workspace, then paste its
          Bot User OAuth Token and Signing Secret below.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={!manifest.data}
            onClick={() =>
              manifest.data &&
              window.open(manifest.data.prefillUrl, '_blank', 'noopener,noreferrer')
            }
          >
            Open prefilled manifest
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!manifest.data}
            onClick={() => setShowManifest((v) => !v)}
          >
            {showManifest ? 'Hide manifest' : 'Show manifest'}
          </Button>
        </div>
        {manifest.isError && (
          <p className="text-[12px] text-err">{(manifest.error as Error).message}</p>
        )}
        {showManifest && manifest.data && (
          <>
            <pre className="max-h-64 overflow-auto rounded-md border border-bd bg-surface p-3 font-mono text-[11px] leading-relaxed text-t2">
              {manifest.data.yaml}
            </pre>
            <p className="text-[11px] text-t3">
              URLs in the prefilled manifest use a placeholder — the real URLs appear after you
              create the connection.
            </p>
          </>
        )}
      </div>

      <Field label="Bot token">
        <Input
          name="botToken"
          required
          placeholder="xoxb-…"
          className="font-mono"
          type="password"
          autoComplete="off"
        />
      </Field>
      <Field label="Signing secret">
        <Input name="signingSecret" required className="font-mono" type="password" autoComplete="off" />
      </Field>
      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={connectSlack.isPending || !agentId}>
          {connectSlack.isPending ? 'Connecting…' : 'Connect Slack'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Manifest auto-update state + repair, in a slack row's expanded section.
 * 'broken' gets a warning with an always-visible paste-and-re-arm field;
 * healthy rows get a quiet "re-arm auto-update" action that reveals the same
 * field (idempotent — a fresh refresh token is legitimate any time). Manual
 * slack rows can't be told apart client-side (both carry appId), so the
 * action renders there too and the API's 409 explains itself inline.
 */
function SlackAutoUpdate({ conn, onUpdated }: { conn: Connection; onUpdated: () => void }) {
  const broken = conn.config.manifestAutoUpdate === 'broken';
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  // 502 = the token chain re-armed but the immediate manifest push failed.
  const [softNote, setSoftNote] = useState('');
  // Local bridge so the section flips to "on" before the refetch lands.
  const [rearmed, setRearmed] = useState(false);

  const rearm = useMutation({
    mutationFn: (configRefreshToken: string) =>
      api<{ eventsUrl: string; interactivityUrl: string; updated: boolean }>(
        `/v1/connections/${conn.id}/slack/config-token`,
        { method: 'PUT', body: { configRefreshToken } },
      ),
    onSuccess: () => {
      setError('');
      setSoftNote('');
      setToken('');
      setOpen(false);
      setRearmed(true);
      onUpdated(); // refetch: URLs may have just healed to the current tunnel
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 502) {
        // Chain restored; the URL push failed and will heal on next rotation.
        setError('');
        setToken('');
        setOpen(false);
        setRearmed(true);
        setSoftNote(`Chain restored — URLs will heal on next rotation (${err.message}).`);
        onUpdated();
      } else {
        setError(err.message);
      }
    },
  });

  const isOn = rearmed || conn.config.manifestAutoUpdate === 'on';
  const showField = (broken && !rearmed) || open;

  return (
    <div className="space-y-1.5">
      {broken && !rearmed ? (
        <p className="text-[12px] text-warn">
          Config refresh token expired — paste a fresh one to restore auto-update.
        </p>
      ) : (
        <p className="text-[12px] text-t3">
          {isOn && <span>URL auto-update: on</span>}
          {!open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className={`text-t3 transition-colors hover:text-t1 ${isOn ? 'ml-2' : ''}`}
            >
              re-arm auto-update
            </button>
          )}
        </p>
      )}
      {softNote && <p className="text-[12px] text-warn">{softNote}</p>}
      {showField && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) rearm.mutate(token.trim());
          }}
        >
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste a fresh config refresh token"
            aria-label="Config refresh token"
            type="password"
            autoComplete="off"
            className="max-w-xs font-mono"
          />
          <Button type="submit" disabled={rearm.isPending || !token.trim()}>
            {rearm.isPending ? 'Re-arming…' : 'Re-arm'}
          </Button>
          {open && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setError('');
              }}
            >
              Cancel
            </Button>
          )}
        </form>
      )}
      {error && <p className="text-[12px] text-err">{error}</p>}
    </div>
  );
}

/** Confirm re-pointing a connection to a different agent before it fires. */
function RepointModal({
  identity,
  agentName,
  pending,
  onCancel,
  onConfirm,
}: {
  identity: string;
  agentName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open onClose={onCancel} title="Re-point connection">
      <p className="text-[13px] leading-relaxed text-t2">
        Future messages to <Mono>{identity}</Mono> will be answered by{' '}
        <span className="text-t1">{agentName}</span>. Existing conversations and their history
        move with it.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} disabled={pending}>
          {pending ? 'Re-pointing…' : 'Re-point'}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Per-channel routing for a Slack connection: map individual Slack channel ids
 * to different agents. DMs and unmatched channels fall through to the default.
 */
function RoutesModal({
  conn,
  agents,
  onClose,
}: {
  conn: Connection;
  agents: AgentOption[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');

  // Two-step inline confirm for deleting a rule, mirroring the page's disconnect.
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const routesKey = ['connection-routes', conn.id];
  const invalidateRoutes = () => void queryClient.invalidateQueries({ queryKey: routesKey });

  const { data, isLoading } = useQuery({
    queryKey: routesKey,
    queryFn: () => api<{ routes: Route[] }>(`/v1/connections/${conn.id}/routes`),
  });

  const addRoute = useMutation({
    mutationFn: (body: { scopeKey: string; agentIdentifier: string }) =>
      api(`/v1/connections/${conn.id}/routes`, { method: 'PUT', body }),
    onSuccess: () => {
      setError('');
      invalidateRoutes();
    },
    onError: (err) => setError(err.message),
  });

  const removeRoute = useMutation({
    mutationFn: (scopeKey: string) =>
      api(`/v1/connections/${conn.id}/routes/${scopeKey}`, { method: 'DELETE' }),
    onSuccess: invalidateRoutes,
  });

  const onDeleteClick = (scopeKey: string) => {
    if (confirmingKey === scopeKey) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setConfirmingKey(null);
      removeRoute.mutate(scopeKey);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingKey(scopeKey);
    confirmTimer.current = setTimeout(() => setConfirmingKey(null), 3_000);
  };

  const routes = data?.routes ?? [];

  return (
    <Modal open onClose={onClose} title="Channel routes">
      <div className="space-y-4">
        <p className="text-[12px] text-t2">
          Route specific Slack channels to different agents; DMs and unmatched channels use the
          connection's default agent.
        </p>

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : routes.length > 0 ? (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Channel</th>
                <th className={th}>Agent</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.scopeKey} className="transition-colors hover:bg-elevated">
                  <td className={td}>
                    <Mono className="break-all">{r.scopeKey}</Mono>
                  </td>
                  <td className={td}>
                    <span className="text-t2">{r.agent.name}</span>
                  </td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    <button
                      type="button"
                      onClick={() => onDeleteClick(r.scopeKey)}
                      disabled={removeRoute.isPending}
                      className="text-[12px] text-t3 transition-colors hover:text-t1"
                    >
                      {confirmingKey === r.scopeKey ? 'confirm?' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[12px] text-t3">No rules — everything goes to the default agent.</p>
        )}

        <form
          className="space-y-4 border-t border-bd pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const scopeKey = String(form.get('scopeKey') ?? '').trim();
            const agentIdentifier = String(form.get('agentIdentifier') ?? '');
            if (scopeKey && agentIdentifier) addRoute.mutate({ scopeKey, agentIdentifier });
          }}
        >
          <Field
            label="Channel ID"
            hint="In Slack: open the channel → its name → About tab → Channel ID is at the bottom."
          >
            <Input name="scopeKey" required placeholder="C0123ABCDEF" className="font-mono" />
          </Field>
          <Field label="Answered by">
            <select
              name="agentIdentifier"
              required
              aria-label="Answered by"
              className="h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[13px] text-t1 hover:border-bd-strong"
              defaultValue={agents[0]?.identifier ?? ''}
            >
              {agents.map((a) => (
                <option key={a.identifier} value={a.identifier} className="bg-surface">
                  {a.name} ({a.identifier})
                </option>
              ))}
            </select>
          </Field>
          {error && <p className="text-[12px] text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" type="submit" disabled={addRoute.isPending}>
              {addRoute.isPending ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

export default function ConnectionsPage() {
  const queryClient = useQueryClient();
  const [connectOpen, setConnectOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [repoint, setRepoint] = useState<{ conn: Connection; agentIdentifier: string } | null>(null);
  const [routesConn, setRoutesConn] = useState<Connection | null>(null);

  // Two-step inline confirm for disconnect.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Row-level Slack install: a pending quick-setup row keeps its Install
  // action even after the create-flow modal is long gone (reboot, closed tab).
  // While one is in flight we tighten the poll to 2.5s, capped at 120s.
  const [installing, setInstalling] = useState<{ id: string; deadline: number } | null>(null);
  const [installError, setInstallError] = useState('');

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['connections'] });

  const { data, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/v1/connections'),
    refetchInterval: installing ? 2_500 : 10_000,
  });

  // Listening→active: each refetch checks whether the installing row flipped.
  useEffect(() => {
    if (!installing) return;
    const row = data?.connections.find((c) => c.id === installing.id);
    if (row?.status === 'active') {
      setInstalling(null);
      setNote(`Slack connected${row.config.teamName ? ` — ${row.config.teamName}` : ''}.`);
      return;
    }
    if (Date.now() >= installing.deadline) setInstalling(null);
  }, [data, installing]);

  const onInstallClick = async (id: string) => {
    setInstallError('');
    try {
      await openSlackInstall(`/v1/connections/${id}/slack/install`);
      setInstalling({ id, deadline: Date.now() + 120_000 });
    } catch (err) {
      setInstallError((err as Error).message);
    }
  };

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: AgentOption[] }>('/v1/agents'),
  });
  const activeAgents = agentsData?.agents.filter((a) => a.status === 'active') ?? [];

  const reconnect = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/connections/${id}/reconnect`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/v1/connections/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const move = useMutation({
    mutationFn: ({ id, agentIdentifier }: { id: string; agentIdentifier: string }) =>
      api<{ movedConversations: number; agent: { name: string } }>(`/v1/connections/${id}`, {
        method: 'PATCH',
        body: { agentIdentifier },
      }),
    onSuccess: (res) => {
      setRepoint(null);
      setNote(`Moved ${res.movedConversations} conversation${res.movedConversations === 1 ? '' : 's'}.`);
      invalidate();
    },
  });

  const onDisconnectClick = (id: string) => {
    if (confirmingId === id) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setConfirmingId(null);
      disconnect.mutate(id);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingId(id);
    confirmTimer.current = setTimeout(() => setConfirmingId(null), 3_000);
  };

  const toggleUrl = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const repointAgentName =
    repoint && activeAgents.find((a) => a.identifier === repoint.agentIdentifier)?.name;

  return (
    <>
      <PageHeader
        title="Connections"
        action={
          <Button variant="primary" onClick={() => setConnectOpen(true)}>
            Connect
          </Button>
        }
      />
      <p className="-mt-4 mb-5 max-w-2xl text-[12px] text-t3">
        Each connection is one inbound identity — a Telegram bot or an email inbox — routed to the
        agent that answers it. Re-point one to move its conversations to another agent.
      </p>

      {note && (
        <div className="mb-4 flex items-center justify-between rounded-md border border-bd bg-elevated px-3 py-2 text-[12px] text-t2">
          <span>{note}</span>
          <button
            className="text-t3 transition-colors hover:text-t1"
            onClick={() => setNote(null)}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {installError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-bd bg-elevated px-3 py-2">
          <span className="text-[12px] text-err">{installError}</span>
          <button
            className="shrink-0 text-[12px] text-t3 transition-colors hover:text-t1"
            onClick={() => setInstallError('')}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.connections.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Channel</th>
                <th className={th}>Identity</th>
                <th className={th}>Answered by</th>
                <th className={th}>Webhook</th>
                <th className={th}>Created</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {data.connections.map((c) => {
                const identity = identityLabel(c);
                const webhookHealthy = c.webhook?.url && c.webhook.url === c.webhook.expectedUrl;
                // Ensure the current agent is always selectable even if disabled.
                const options = activeAgents.some((a) => a.identifier === c.agent.identifier)
                  ? activeAgents
                  : [{ identifier: c.agent.identifier, name: c.agent.name, status: c.status }, ...activeAgents];
                return (
                  <Fragment key={c.id}>
                    <tr className="transition-colors hover:bg-elevated">
                      <td className={td}>
                        <span className="text-t2">{c.channel}</span>
                      </td>
                      <td className={td}>
                        <Mono className="break-all">{identity}</Mono>
                      </td>
                      <td className={td}>
                        <select
                          aria-label="Answered by"
                          className="h-8 rounded-md border border-bd bg-transparent px-2 text-[12px] text-t1 hover:border-bd-strong"
                          value={c.agent.identifier}
                          onChange={(e) => setRepoint({ conn: c, agentIdentifier: e.target.value })}
                        >
                          {options.map((a) => (
                            <option key={a.identifier} value={a.identifier} className="bg-surface">
                              {a.name} ({a.identifier})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={td}>
                        {c.channel === 'telegram' ? (
                          <span className="inline-flex items-center gap-2">
                            <StatusBadge status={webhookHealthy ? 'active' : 'failed'} />
                            {!webhookHealthy && (
                              <button
                                type="button"
                                onClick={() => reconnect.mutate(c.id)}
                                disabled={reconnect.isPending}
                                className="text-[12px] text-t3 transition-colors hover:text-t1"
                              >
                                Re-register
                              </button>
                            )}
                          </span>
                        ) : (
                          <div>
                            <span className="inline-flex items-center gap-2">
                              {c.channel === 'slack' && c.status === 'pending' && (
                                <>
                                  <StatusBadge status="pending" />
                                  {installing?.id === c.id ? (
                                    <span className="inline-flex items-center gap-1.5 text-[12px] text-t3">
                                      <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-t3" />
                                      Listening…
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => void onInstallClick(c.id)}
                                      className="text-[12px] text-t3 transition-colors hover:text-t1"
                                    >
                                      Install to workspace
                                    </button>
                                  )}
                                </>
                              )}
                              <button
                                type="button"
                                onClick={() => toggleUrl(c.id)}
                                className="text-[12px] text-t3 transition-colors hover:text-t1"
                              >
                                {c.channel === 'slack'
                                  ? expanded.has(c.id)
                                    ? 'Hide URLs'
                                    : 'View URLs'
                                  : expanded.has(c.id)
                                    ? 'Hide URL'
                                    : 'View URL'}
                              </button>
                            </span>
                            {c.channel === 'slack' && c.status === 'pending' && (
                              <span className="mt-0.5 block text-[11px] text-t3">
                                app created — awaiting workspace install
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className={td}>
                        <Mono className="text-t3">{timeAgo(c.createdAt)}</Mono>
                      </td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        {c.channel === 'slack' && (
                          <button
                            type="button"
                            onClick={() => setRoutesConn(c)}
                            className="mr-3 text-[12px] text-t3 transition-colors hover:text-t1"
                          >
                            Routes
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onDisconnectClick(c.id)}
                          disabled={disconnect.isPending}
                          className="text-[12px] text-t3 transition-colors hover:text-t1"
                        >
                          {confirmingId === c.id ? 'confirm?' : 'Disconnect'}
                        </button>
                      </td>
                    </tr>
                    {c.channel === 'email' && expanded.has(c.id) && c.webhook?.url && (
                      <tr>
                        <td className={`${td} pt-0`} colSpan={6}>
                          <CopyField value={c.webhook.url} />
                        </td>
                      </tr>
                    )}
                    {c.channel === 'slack' && expanded.has(c.id) && c.webhook && (
                      <tr>
                        <td className={`${td} pt-0`} colSpan={6}>
                          <div className="space-y-3">
                            <SlackAutoUpdate conn={c} onUpdated={invalidate} />
                            {c.webhook.eventsUrl && (
                              <Field label="Events URL — Event Subscriptions → Request URL">
                                <CopyField value={c.webhook.eventsUrl} />
                              </Field>
                            )}
                            {c.webhook.interactivityUrl && (
                              <Field label="Interactivity URL — Interactivity & Shortcuts → Request URL">
                                <CopyField value={c.webhook.interactivityUrl} />
                              </Field>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No connections yet"
          body="Connect a Telegram bot (create one with @BotFather, /newbot, then paste its token) or an inbound email address, and route it to an agent. Use the Connect button above to start."
        />
      )}

      {connectOpen && (
        <ConnectModal
          agents={activeAgents}
          onClose={() => setConnectOpen(false)}
          onConnected={invalidate}
        />
      )}

      {repoint && (
        <RepointModal
          identity={identityLabel(repoint.conn)}
          agentName={repointAgentName ?? repoint.agentIdentifier}
          pending={move.isPending}
          onCancel={() => setRepoint(null)}
          onConfirm={() =>
            move.mutate({ id: repoint.conn.id, agentIdentifier: repoint.agentIdentifier })
          }
        />
      )}

      {routesConn && (
        <RoutesModal
          conn={routesConn}
          agents={activeAgents}
          onClose={() => setRoutesConn(null)}
        />
      )}
    </>
  );
}
