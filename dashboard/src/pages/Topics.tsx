import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import {
  Button,
  Card,
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
import { SendTestModal } from '../components/SendTest';
import { timeAgo } from './Activity';

interface Topic {
  id: string;
  key: string;
  name: string;
  member_count: number;
  created_at: string;
}

export default function TopicsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['topics'],
    queryFn: () => api<{ topics: Topic[] }>('/v1/topics'),
  });

  const create = useMutation({
    mutationFn: (body: { key: string; name: string }) =>
      api('/v1/topics', { method: 'PUT', body }),
    onSuccess: (_res, body) => {
      setCreateOpen(false);
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
      navigate(`/topics/${body.key}`);
    },
    onError: (err) => setError(err.message),
  });

  return (
    <>
      <PageHeader
        title="Topics"
        action={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            New topic
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.topics.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Key</th>
                <th className={th}>Name</th>
                <th className={`${th} text-right`}>Members</th>
                <th className={`${th} text-right`}>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.topics.map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer transition-colors hover:bg-elevated"
                  onClick={() => navigate(`/topics/${t.key}`)}
                >
                  <td className={td}>
                    <Mono>{t.key}</Mono>
                  </td>
                  <td className={td}>{t.name}</td>
                  <td className={`${td} text-right`}>
                    <Mono>{t.member_count}</Mono>
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(t.created_at)}</Mono>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No topics yet"
          body='Topics are named subscriber groups — "beta-users", "org:acme" — that you can trigger workflows at without listing recipients.'
        />
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New topic">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            create.mutate({
              key: String(form.get('key')),
              name: String(form.get('name')),
            });
          }}
        >
          <Field label="Key" hint="Used in trigger calls, e.g. to: [{ topic: 'beta-users' }]">
            <Input name="key" required autoFocus placeholder="beta-users" className="font-mono" />
          </Field>
          <Field label="Name">
            <Input name="name" required placeholder="Beta users" />
          </Field>
          {error && <p className="text-[12px] text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create topic'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

interface Member {
  external_id: string;
  email: string | null;
  phone: string | null;
  added_at: string;
}

export function TopicDetailPage() {
  const { key } = useParams();
  const queryClient = useQueryClient();
  const [workflowKey, setWorkflowKey] = useState('');
  const [sendOpen, setSendOpen] = useState(false);

  const { data: members, isLoading } = useQuery({
    queryKey: ['topic-members', key],
    queryFn: () => api<{ members: Member[] }>(`/v1/topics/${key}/subscribers`),
  });

  const { data: workflows } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api<{ workflows: Array<{ key: string }> }>('/v1/workflows'),
  });

  const mutate = (method: 'POST' | 'DELETE') =>
    useMutation({
      mutationFn: (subscriberIds: string[]) =>
        api(`/v1/topics/${key}/subscribers`, { method, body: { subscriberIds } }),
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['topic-members', key] });
        void queryClient.invalidateQueries({ queryKey: ['topics'] });
      },
    });
  const add = mutate('POST');
  const remove = mutate('DELETE');

  return (
    <>
      <Link to="/topics" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-t3 hover:text-t1">
        <ArrowLeft className="h-3.5 w-3.5" /> Topics
      </Link>
      <PageHeader
        title={key ?? ''}
        action={
          <div className="flex items-center gap-2">
            <select
              aria-label="Workflow to send"
              className="h-8 rounded-md border border-bd bg-transparent px-2 text-[12px] text-t1"
              value={workflowKey}
              onChange={(e) => setWorkflowKey(e.target.value)}
            >
              <option value="" className="bg-surface">
                choose workflow…
              </option>
              {workflows?.workflows.map((w) => (
                <option key={w.key} value={w.key} className="bg-surface">
                  {w.key}
                </option>
              ))}
            </select>
            <Button variant="primary" disabled={!workflowKey} onClick={() => setSendOpen(true)}>
              Send to topic
            </Button>
          </div>
        }
      />

      <Card className="mb-5 max-w-xl p-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const ids = String(form.get('ids') ?? '')
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            if (ids.length > 0) add.mutate(ids);
            e.currentTarget.reset();
          }}
        >
          <div className="flex-1">
            <Field label="Add members" hint="Subscriber IDs, comma or space separated">
              <Input name="ids" placeholder="user-1, user-2, user-3" className="font-mono" />
            </Field>
          </div>
          <Button variant="primary" type="submit" disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
        </form>
      </Card>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : members && members.members.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Subscriber</th>
                <th className={th}>Email</th>
                <th className={`${th} text-right`}>Added</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {members.members.map((m) => (
                <tr key={m.external_id} className="transition-colors hover:bg-elevated">
                  <td className={td}>
                    <Mono>{m.external_id}</Mono>
                  </td>
                  <td className={td}>
                    <Mono className="text-t2">{m.email ?? '—'}</Mono>
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(m.added_at)}</Mono>
                  </td>
                  <td className={`${td} text-right`}>
                    <Button variant="ghost" onClick={() => remove.mutate([m.external_id])}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No members yet"
          body="Add subscriber IDs above — unknown IDs are created automatically and filled in when they first receive a notification."
        />
      )}

      {sendOpen && key && workflowKey && (
        <SendTestModal workflowKey={workflowKey} topic={key} onClose={() => setSendOpen(false)} />
      )}
    </>
  );
}
