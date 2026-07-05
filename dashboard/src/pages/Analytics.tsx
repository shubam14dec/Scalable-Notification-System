import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, Mono, PageHeader, Skeleton, StatusBadge, td, th } from '../ui';

interface Summary {
  days: number;
  byStatus: Array<{ status: string; count: number }>;
  byChannel: Array<{ channel: string; status: string; count: number }>;
  byProvider: Array<{ provider: string; status: string; count: number }>;
  byDay: Array<{ day: string; count: number }>;
}

function rate(delivered: number, total: number): string {
  if (total === 0) return '—';
  return `${((delivered / total) * 100).toFixed(1)}%`;
}

export default function AnalyticsPage() {
  const { data } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => api<Summary>('/v1/analytics/summary?days=14'),
    refetchInterval: 30_000,
  });

  if (!data) return <Skeleton className="h-64 w-full" />;

  const count = (status: string) => data.byStatus.find((s) => s.status === status)?.count ?? 0;
  const total = data.byStatus.reduce((sum, s) => sum + s.count, 0);
  const good = count('sent') + count('delivered');
  const bad = count('failed') + count('bounced');
  const attempted = good + bad;

  const channels = [...new Set(data.byChannel.map((r) => r.channel))];
  const providers = [...new Set(data.byProvider.map((r) => r.provider))];
  const cell = (rows: Array<{ status: string; count: number }>, statuses: string[]) =>
    rows.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r.count, 0);

  return (
    <>
      <PageHeader title="Analytics" />
      <p className="-mt-4 mb-5 text-[12px] text-t3">Last {data.days} days</p>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-t3">Messages</p>
          <p className="mt-1 font-mono text-[22px] font-medium">{total.toLocaleString()}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-t3">Delivery rate</p>
          <p className="mt-1 font-mono text-[22px] font-medium">{rate(good, attempted)}</p>
          <p className="mt-0.5 text-[11px] text-t3">of attempted sends</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-t3">Failed</p>
          <p className="mt-1 font-mono text-[22px] font-medium">{bad.toLocaleString()}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-t3">Skipped</p>
          <p className="mt-1 font-mono text-[22px] font-medium">
            {(count('skipped') + count('merged')).toLocaleString()}
          </p>
          <p className="mt-0.5 text-[11px] text-t3">preferences, suppressions, digests</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-[15px] font-semibold">By channel</h2>
          <Card className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={th}>Channel</th>
                  <th className={`${th} text-right`}>Delivered</th>
                  <th className={`${th} text-right`}>Failed</th>
                  <th className={`${th} text-right`}>Skipped</th>
                  <th className={`${th} text-right`}>Rate</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => {
                  const rows = data.byChannel.filter((r) => r.channel === c);
                  const ok = cell(rows, ['sent', 'delivered']);
                  const err = cell(rows, ['failed', 'bounced']);
                  const skip = cell(rows, ['skipped', 'merged']);
                  return (
                    <tr key={c} className="transition-colors hover:bg-elevated">
                      <td className={td}>{c}</td>
                      <td className={`${td} text-right`}>
                        <Mono>{ok.toLocaleString()}</Mono>
                      </td>
                      <td className={`${td} text-right`}>
                        <Mono className={err > 0 ? 'text-err' : 'text-t3'}>{err.toLocaleString()}</Mono>
                      </td>
                      <td className={`${td} text-right`}>
                        <Mono className="text-t3">{skip.toLocaleString()}</Mono>
                      </td>
                      <td className={`${td} text-right`}>
                        <Mono>{rate(ok, ok + err)}</Mono>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </div>

        <div>
          <h2 className="mb-2 text-[15px] font-semibold">By provider</h2>
          <Card className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={th}>Provider</th>
                  <th className={`${th} text-right`}>Delivered</th>
                  <th className={`${th} text-right`}>Failed</th>
                  <th className={`${th} text-right`}>Rate</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => {
                  const rows = data.byProvider.filter((r) => r.provider === p);
                  const ok = cell(rows, ['sent', 'delivered']);
                  const err = cell(rows, ['failed', 'bounced']);
                  return (
                    <tr key={p} className="transition-colors hover:bg-elevated">
                      <td className={td}>
                        <Mono>{p}</Mono>
                      </td>
                      <td className={`${td} text-right`}>
                        <Mono>{ok.toLocaleString()}</Mono>
                      </td>
                      <td className={`${td} text-right`}>
                        <Mono className={err > 0 ? 'text-err' : 'text-t3'}>{err.toLocaleString()}</Mono>
                      </td>
                      <td className={`${td} text-right`}>
                        <Mono>{rate(ok, ok + err)}</Mono>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      <h2 className="mb-2 mt-6 text-[15px] font-semibold">Status breakdown</h2>
      <Card className="p-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {data.byStatus.map((s) => (
            <span key={s.status} className="inline-flex items-center gap-2">
              <StatusBadge status={s.status} />
              <Mono className="text-t2">{s.count.toLocaleString()}</Mono>
            </span>
          ))}
        </div>
      </Card>
    </>
  );
}
