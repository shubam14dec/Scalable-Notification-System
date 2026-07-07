import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Card, Field, Input, Mono, PageHeader } from '../ui';
// Dogfooding: these are the ACTUAL embeddable widgets from packages/react —
// the same components customers drop into their apps.
import { AgentChat, NotificationInbox } from '../../../packages/react/src';

export default function InboxPreviewPage() {
  const [subscriberId, setSubscriberId] = useState('customer-42');
  const [session, setSession] = useState<{ token: string; subscriberId: string } | null>(null);
  const theme = (document.documentElement.dataset.theme ?? 'dark') as 'dark' | 'light';

  const mint = useMutation({
    mutationFn: (sub: string) =>
      api<{ token: string }>('/v1/subscriber-tokens', {
        method: 'POST',
        body: { subscriberId: sub },
      }),
    onSuccess: (res, sub) => setSession({ token: res.token, subscriberId: sub }),
  });

  return (
    <>
      <PageHeader title="Inbox preview" />
      <p className="-mt-4 mb-5 max-w-xl text-[12px] text-t3">
        This renders the real <Mono>&lt;NotificationInbox /&gt;</Mono> widget from{' '}
        <Mono>@asyncify-hq/react</Mono> — exactly what your users would see in your app. Trigger a
        workflow to this subscriber and watch the bell update live.
      </p>

      <Card className="mb-5 max-w-md p-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            mint.mutate(subscriberId);
          }}
        >
          <div className="flex-1">
            <Field label="Preview as subscriber">
              <Input
                value={subscriberId}
                onChange={(e) => setSubscriberId(e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>
          <Button variant="primary" type="submit" disabled={mint.isPending}>
            {mint.isPending ? 'Loading…' : session ? 'Switch' : 'Preview'}
          </Button>
        </form>
        {mint.isError && <p className="mt-2 text-[12px] text-err">{mint.error.message}</p>}
      </Card>

      {session && (
        <div className="flex items-center gap-4">
          <NotificationInbox
            key={session.token}
            token={session.token}
            subscriberId={session.subscriberId}
            apiUrl=""
            wsUrl="ws://localhost:3001"
            theme={theme}
            align="left"
          />
          <span className="text-[12px] text-t3">
            ← your app's bell, live for <Mono>{session.subscriberId}</Mono>. Fire a{' '}
            <Mono>Send test</Mono> from Workflows and watch it arrive.
          </span>
        </div>
      )}

      {session && <AgentChatPreview token={session.token} subscriberId={session.subscriberId} theme={theme} />}
    </>
  );
}

/** The other widget: chat with one of this environment's agents, live. */
function AgentChatPreview({
  token,
  subscriberId,
  theme,
}: {
  token: string;
  subscriberId: string;
  theme: 'dark' | 'light';
}) {
  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Array<{ identifier: string; status: string }> }>('/v1/agents'),
  });
  const active = data?.agents.filter((a) => a.status === 'active') ?? [];
  const [identifier, setIdentifier] = useState('');
  const chosen = identifier || active[0]?.identifier;

  if (!data) return null;
  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-3">
        <p className="text-[12px] text-t3">
          And this is <Mono>&lt;AgentChat /&gt;</Mono> — the same subscriber talking to
        </p>
        {active.length > 1 ? (
          <select
            aria-label="Agent to chat with"
            className="h-7 rounded-md border border-bd bg-transparent px-2 text-[12px] text-t1"
            value={chosen ?? ''}
            onChange={(e) => setIdentifier(e.target.value)}
          >
            {active.map((a) => (
              <option key={a.identifier} value={a.identifier} className="bg-surface">
                {a.identifier}
              </option>
            ))}
          </select>
        ) : (
          <Mono className="text-t2">{chosen ?? 'no active agent'}</Mono>
        )}
      </div>
      {chosen ? (
        <AgentChat
          key={`${token}:${chosen}`}
          token={token}
          subscriberId={subscriberId}
          agentIdentifier={chosen}
          apiUrl=""
          wsUrl="ws://localhost:3001"
          theme={theme}
        />
      ) : (
        <p className="text-[12px] text-t3">
          Create an agent on the Agents page (or run <Mono>npm run agent:demo</Mono>) and it
          appears here.
        </p>
      )}
    </div>
  );
}
