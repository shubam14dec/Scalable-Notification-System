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

/**
 * Per-agent channel connections, read-only. Shows what's wired to this agent;
 * connecting, re-pointing, and disconnecting all live on the Connections page.
 */
function ChannelsModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-channels', agent.identifier],
    queryFn: () => api<{ channels: ChannelInfo[] }>(`/v1/agents/${agent.identifier}/channels`),
  });

  return (
    <Modal open onClose={onClose} title={`Channels — ${agent.identifier}`}>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : data && data.channels.length > 0 ? (
        <ul className="space-y-3">
          {data.channels.map((c) => {
            const identity =
              c.channel === 'telegram' ? `@${c.config.botUsername ?? '—'}` : c.config.address ?? '—';
            const webhookHealthy =
              c.webhook?.url && c.webhook.url === c.webhook.expectedUrl;
            return (
              <li
                key={c.channel}
                className="flex items-center justify-between gap-2 border-b border-bd pb-3 last:border-0 last:pb-0"
              >
                <span className="min-w-0">
                  <span className="text-[13px] text-t1 capitalize">{c.channel}</span>{' '}
                  <Mono className="break-all text-t2">{identity}</Mono>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={c.status} />
                  {c.channel === 'telegram' && (
                    <StatusBadge status={webhookHealthy ? 'active' : 'failed'} />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12px] text-t3">No channels connected to this agent yet.</p>
      )}
      <div className="mt-4 flex justify-end border-t border-bd pt-4">
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            navigate('/connections');
          }}
        >
          Manage on the Connections page →
        </Button>
      </div>
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
  // Delete failures (e.g. 409: agent still has routed connections) surface
  // here, since the delete action has no modal of its own to show them in.
  const [deleteError, setDeleteError] = useState('');

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
    onSuccess: () => {
      setDeleteError('');
      invalidate();
    },
    onError: (err, identifier) => setDeleteError(`Couldn't delete "${identifier}" — ${err.message}`),
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

      {deleteError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-bd bg-elevated px-3 py-2">
          <span className="text-[12px] text-err">{deleteError}</span>
          <button
            className="shrink-0 text-[12px] text-t3 transition-colors hover:text-t1"
            onClick={() => setDeleteError('')}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

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
