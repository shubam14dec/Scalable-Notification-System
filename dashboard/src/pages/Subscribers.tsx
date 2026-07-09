import { useState } from 'react';
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
  td,
  th,
} from '../ui';
import { timeAgo } from './Activity';

interface SubscriberRow {
  external_id: string;
  email: string | null;
  phone: string | null;
  has_push: boolean;
  created_at: string;
}

/**
 * Channel linking: mint the deep link that merges a telegram identity into
 * this subscriber, and inspect/undo existing mappings. Email links itself
 * (auto-match on the sender address) — shown here once it happens.
 */
function LinkChannelsModal({ subscriberId, onClose }: { subscriberId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [agent, setAgent] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [error, setError] = useState('');

  const { data: identities } = useQuery({
    queryKey: ['identities', subscriberId],
    queryFn: () =>
      api<{ identities: Array<{ channel: string; externalKey: string; linkedAt: string }> }>(
        `/v1/subscribers/${encodeURIComponent(subscriberId)}/identities`,
      ),
  });
  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Array<{ identifier: string; status: string }> }>('/v1/agents'),
  });
  const active = agents?.agents.filter((a) => a.status === 'active') ?? [];
  const chosen = agent || active[0]?.identifier;

  const mint = useMutation({
    mutationFn: () =>
      api<{ deepLink: string }>(
        `/v1/agents/${encodeURIComponent(chosen!)}/subscribers/${encodeURIComponent(subscriberId)}/link-token`,
        { method: 'POST' },
      ),
    onSuccess: (res) => {
      setDeepLink(res.deepLink);
      setError('');
    },
    onError: (err) => setError(err.message),
  });

  const unlink = useMutation({
    mutationFn: (i: { channel: string; externalKey: string }) =>
      api(`/v1/subscribers/${encodeURIComponent(subscriberId)}/identities`, {
        method: 'DELETE',
        body: i,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['identities', subscriberId] }),
  });

  return (
    <Modal open onClose={onClose} title={`Linked channels — ${subscriberId}`}>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-t3">
            Linked identities
          </p>
          {identities && identities.identities.length > 0 ? (
            <ul className="space-y-1.5">
              {identities.identities.map((i) => (
                <li key={`${i.channel}:${i.externalKey}`} className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-t1">
                    <Mono className="text-t3">{i.channel}</Mono>{' '}
                    <Mono>{i.externalKey}</Mono>
                    <span className="ml-2 text-[11px] text-t3">{timeAgo(i.linkedAt)}</span>
                  </span>
                  <Button onClick={() => unlink.mutate(i)} disabled={unlink.isPending}>
                    Unlink
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-t3">
              None yet — this subscriber is only known by their app identity.
            </p>
          )}
        </div>

        <div className="border-t border-bd pt-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-t3">
            Link Telegram
          </p>
          <p className="mb-3 text-[12px] text-t3">
            Generate a single-use link (valid 24h). When this user opens it and taps
            Start, their Telegram merges into this subscriber — history, triggers, and
            notifications included.
          </p>
          <div className="flex items-center gap-2">
            {active.length > 1 && (
              <select
                aria-label="Agent bot"
                className="h-8 rounded-md border border-bd bg-transparent px-2 text-[12px] text-t1"
                value={chosen ?? ''}
                onChange={(e) => setAgent(e.target.value)}
              >
                {active.map((a) => (
                  <option key={a.identifier} value={a.identifier} className="bg-surface">
                    {a.identifier}
                  </option>
                ))}
              </select>
            )}
            <Button variant="primary" onClick={() => mint.mutate()} disabled={!chosen || mint.isPending}>
              {mint.isPending ? 'Generating…' : 'Generate link'}
            </Button>
          </div>
          {deepLink && (
            <div className="mt-3">
              <CopyField value={deepLink} />
            </div>
          )}
          {error && <p className="mt-2 text-[12px] text-err">{error}</p>}
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

export default function SubscribersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['subscribers', search],
    queryFn: () =>
      api<{ subscribers: SubscriberRow[] }>(
        `/v1/subscribers?limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      ),
  });

  const upsert = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api('/v1/subscribers', { method: 'PUT', body }),
    onSuccess: () => {
      setAddOpen(false);
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['subscribers'] });
    },
    onError: (err) => setError(err.message),
  });

  return (
    <>
      <PageHeader
        title="Subscribers"
        action={
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search by id or email…"
              className="w-64"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              Add subscriber
            </Button>
          </div>
        }
      />

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add subscriber">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const body: Record<string, string> = {
              subscriberId: String(form.get('subscriberId')),
            };
            for (const field of ['email', 'phone', 'pushToken']) {
              const value = String(form.get(field) ?? '').trim();
              if (value) body[field] = value;
            }
            upsert.mutate(body);
          }}
        >
          <Field label="Subscriber ID" hint="Your app's user id — used in trigger calls and topics">
            <Input name="subscriberId" required autoFocus placeholder="user-123" className="font-mono" />
          </Field>
          <Field label="Email (optional)">
            <Input name="email" type="email" placeholder="user@example.com" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone (optional)">
              <Input name="phone" placeholder="+15550001111" />
            </Field>
            <Field label="Push token (optional)">
              <Input name="pushToken" className="font-mono" placeholder="device token" />
            </Field>
          </div>
          <p className="text-[11px] text-t3">
            Adding an existing ID updates it — blank fields keep their current values.
          </p>
          {error && <p className="text-[12px] text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={upsert.isPending}>
              {upsert.isPending ? 'Saving…' : 'Save subscriber'}
            </Button>
          </div>
        </form>
      </Modal>
      {linkFor && <LinkChannelsModal subscriberId={linkFor} onClose={() => setLinkFor(null)} />}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.subscribers.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Subscriber</th>
                <th className={th}>Email</th>
                <th className={th}>Phone</th>
                <th className={th}>Push</th>
                <th className={th}>Added</th>
                <th className={`${th} text-right`}>Channels</th>
              </tr>
            </thead>
            <tbody>
              {data.subscribers.map((s) => (
                <tr key={s.external_id} className="transition-colors hover:bg-elevated">
                  <td className={td}>
                    <Mono>{s.external_id}</Mono>
                  </td>
                  <td className={td}>
                    <Mono className="text-t2">{s.email ?? '—'}</Mono>
                  </td>
                  <td className={td}>
                    <Mono className="text-t2">{s.phone ?? '—'}</Mono>
                  </td>
                  <td className={td}>
                    <span className="text-[12px] text-t3">{s.has_push ? 'yes' : '—'}</span>
                  </td>
                  <td className={td}>
                    <Mono className="text-t3">{timeAgo(s.created_at)}</Mono>
                  </td>
                  <td className={`${td} text-right`}>
                    <Button onClick={() => setLinkFor(s.external_id)}>Link</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title={search ? 'No matches' : 'No subscribers yet'}
          body={
            search
              ? 'No subscriber id or email matches that search.'
              : 'Subscribers are created automatically the first time you trigger a notification to them.'
          }
        />
      )}
    </>
  );
}
