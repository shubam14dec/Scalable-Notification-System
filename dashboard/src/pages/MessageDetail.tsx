import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import { Card, Mono, PageHeader, Skeleton, StatusBadge } from '../ui';

interface Timeline {
  event: {
    transactionId: string;
    workflowKey: string;
    priority: string;
    status: string;
    isBroadcast: boolean;
  };
  messages: Array<{
    id: string;
    channel: string;
    status: string;
    provider: string | null;
    providerMessageId: string | null;
    attempts: number;
    error: string | null;
  }>;
  logs: Array<{ level: string; detail: string; message_id: string | null; created_at: string }>;
}

const LEVEL_COLOR: Record<string, string> = {
  info: 'var(--t3)',
  warn: 'var(--warn)',
  error: 'var(--err)',
};

export default function MessageDetailPage() {
  const { transactionId } = useParams();
  const { data, isLoading } = useQuery({
    queryKey: ['timeline', transactionId],
    queryFn: () => api<Timeline>(`/v1/events/${transactionId}/timeline`),
    refetchInterval: 10_000,
  });

  if (isLoading || !data) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <>
      <Link to="/activity" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-t3 hover:text-t1">
        <ArrowLeft className="h-3.5 w-3.5" /> Activity
      </Link>
      <PageHeader title={data.event.workflowKey} />

      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-t2">
        <span>
          transaction <Mono className="text-t1">{data.event.transactionId}</Mono>
        </span>
        <span>
          priority <Mono className="text-t1">{data.event.priority}</Mono>
        </span>
        <StatusBadge status={data.event.status} />
        {data.event.isBroadcast && <span className="rounded border border-bd px-1.5 py-0.5 text-t2">broadcast</span>}
      </div>

      <h2 className="mb-2 text-[15px] font-semibold">Messages</h2>
      <div className="mb-6 grid gap-3 md:grid-cols-2">
        {data.messages.map((m) => (
          <Card key={m.id} className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-medium">{m.channel}</span>
              <StatusBadge status={m.status} />
            </div>
            <dl className="space-y-1 text-[12px]">
              <div className="flex justify-between">
                <dt className="text-t3">provider</dt>
                <dd>
                  <Mono className="text-t2">{m.provider ?? '—'}</Mono>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-t3">attempts</dt>
                <dd>
                  <Mono className="text-t2">{m.attempts}</Mono>
                </dd>
              </div>
              {m.providerMessageId && (
                <div className="flex justify-between gap-4">
                  <dt className="shrink-0 text-t3">provider id</dt>
                  <dd className="min-w-0">
                    <Mono className="block truncate text-t2">{m.providerMessageId}</Mono>
                  </dd>
                </div>
              )}
              {m.error && (
                <div className="pt-1">
                  <dd className="text-err">{m.error}</dd>
                </div>
              )}
            </dl>
          </Card>
        ))}
      </div>

      <h2 className="mb-2 text-[15px] font-semibold">Timeline</h2>
      <Card className="p-1">
        {data.logs.length === 0 ? (
          <p className="p-4 text-t3">No execution logs recorded for this notification.</p>
        ) : (
          <ol>
            {data.logs.map((log, i) => (
              <li key={i} className="flex items-baseline gap-3 border-t border-bd px-3 py-2 first:border-t-0">
                <span
                  aria-hidden
                  className="relative top-[-1px] h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: LEVEL_COLOR[log.level] ?? 'var(--t3)' }}
                />
                <Mono className="shrink-0 text-t3">
                  {new Date(log.created_at).toLocaleTimeString(undefined, { hour12: false })}
                </Mono>
                <span className="min-w-0 text-[12px] text-t1">{log.detail}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
