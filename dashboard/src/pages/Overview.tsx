import { useQuery } from '@tanstack/react-query';
import { api, fetchMe } from '../lib/api';
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

/**
 * Every card above the activity feed answers a question about THIS environment.
 *
 * It did not use to: "Queue backlog" and "Dead-lettered" read /ops/queues — the
 * platform's shared BullMQ gauges — so every tenant saw the same numbers, most
 * memorably a constant 182 dead-lettered jobs left over from someone else's
 * traffic (user-found, 2026-09-13). They are replaced by counts of the tenant's
 * own message rows (GET /v1/ops/tenant-stats), and the platform gauges moved
 * into an operator-only row below, where they are labelled as what they are.
 */
export default function OverviewPage() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false });
  const isOperator = Boolean(me?.operator);

  const { data: activity } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api<{ activity: ActivityRow[] }>('/v1/activity?limit=100'),
    // Phase 25 D8: live via admin socket (conversation/message hints); this is
    // the degraded-mode safety poll for when the socket is down.
    refetchInterval: 60_000,
  });

  // Tenant truth, and the only stats query every account runs. No live hint
  // carries these counts, so the 60s poll is the whole refresh story — plus
  // ['message.changed'] invalidations, which land on ['activity'], not here;
  // a card that is at most a minute stale is the right trade for not adding
  // a per-status-change push.
  const { data: stats } = useQuery({
    queryKey: ['tenant-stats'],
    queryFn: () => api<{ inFlight: number; failed: number }>('/v1/ops/tenant-stats'),
    refetchInterval: 60_000,
  });

  // PLATFORM gauges — operator seat only, and `enabled` is what keeps a
  // non-operator from ever issuing the request (it would be a 403, and the
  // ['queues'] invalidation on a queue.deadletter hint would retry it).
  const { data: queues } = useQuery({
    queryKey: ['queues'],
    queryFn: () => api<Record<string, Record<string, number>>>('/ops/queues'),
    enabled: isOperator,
    // Phase 25 D8: depths are pushed live (queue.depths → setQueryData on this
    // same key, operator sockets only); 60s is the safety poll.
    refetchInterval: 60_000,
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
          label="In flight"
          value={stats ? String(stats.inFlight) : '—'}
          sub="queued or sending right now"
        />
        <Stat
          label="Failed deliveries"
          value={stats ? String(stats.failed) : '—'}
          sub="never reached the recipient, all time"
        />
      </div>

      {isOperator && (
        <div className="mb-6">
          <h2 className="mb-1 text-[15px] font-semibold text-t1">Platform (operator view)</h2>
          <p className="mb-3 text-[12px] text-t3">
            The whole deployment, every tenant together — not this environment.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
        </div>
      )}

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
