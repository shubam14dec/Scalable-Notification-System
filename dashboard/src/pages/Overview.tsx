import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, PageHeader, Skeleton } from '../ui';
import { ActivityTable, type ActivityRow } from './Activity';

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-t3">{label}</p>
      <p className="mt-1 font-mono text-[22px] font-medium text-t1">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-t3">{sub}</p>}
    </Card>
  );
}

export default function OverviewPage() {
  const { data: activity } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api<{ activity: ActivityRow[] }>('/v1/activity?limit=100'),
    refetchInterval: 10_000,
  });

  const { data: queues } = useQuery({
    queryKey: ['queues'],
    queryFn: async () => {
      const res = await fetch('/ops/queues');
      return (await res.json()) as Record<string, Record<string, number>>;
    },
    refetchInterval: 5_000,
  });

  const rows = activity?.activity ?? [];
  const sent = rows.filter((r) => ['sent', 'delivered'].includes(r.status)).length;
  const failed = rows.filter((r) => ['failed', 'bounced'].includes(r.status)).length;
  const backlog = queues
    ? Object.entries(queues)
        .filter(([name]) => name !== 'dead-letter')
        .reduce((sum, [, c]) => sum + (c.waiting ?? 0) + (c.active ?? 0), 0)
    : undefined;
  const dead = queues?.['dead-letter']?.waiting;

  return (
    <>
      <PageHeader title="Overview" />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Delivered"
          value={activity ? String(sent) : '—'}
          sub="last 100 messages"
        />
        <Stat label="Failed" value={activity ? String(failed) : '—'} sub="last 100 messages" />
        <Stat
          label="Queue backlog"
          value={backlog === undefined ? '—' : String(backlog)}
          sub="waiting + active, live"
        />
        <Stat
          label="Dead-lettered"
          value={dead === undefined ? '—' : String(dead)}
          sub="needs attention when > 0"
        />
      </div>

      <h2 className="mb-3 text-[15px] font-semibold text-t1">Recent activity</h2>
      {!activity ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <ActivityTable rows={rows.slice(0, 8)} />
      )}
    </>
  );
}
