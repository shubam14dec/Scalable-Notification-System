import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Mono, PageHeader, Skeleton, StatusBadge, td, th } from '../ui';

export interface ActivityRow {
  id: string;
  transaction_id: string;
  channel: string;
  status: string;
  priority: string;
  provider: string | null;
  error: string | null;
  created_at: string;
  subscriber_id: string;
  workflow_key: string;
}

export function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const TRIGGER_SNIPPET = `curl -X POST https://your-api/v1/events/trigger \\
  -H "x-api-key: <your key>" -H "content-type: application/json" \\
  -d '{"workflowKey":"welcome","to":[{"subscriberId":"u1","email":"u1@example.com"}],"payload":{"name":"Ada"}}'`;

export function ActivityTable({ rows }: { rows: ActivityRow[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={th}>Status</th>
            <th className={th}>Channel</th>
            <th className={th}>Workflow</th>
            <th className={th}>Subscriber</th>
            <th className={th}>Provider</th>
            <th className={th}>Transaction</th>
            <th className={`${th} text-right`}>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="transition-colors hover:bg-elevated">
              <td className={td}>
                <StatusBadge status={r.status} />
                {r.error && (
                  <span className="ml-2 text-[11px] text-t3" title={r.error}>
                    {r.error.slice(0, 40)}
                    {r.error.length > 40 ? '…' : ''}
                  </span>
                )}
              </td>
              <td className={td}>
                <span className="text-t2">{r.channel}</span>
                <Mono className="ml-1.5 text-t3">{r.priority}</Mono>
              </td>
              <td className={td}>{r.workflow_key}</td>
              <td className={td}>
                <Mono className="text-t2">{r.subscriber_id}</Mono>
              </td>
              <td className={td}>
                <Mono className="text-t3">{r.provider ?? '—'}</Mono>
              </td>
              <td className={td}>
                <Mono className="text-t3">{r.transaction_id.slice(0, 18)}</Mono>
              </td>
              <td className={`${td} text-right`}>
                <Mono className="text-t3">{timeAgo(r.created_at)}</Mono>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function ActivityPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api<{ activity: ActivityRow[] }>('/v1/activity?limit=100'),
    refetchInterval: 10_000,
  });

  return (
    <>
      <PageHeader title="Activity" />
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : data && data.activity.length > 0 ? (
        <ActivityTable rows={data.activity} />
      ) : (
        <EmptyState
          title="No messages yet"
          body="Trigger your first workflow and every delivery attempt will show up here, live."
          snippet={TRIGGER_SNIPPET}
        />
      )}
    </>
  );
}
