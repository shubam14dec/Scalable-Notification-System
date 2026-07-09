import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

interface Agent {
  identifier: string;
  name: string;
  description: string | null;
  runtime: 'bridge' | 'managed';
  bridgeUrl: string | null;
  model: string | null;
  systemPrompt: string | null;
  llmBaseUrl: string | null;
  maxTokens: number | null;
  autoResolveMinutes: number | null;
  hasLlmKey: boolean;
  status: 'active' | 'disabled';
  createdAt: string;
}

interface AgentBody {
  identifier: string;
  name: string;
  description?: string;
  runtime: 'bridge' | 'managed';
  bridgeUrl?: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  autoResolveMinutes?: number | null;
  llm?: { apiKey?: string; baseUrl?: string | null };
}

interface ChannelInfo {
  channel: string;
  status: string;
  config: { botUsername?: string; address?: string };
  webhook: {
    url?: string;
    pendingUpdates?: number;
    lastError?: string | null;
    expectedUrl?: string;
    error?: string;
  } | null;
}

/** Email: user brings a provider inbound address, we hand back the webhook URL. */
function EmailChannelSection({
  agent,
  connection,
  onChange,
}: {
  agent: Agent;
  connection: ChannelInfo | undefined;
  onChange: () => void;
}) {
  const [error, setError] = useState('');

  const connect = useMutation({
    mutationFn: (address: string) =>
      api(`/v1/agents/${agent.identifier}/channels/email`, { method: 'POST', body: { address } }),
    onSuccess: () => {
      setError('');
      onChange();
    },
    onError: (err) => setError(err.message),
  });

  const disconnect = useMutation({
    mutationFn: () => api(`/v1/agents/${agent.identifier}/channels/email`, { method: 'DELETE' }),
    onSuccess: onChange,
  });

  if (connection) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-t1">Email</span>
          <StatusBadge status="active" />
        </div>
        <dl className="space-y-2 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-t3">Agent address</dt>
            <dd><Mono className="break-all">{connection.config.address}</Mono></dd>
          </div>
          <div>
            <dt className="mb-1 text-t3">
              Webhook URL — paste into your provider's inbound settings (Postmark: Servers →
              Default Inbound Stream → Settings → Webhook)
            </dt>
            <dd>{connection.webhook?.url && <CopyField value={connection.webhook.url} />}</dd>
          </div>
        </dl>
        <p className="text-[11px] text-t3">
          Emails sent to the address arrive here as conversations; the agent's replies go out
          through this environment's email integrations.
        </p>
        <div className="flex justify-end">
          <Button variant="danger" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            Disconnect
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const address = String(new FormData(e.currentTarget).get('address') ?? '');
        if (address) connect.mutate(address);
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
      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end">
        <Button variant="primary" type="submit" disabled={connect.isPending}>
          {connect.isPending ? 'Connecting…' : 'Connect email'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Per-agent channel connections (v1: Telegram). Paste a bot token, we
 * validate it with Telegram and register the webhook against PUBLIC_URL;
 * the modal shows what Telegram actually has registered, so a stale
 * tunnel URL is visible and one click away from fixed.
 */
function ChannelsModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['agent-channels', agent.identifier] });

  const { data, isLoading } = useQuery({
    queryKey: ['agent-channels', agent.identifier],
    queryFn: () => api<{ channels: ChannelInfo[] }>(`/v1/agents/${agent.identifier}/channels`),
  });
  const telegram = data?.channels.find((c) => c.channel === 'telegram');

  const connect = useMutation({
    mutationFn: (botToken: string) =>
      api(`/v1/agents/${agent.identifier}/channels/telegram`, { method: 'POST', body: { botToken } }),
    onSuccess: () => {
      setError('');
      invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const reconnect = useMutation({
    mutationFn: () =>
      api(`/v1/agents/${agent.identifier}/channels/telegram/reconnect`, { method: 'POST' }),
    onSuccess: () => {
      setError('');
      invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const disconnect = useMutation({
    mutationFn: () => api(`/v1/agents/${agent.identifier}/channels/telegram`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const email = data?.channels.find((c) => c.channel === 'email');
  const webhookHealthy =
    telegram?.webhook?.url && telegram.webhook.url === telegram.webhook.expectedUrl;

  const telegramSection = isLoading ? (
    <Skeleton className="h-24 w-full" />
  ) : telegram ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-t1">Telegram</span>
            <StatusBadge status={webhookHealthy ? 'active' : 'failed'} />
          </div>
          <dl className="space-y-2 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-t3">Bot</dt>
              <dd><Mono>@{telegram.config.botUsername ?? '—'}</Mono></dd>
            </div>
            <div>
              <dt className="mb-1 text-t3">Webhook registered with Telegram</dt>
              <dd><Mono className="break-all text-t2">{telegram.webhook?.url || 'none'}</Mono></dd>
            </div>
            {!webhookHealthy && telegram.webhook?.expectedUrl && (
              <div>
                <dt className="mb-1 text-t3">Expected (current PUBLIC_URL)</dt>
                <dd><Mono className="break-all text-t2">{telegram.webhook.expectedUrl}</Mono></dd>
              </div>
            )}
            {telegram.webhook?.lastError && (
              <div>
                <dt className="mb-1 text-t3">Last delivery error from Telegram</dt>
                <dd className="text-err">{telegram.webhook.lastError}</dd>
              </div>
            )}
          </dl>
          {!webhookHealthy && (
            <p className="text-[12px] text-t3">
              The registered webhook doesn't match this server's public URL — if your tunnel
              or domain changed, re-register it.
            </p>
          )}
          {error && <p className="text-[12px] text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="danger" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              Disconnect
            </Button>
            <Button variant="primary" onClick={() => reconnect.mutate()} disabled={reconnect.isPending}>
              {reconnect.isPending ? 'Registering…' : 'Re-register webhook'}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const token = String(new FormData(e.currentTarget).get('botToken') ?? '');
            if (token) connect.mutate(token);
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
  );

  return (
    <Modal open onClose={onClose} title={`Channels — ${agent.identifier}`}>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-t3">Telegram</p>
      {telegramSection}
      <div className="my-4 border-t border-bd" />
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-t3">Email</p>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <EmailChannelSection agent={agent} connection={email} onChange={invalidate} />
      )}
    </Modal>
  );
}

/** Shown once after create/rotate — the same doctrine as API keys. */
function SecretReveal({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Signing secret">
      <p className="mb-3 text-[12px] text-t2">
        Give this to your agent's handler (<Mono>createHandler</Mono> from{' '}
        <Mono>@asyncify-hq/agent</Mono>). It is shown only once — rotate it if lost.
      </p>
      <CopyField value={secret} />
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          I saved it
        </Button>
      </div>
    </Modal>
  );
}

function AgentForm({
  initial,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<Agent>;
  pending: boolean;
  error: string;
  submitLabel: string;
  onSubmit: (body: AgentBody) => void;
  onCancel: () => void;
}) {
  const [runtime, setRuntime] = useState<'bridge' | 'managed'>(initial?.runtime ?? 'bridge');
  const editing = Boolean(initial?.identifier);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const str = (key: string) => String(form.get(key) ?? '').trim();
        const body: AgentBody = {
          identifier: str('identifier') || initial?.identifier || '',
          name: str('name'),
          description: str('description') || undefined,
          runtime,
        };
        if (runtime === 'bridge') {
          body.bridgeUrl = str('bridgeUrl');
        } else {
          body.model = str('model') || undefined;
          body.systemPrompt = str('systemPrompt') || undefined;
          const maxTokens = Number.parseInt(str('maxTokens'), 10);
          if (Number.isFinite(maxTokens)) body.maxTokens = maxTokens;
          const apiKey = str('llmApiKey');
          const baseUrl = str('llmBaseUrl');
          // On edit, a blank key means "keep the stored one".
          if (apiKey || baseUrl || !editing) {
            body.llm = {
              ...(apiKey ? { apiKey } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            };
          }
        }
        const arHours = Number.parseInt(str('autoResolveH'), 10);
        const arMins = Number.parseInt(str('autoResolveM'), 10);
        const totalMinutes =
          (Number.isFinite(arHours) ? arHours * 60 : 0) + (Number.isFinite(arMins) ? arMins : 0);
        if (totalMinutes > 0) {
          body.autoResolveMinutes = totalMinutes;
        } else if (editing && initial?.autoResolveMinutes) {
          body.autoResolveMinutes = null; // both cleared = backstop off
        }
        onSubmit(body);
      }}
    >
      {!editing && (
        <Field label="Identifier" hint="Stable id used by the widget and SDK — cannot change later">
          <Input name="identifier" required autoFocus placeholder="support" className="font-mono" pattern="[a-z0-9-_]+" />
        </Field>
      )}
      <Field label="Name">
        <Input name="name" required placeholder="Support agent" defaultValue={initial?.name} />
      </Field>

      <Field label="Runtime" hint="Who answers each message">
        <select
          aria-label="Runtime"
          className="h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[13px] text-t1 hover:border-bd-strong"
          value={runtime}
          onChange={(e) => setRuntime(e.target.value as 'bridge' | 'managed')}
        >
          <option value="bridge" className="bg-surface">Your code — we POST turns to your bridge URL</option>
          <option value="managed" className="bg-surface">Managed LLM — we run the model, zero code</option>
        </select>
      </Field>

      {runtime === 'bridge' ? (
        <Field label="Bridge URL" hint="Where your handler listens — we POST every conversation turn here, signed">
          <Input
            name="bridgeUrl"
            required
            type="url"
            placeholder="https://app.example.com/asyncify-agent"
            defaultValue={initial?.bridgeUrl ?? ''}
            className="font-mono"
          />
        </Field>
      ) : (
        <>
          <Field label="System prompt" hint="The agent's role, tone, and boundaries — runs on every turn">
            <textarea
              name="systemPrompt"
              rows={5}
              placeholder="You are the Acme support agent. Be brief and friendly…"
              defaultValue={initial?.systemPrompt ?? ''}
              className="w-full rounded-md border border-bd bg-transparent px-2.5 py-2 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong"
            />
          </Field>
          <Field label="Model" hint="Defaults to claude-opus-4-8; use your endpoint's model id if you set a base URL">
            <Input name="model" placeholder="claude-opus-4-8" defaultValue={initial?.model ?? ''} className="font-mono" />
          </Field>
          <Field label="Max reply tokens" hint="Per-reply output cap, 256–8192 (blank = 1024). Controls spend on your key">
            <Input
              name="maxTokens"
              type="number"
              min={256}
              max={8192}
              placeholder="1024"
              defaultValue={initial?.maxTokens ?? ''}
              className="font-mono"
            />
          </Field>
          <Field
            label="API key"
            hint={
              initial?.hasLlmKey
                ? 'A key is stored — leave blank to keep it, paste to replace'
                : 'Stored encrypted, never shown again'
            }
          >
            <Input
              name="llmApiKey"
              type="password"
              autoComplete="off"
              required={runtime === 'managed' && !initial?.hasLlmKey}
              placeholder={initial?.hasLlmKey ? '••••••••  (kept)' : 'sk-ant-… or your provider key'}
              className="font-mono"
            />
          </Field>
          <Field
            label="Base URL"
            hint="Optional — any Anthropic-compatible endpoint (e.g. z.ai). Blank = api.anthropic.com"
          >
            <Input
              name="llmBaseUrl"
              type="url"
              placeholder="https://api.z.ai/api/anthropic"
              defaultValue={initial?.llmBaseUrl ?? ''}
              className="font-mono"
            />
          </Field>
        </>
      )}

      <Field
        label="Auto-resolve after inactivity"
        hint="Conversations idle this long resolve automatically (up to 720h). Blank = never — a new message always reopens"
      >
        <div className="flex items-center gap-2">
          <Input
            name="autoResolveH"
            type="number"
            min={0}
            max={720}
            placeholder="0"
            aria-label="Hours"
            defaultValue={
              initial?.autoResolveMinutes ? Math.floor(initial.autoResolveMinutes / 60) || '' : ''
            }
            className="font-mono"
          />
          <span className="shrink-0 text-[12px] text-t3">hours</span>
          <Input
            name="autoResolveM"
            type="number"
            min={0}
            max={59}
            placeholder="0"
            aria-label="Minutes"
            defaultValue={initial?.autoResolveMinutes ? initial.autoResolveMinutes % 60 || '' : ''}
            className="font-mono"
          />
          <span className="shrink-0 text-[12px] text-t3">min</span>
        </div>
      </Field>
      <Field label="Description">
        <Input name="description" placeholder="What this agent handles (optional)" defaultValue={initial?.description ?? ''} />
      </Field>
      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export default function AgentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [channelsFor, setChannelsFor] = useState<Agent | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['agents'] });

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Agent[] }>('/v1/agents'),
  });

  const create = useMutation({
    mutationFn: (body: AgentBody) =>
      api<{ signingSecret: string }>('/v1/agents', { method: 'POST', body }),
    onSuccess: (res) => {
      setCreateOpen(false);
      setError('');
      setSecret(res.signingSecret);
      invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const update = useMutation({
    mutationFn: ({ identifier, ...body }: Partial<AgentBody> & { identifier: string; status?: string }) =>
      api(`/v1/agents/${identifier}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setEditing(null);
      setError('');
      invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const rotate = useMutation({
    mutationFn: (identifier: string) =>
      api<{ signingSecret: string }>(`/v1/agents/${identifier}/rotate-secret`, { method: 'POST' }),
    onSuccess: (res) => setSecret(res.signingSecret),
  });

  const remove = useMutation({
    mutationFn: (identifier: string) => api(`/v1/agents/${identifier}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  return (
    <>
      <PageHeader
        title="Agents"
        action={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            New agent
          </Button>
        }
      />
      <p className="-mt-4 mb-5 max-w-2xl text-[12px] text-t3">
        An agent is your code answering conversations: register the URL your handler listens on,
        and every message a subscriber sends arrives there as one signed event. Replies and
        workflow triggers come back in the response — see <Mono>@asyncify-hq/agent</Mono>.
      </p>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.agents.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Identifier</th>
                <th className={th}>Name</th>
                <th className={th}>Brain</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Created</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.identifier} className="transition-colors hover:bg-elevated">
                  <td className={td}>
                    <button
                      className="font-mono text-[12px] text-t1 hover:underline"
                      onClick={() => navigate(`/conversations?agent=${a.identifier}`)}
                      title="View this agent's conversations"
                    >
                      {a.identifier}
                    </button>
                  </td>
                  <td className={td}>{a.name}</td>
                  <td className={td}>
                    <Mono className="text-t2">
                      {a.runtime === 'managed'
                        ? `managed · ${a.model ?? 'claude-opus-4-8'}`
                        : a.bridgeUrl}
                    </Mono>
                  </td>
                  <td className={td}>
                    <StatusBadge status={a.status} />
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(a.createdAt)}</Mono>
                  </td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    <Button variant="ghost" onClick={() => setChannelsFor(a)}>
                      Channels
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(a)}>
                      Edit
                    </Button>
                    <Button variant="ghost" onClick={() => rotate.mutate(a.identifier)}>
                      Rotate secret
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        update.mutate({
                          identifier: a.identifier,
                          status: a.status === 'active' ? 'disabled' : 'active',
                        })
                      }
                    >
                      {a.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(`Delete agent "${a.identifier}" and all its conversations?`)) {
                          remove.mutate(a.identifier);
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No agents yet"
          body="Register your first agent, point it at your handler, and your users can talk to it from the in-app widget."
          snippet={`import { defineAgent, createHandler } from '@asyncify-hq/agent';

const support = defineAgent({
  onMessage: (ctx) => \`You said: \${ctx.message.text}\`,
});

http.createServer(createHandler(support, {
  signingSecret: process.env.ASYNCIFY_AGENT_SECRET,
})).listen(4100);`}
        />
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New agent">
        <AgentForm
          pending={create.isPending}
          error={error}
          submitLabel="Create agent"
          onSubmit={(body) => create.mutate(body)}
          onCancel={() => setCreateOpen(false)}
        />
      </Modal>

      {editing && (
        <Modal open onClose={() => setEditing(null)} title={`Edit ${editing.identifier}`}>
          <AgentForm
            initial={editing}
            pending={update.isPending}
            error={error}
            submitLabel="Save changes"
            onSubmit={(body) =>
              update.mutate({
                identifier: editing.identifier,
                name: body.name,
                description: body.description,
                runtime: body.runtime,
                bridgeUrl: body.bridgeUrl,
                model: body.model,
                systemPrompt: body.systemPrompt,
                maxTokens: body.maxTokens,
                autoResolveMinutes: body.autoResolveMinutes,
                llm: body.llm,
              })
            }
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}

      {channelsFor && <ChannelsModal agent={channelsFor} onClose={() => setChannelsFor(null)} />}

      {secret && <SecretReveal secret={secret} onClose={() => setSecret('')} />}
    </>
  );
}
