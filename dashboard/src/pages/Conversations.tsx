import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import {
  Button,
  Card,
  EmptyState,
  Mono,
  PageHeader,
  Skeleton,
  StatusBadge,
  td,
  th,
} from '../ui';
import { timeAgo } from './Activity';

interface ConversationRow {
  id: string;
  agent: { identifier: string; name: string };
  subscriberId: string;
  channel: string;
  status: 'active' | 'resolved';
  messageCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string;
}

interface TranscriptMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  createdAt: string;
}

export default function ConversationsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const agent = params.get('agent') ?? '';
  const status = params.get('status') ?? '';

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Array<{ identifier: string }> }>('/v1/agents'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['conversations', agent, status],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (agent) qs.set('agent', agent);
      if (status) qs.set('status', status);
      const suffix = qs.toString();
      return api<{ conversations: ConversationRow[] }>(`/v1/conversations${suffix ? `?${suffix}` : ''}`);
    },
    refetchInterval: 10_000,
  });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const selectCls = 'h-8 rounded-md border border-bd bg-transparent px-2 text-[12px] text-t1 hover:border-bd-strong';

  return (
    <>
      <PageHeader
        title="Conversations"
        action={
          <div className="flex items-center gap-2">
            <select aria-label="Filter by agent" className={selectCls} value={agent} onChange={(e) => setFilter('agent', e.target.value)}>
              <option value="" className="bg-surface">all agents</option>
              {agents?.agents.map((a) => (
                <option key={a.identifier} value={a.identifier} className="bg-surface">
                  {a.identifier}
                </option>
              ))}
            </select>
            <select aria-label="Filter by status" className={selectCls} value={status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="" className="bg-surface">any status</option>
              <option value="active" className="bg-surface">active</option>
              <option value="resolved" className="bg-surface">resolved</option>
            </select>
          </div>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.conversations.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Subscriber</th>
                <th className={th}>Agent</th>
                <th className={th}>Last message</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Turns</th>
                <th className={`${th} text-right`}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.conversations.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer transition-colors hover:bg-elevated"
                  onClick={() => navigate(`/conversations/${c.id}`)}
                >
                  <td className={td}>
                    <Mono>{c.subscriberId}</Mono>
                  </td>
                  <td className={td}>
                    <Mono className="text-t2">{c.agent.identifier}</Mono>
                  </td>
                  <td className={`${td} max-w-[320px]`}>
                    <span className="block truncate text-[12px] text-t2">{c.lastMessagePreview ?? '—'}</span>
                  </td>
                  <td className={td}>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono>{c.messageCount}</Mono>
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(c.lastMessageAt)}</Mono>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No conversations yet"
          body="When a subscriber messages one of your agents — from the in-app widget or the API — the whole exchange shows up here."
        />
      )}
    </>
  );
}

export function ConversationDetailPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['conversation', id],
    queryFn: () =>
      api<{
        conversation: {
          id: string;
          status: 'active' | 'resolved';
          metadata: Record<string, unknown>;
          summary: string | null;
          messageCount: number;
          createdAt: string;
        };
        messages: TranscriptMessage[];
      }>(`/v1/conversations/${id}`),
    refetchInterval: 5_000,
  });

  const resolve = useMutation({
    mutationFn: () => api(`/v1/conversations/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['conversation', id] }),
  });

  const metadataEntries = Object.entries(data?.conversation.metadata ?? {});

  return (
    <>
      <Link to="/conversations" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-t3 hover:text-t1">
        <ArrowLeft className="h-3.5 w-3.5" /> Conversations
      </Link>
      <PageHeader
        title="Conversation"
        action={
          data?.conversation.status === 'active' ? (
            <Button onClick={() => resolve.mutate()} disabled={resolve.isPending}>
              {resolve.isPending ? 'Resolving…' : 'Mark resolved'}
            </Button>
          ) : undefined
        }
      />

      {isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="flex flex-col gap-5 lg:flex-row">
          {/* Transcript — the story, oldest first */}
          <Card className="min-w-0 flex-1 p-4">
            {data.messages.map((m) =>
              m.role === 'system' ? (
                <p key={m.id} className="my-2 text-center text-[11px] text-t3">
                  {m.content} · {timeAgo(m.createdAt)}
                </p>
              ) : (
                <div
                  key={m.id}
                  className={`mb-3 flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}
                >
                  <div className="max-w-[75%]">
                    <p className="mb-0.5 text-[11px] text-t3">
                      {m.role === 'user' ? 'subscriber' : 'agent'} · {timeAgo(m.createdAt)}
                    </p>
                    <div
                      className={`whitespace-pre-wrap break-words rounded-lg border border-bd px-3 py-2 text-[13px] leading-relaxed text-t1 ${
                        m.role === 'agent' ? 'bg-elevated' : 'bg-transparent'
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                </div>
              ),
            )}
          </Card>

          {/* Facts panel */}
          <div className="w-full shrink-0 space-y-4 lg:w-[260px]">
            <Card className="p-4">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-t3">Details</p>
              <dl className="space-y-2 text-[12px]">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-t3">Status</dt>
                  <dd><StatusBadge status={data.conversation.status} /></dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-t3">Turns</dt>
                  <dd><Mono>{data.conversation.messageCount}</Mono></dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-t3">Started</dt>
                  <dd><Mono className="text-t2">{timeAgo(data.conversation.createdAt)}</Mono></dd>
                </div>
                {data.conversation.summary && (
                  <div>
                    <dt className="mb-1 text-t3">Summary</dt>
                    <dd className="text-t2">{data.conversation.summary}</dd>
                  </div>
                )}
              </dl>
            </Card>

            <Card className="p-4">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-t3">
                Metadata
              </p>
              {metadataEntries.length === 0 ? (
                <p className="text-[12px] text-t3">
                  Nothing yet — the agent sets these with <Mono>ctx.metadata.set()</Mono>.
                </p>
              ) : (
                <dl className="space-y-2 text-[12px]">
                  {metadataEntries.map(([key, value]) => (
                    <div key={key} className="flex items-start justify-between gap-2">
                      <dt><Mono className="text-t3">{key}</Mono></dt>
                      <dd className="min-w-0 text-right">
                        <Mono className="break-all text-t1">{JSON.stringify(value)}</Mono>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
