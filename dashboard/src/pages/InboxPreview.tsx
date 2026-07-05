import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Card, Field, Input, Mono, PageHeader } from '../ui';
// Dogfooding: this is the ACTUAL embeddable widget from packages/react —
// the same component customers drop into their apps.
import { NotificationInbox } from '../../../packages/react/src';

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
        <Mono>@notify/react</Mono> — exactly what your users would see in your app. Trigger a
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
          />
          <span className="text-[12px] text-t3">
            ← your app's bell, live for <Mono>{session.subscriberId}</Mono>. Fire a{' '}
            <Mono>Send test</Mono> from Workflows and watch it arrive.
          </span>
        </div>
      )}
    </>
  );
}
