import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Input, Mono, PageHeader, Skeleton, td, th } from '../ui';
import { timeAgo } from './Activity';

interface SubscriberRow {
  external_id: string;
  email: string | null;
  phone: string | null;
  has_push: boolean;
  created_at: string;
}

export default function SubscribersPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['subscribers', search],
    queryFn: () =>
      api<{ subscribers: SubscriberRow[] }>(
        `/v1/subscribers?limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      ),
  });

  return (
    <>
      <PageHeader
        title="Subscribers"
        action={
          <Input
            placeholder="Search by id or email…"
            className="w-64"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      />
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
                <th className={`${th} text-right`}>Added</th>
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
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(s.created_at)}</Mono>
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
