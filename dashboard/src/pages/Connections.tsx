import { Fragment, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
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
  channel: 'telegram' | 'email';
  status: 'active' | 'disabled';
  config: { botUsername?: string; botId?: string; address?: string };
  agent: { identifier: string; name: string };
  webhook: {
    url?: string;
    expectedUrl?: string;
    pendingUpdates?: number;
    lastError?: string | null;
  } | null;
  createdAt: string;
}

interface AgentOption {
  identifier: string;
  name: string;
  status: string;
}

/** The identity a connection answers on — a telegram @handle or an inbox address. */
function identityLabel(c: Connection): string {
  return c.channel === 'telegram' ? `@${c.config.botUsername ?? '—'}` : c.config.address ?? '—';
}

/**
 * Connect a new channel. A segmented Telegram | Email picker over the two
 * POST shapes; on success we surface the webhook URL to register upstream.
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
  const [channel, setChannel] = useState<'telegram' | 'email'>('telegram');
  const [error, setError] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');

  const connect = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ webhookUrl: string }>(`/v1/connections/${channel}`, { method: 'POST', body }),
    onSuccess: (res) => {
      setError('');
      setWebhookUrl(res.webhookUrl);
      onConnected();
    },
    onError: (err) => setError(err.message),
  });

  const agentSelect = (
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
  );

  if (webhookUrl) {
    return (
      <Modal open onClose={onClose} title="Channel connected">
        <div className="space-y-3">
          {channel === 'email' ? (
            <p className="text-[12px] text-t2">
              Paste this webhook URL into your provider's inbound settings (Postmark: Servers →
              Default Inbound Stream → Settings → Webhook). Emails to the address then arrive here
              as conversations.
            </p>
          ) : (
            <p className="text-[12px] text-t2">
              We validated the token and registered this webhook with Telegram. Messages to the bot
              now flow to the chosen agent.
            </p>
          )}
          <CopyField value={webhookUrl} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Connect a channel">
      <div className="mb-4 inline-flex rounded-md border border-bd p-0.5">
        {(['telegram', 'email'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => {
              setChannel(c);
              setError('');
            }}
            className={`h-7 rounded px-3 text-[12px] font-medium capitalize transition-colors ${
              channel === c ? 'bg-elevated text-t1' : 'text-t2 hover:text-t1'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {channel === 'telegram' ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const botToken = String(form.get('botToken') ?? '');
            const agentIdentifier = String(form.get('agentIdentifier') ?? '');
            if (botToken && agentIdentifier) connect.mutate({ botToken, agentIdentifier });
          }}
        >
          <p className="text-[12px] text-t2">
            Create a bot with <Mono>@BotFather</Mono> on Telegram (<Mono>/newbot</Mono>), then
            paste its token here. We validate it, register the webhook, and messages to the bot
            flow to this agent. Requires this server to be reachable from the internet
            (PUBLIC_URL) — locally, run a tunnel.
          </p>
          <Field label="Bot token">
            <Input
              name="botToken"
              required
              autoFocus
              placeholder="7000000000:AA..."
              className="font-mono"
              type="password"
              autoComplete="off"
            />
          </Field>
          {agentSelect}
          {error && <p className="text-[12px] text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={connect.isPending}>
              {connect.isPending ? 'Connecting…' : 'Connect Telegram'}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const address = String(form.get('address') ?? '');
            const agentIdentifier = String(form.get('agentIdentifier') ?? '');
            if (address && agentIdentifier) connect.mutate({ address, agentIdentifier });
          }}
        >
          <p className="text-[12px] text-t2">
            Give this agent an email address. No DNS needed: a free Postmark account includes an
            inbound address (Servers → Default Inbound Stream) like{' '}
            <Mono>hash@inbound.postmarkapp.com</Mono> — paste it below, then paste the webhook URL
            we generate back into Postmark.
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
          {agentSelect}
          {error && <p className="text-[12px] text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={connect.isPending}>
              {connect.isPending ? 'Connecting…' : 'Connect email'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
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

export default function ConnectionsPage() {
  const queryClient = useQueryClient();
  const [connectOpen, setConnectOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [repoint, setRepoint] = useState<{ conn: Connection; agentIdentifier: string } | null>(null);

  // Two-step inline confirm for disconnect.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['connections'] });

  const { data, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: Connection[] }>('/v1/connections'),
    refetchInterval: 10_000,
  });

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
                          <button
                            type="button"
                            onClick={() => toggleUrl(c.id)}
                            className="text-[12px] text-t3 transition-colors hover:text-t1"
                          >
                            {expanded.has(c.id) ? 'Hide URL' : 'View URL'}
                          </button>
                        )}
                      </td>
                      <td className={td}>
                        <Mono className="text-t3">{timeAgo(c.createdAt)}</Mono>
                      </td>
                      <td className={`${td} text-right whitespace-nowrap`}>
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
    </>
  );
}
