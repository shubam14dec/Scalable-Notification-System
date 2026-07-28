// Channels tab — per-agent channel connections, read-only. Connecting,
// re-pointing, and disconnecting all live on the Connections page. Same query
// key (['agent-channels', identifier]) and path as the former ChannelsModal.
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Mono, Skeleton, StatusBadge } from '../../ui';
import type { Agent, ChannelInfo } from './types';

export function ChannelsPanel({ agent }: { agent: Agent }) {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-channels', agent.identifier],
    queryFn: () => api<{ channels: ChannelInfo[] }>(`/v1/agents/${agent.identifier}/channels`),
  });

  return (
    <div>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : data && data.channels.length > 0 ? (
        <ul className="space-y-3">
          {data.channels.map((c) => {
            const identity =
              c.channel === 'telegram' ? `@${c.config.botUsername ?? '—'}` : c.config.address ?? '—';
            const webhookHealthy = c.webhook?.url && c.webhook.url === c.webhook.expectedUrl;
            return (
              <li
                key={c.channel}
                className="flex items-center justify-between gap-2 border-b border-bd pb-3 last:border-0 last:pb-0"
              >
                <span className="min-w-0">
                  <span className="text-[13px] text-t1 capitalize">{c.channel}</span>{' '}
                  <Mono className="break-all text-t2">{identity}</Mono>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={c.status} />
                  {c.channel === 'telegram' && (
                    <StatusBadge status={webhookHealthy ? 'active' : 'failed'} />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12px] text-t3">No channels connected to this agent yet.</p>
      )}
      <div className="mt-4 flex justify-end border-t border-bd pt-4">
        <Button variant="ghost" onClick={() => navigate('/connections')}>
          Manage on the Connections page →
        </Button>
      </div>
    </div>
  );
}
