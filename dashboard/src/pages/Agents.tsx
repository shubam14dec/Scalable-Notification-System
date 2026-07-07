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
  bridgeUrl: string;
  status: 'active' | 'disabled';
  createdAt: string;
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
  onSubmit: (body: { identifier: string; name: string; description?: string; bridgeUrl: string }) => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        onSubmit({
          identifier: String(form.get('identifier') ?? initial?.identifier ?? ''),
          name: String(form.get('name')),
          description: String(form.get('description') ?? '') || undefined,
          bridgeUrl: String(form.get('bridgeUrl')),
        });
      }}
    >
      {!initial?.identifier && (
        <Field label="Identifier" hint="Stable id used by the widget and SDK — cannot change later">
          <Input name="identifier" required autoFocus placeholder="support" className="font-mono" pattern="[a-z0-9-_]+" />
        </Field>
      )}
      <Field label="Name">
        <Input name="name" required placeholder="Support agent" defaultValue={initial?.name} />
      </Field>
      <Field label="Bridge URL" hint="Where your handler listens — we POST every conversation turn here, signed">
        <Input
          name="bridgeUrl"
          required
          type="url"
          placeholder="https://app.example.com/asyncify-agent"
          defaultValue={initial?.bridgeUrl}
          className="font-mono"
        />
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
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['agents'] });

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Agent[] }>('/v1/agents'),
  });

  const create = useMutation({
    mutationFn: (body: { identifier: string; name: string; description?: string; bridgeUrl: string }) =>
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
    mutationFn: ({ identifier, ...body }: { identifier: string; name?: string; description?: string; bridgeUrl?: string; status?: string }) =>
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
                <th className={th}>Bridge URL</th>
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
                    <Mono className="text-t2">{a.bridgeUrl}</Mono>
                  </td>
                  <td className={td}>
                    <StatusBadge status={a.status} />
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(a.createdAt)}</Mono>
                  </td>
                  <td className={`${td} text-right whitespace-nowrap`}>
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
                bridgeUrl: body.bridgeUrl,
              })
            }
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}

      {secret && <SecretReveal secret={secret} onClose={() => setSecret('')} />}
    </>
  );
}
