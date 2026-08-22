// Per-agent detail page (route /agents/:identifier, tabs via ?tab=). V1 top-tabs
// topology: breadcrumb, identity row with Disable + Delete on the right, health
// strip, underline tab bar, full-width panel content. Self-fetches by identifier
// from the unchanged ['agents'] list query (refresh-safe, live-invalidated), so
// no new endpoint or react-query key is introduced.
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Mono, Skeleton, StatusBadge } from '../ui';
import { ChannelsPanel } from './agent/ChannelsPanel';
import { EditTab } from './agent/EditPanel';
import { EvalsPanel } from './agent/EvalsPanel';
import { HealthStrip } from './agent/HealthStrip';
import { KnowledgePanel } from './agent/KnowledgePanel';
import { MemoryPanel } from './agent/MemoryPanel';
import { ToolsPanel } from './agent/ToolsPanel';
import { VersionsPanel } from './agent/VersionsPanel';
import type { Agent, AgentBody, ChannelInfo } from './agent/types';

type TabId = 'edit' | 'channels' | 'tools' | 'evals' | 'versions' | 'knowledge' | 'memory';

export default function AgentDetailPage() {
  const { identifier = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Self-fetch from the shared ['agents'] list — key unchanged, so live
  // invalidation on 'agents' keeps this page fresh and a refresh reloads it.
  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Agent[] }>('/v1/agents'),
  });
  const agent = data?.agents.find((a) => a.identifier === identifier) ?? null;

  // Channel count for the identity line (same key/path the Channels panel uses).
  const channelsQuery = useQuery({
    queryKey: ['agent-channels', identifier],
    queryFn: () => api<{ channels: ChannelInfo[] }>(`/v1/agents/${identifier}/channels`),
    enabled: Boolean(agent),
  });
  const channelCount = channelsQuery.data?.channels.length;

  // Disable/Enable + Delete live at the page level (Delete has no modal of its
  // own to show its error, so it surfaces in a dismissible banner as before).
  const update = useMutation({
    mutationFn: (body: Partial<AgentBody> & { identifier: string; status?: string }) => {
      const { identifier: id, ...rest } = body;
      return api(`/v1/agents/${id}`, { method: 'PATCH', body: rest });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/agents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate('/agents');
    },
  });

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (!agent) {
    return (
      <div className="py-16 text-center">
        <p className="text-[15px] font-medium text-t1">Agent not found</p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-t2">
          No agent with id <Mono className="text-t1">{identifier}</Mono> in this environment.
        </p>
        <Link
          to="/agents"
          className="mt-4 inline-block text-[13px] text-t2 underline-offset-2 hover:text-t1 hover:underline"
        >
          ← Back to Agents
        </Link>
      </div>
    );
  }

  const managed = agent.runtime === 'managed';
  const tabs: { id: TabId; label: string }[] = [
    { id: 'edit', label: 'Edit' },
    { id: 'channels', label: 'Channels' },
    ...(managed
      ? ([
          { id: 'tools', label: 'Tools' },
          { id: 'evals', label: 'Evals' },
          { id: 'versions', label: 'Versions' },
          { id: 'knowledge', label: 'Knowledge' },
          { id: 'memory', label: 'Memory' },
        ] as { id: TabId; label: string }[])
      : []),
  ];
  const requested = searchParams.get('tab') as TabId | null;
  const activeTab: TabId = tabs.some((t) => t.id === requested) ? requested! : 'edit';

  const deleteError =
    remove.error instanceof Error
      ? `Couldn't delete "${agent.identifier}" — ${remove.error.message}`
      : '';

  return (
    <div>
      {/* Breadcrumb */}
      <div className="mb-1.5 text-[12px] text-t3">
        <Link to="/agents" className="transition-colors hover:text-t1">
          Agents
        </Link>
        <span className="mx-1">/</span>
        <span className="text-t1">{agent.identifier}</span>
      </div>

      {/* Identity row */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[18px] font-semibold tracking-tight text-t1">{agent.name}</h1>
            <Mono className="text-t3">{agent.identifier}</Mono>
            <StatusBadge status={agent.status} />
          </div>
          <div className="mt-0.5 text-[12px] text-t3">
            {managed ? (
              <>
                managed · <Mono className="text-t2">{agent.model ?? 'claude-opus-4-8'}</Mono>
              </>
            ) : (
              'your code'
            )}
            {channelCount != null && (
              <> · {channelCount} {channelCount === 1 ? 'channel' : 'channels'}</>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => navigate(`/conversations?agent=${agent.identifier}`)}
          >
            Conversations
          </Button>
          <Button
            onClick={() =>
              update.mutate({
                identifier: agent.identifier,
                status: agent.status === 'active' ? 'disabled' : 'active',
              })
            }
          >
            {agent.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (
                window.confirm(`Delete agent "${agent.identifier}" and all its conversations?`)
              ) {
                remove.mutate(agent.identifier);
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      {deleteError && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-bd bg-elevated px-3 py-2">
          <span className="text-[12px] text-err">{deleteError}</span>
          <button
            className="shrink-0 text-[12px] text-t3 transition-colors hover:text-t1"
            onClick={() => remove.reset()}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Health strip */}
      <HealthStrip agent={agent} />

      {/* Tab bar */}
      <div className="mt-4 flex gap-6 border-b border-bd">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={activeTab === t.id}
            onClick={() => setSearchParams({ tab: t.id }, { replace: true })}
            className={`-mb-px border-b-2 px-0.5 pb-2.5 pt-1 text-[12.5px] transition-colors ${
              activeTab === t.id
                ? 'border-invert text-t1'
                : 'border-transparent text-t2 hover:text-t1'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="pt-5">
        {activeTab === 'edit' && <EditTab agent={agent} />}
        {activeTab === 'channels' && <ChannelsPanel agent={agent} />}
        {activeTab === 'tools' && managed && <ToolsPanel agent={agent} />}
        {activeTab === 'evals' && managed && <EvalsPanel agent={agent} />}
        {activeTab === 'versions' && managed && <VersionsPanel agent={agent} />}
        {activeTab === 'knowledge' && managed && <KnowledgePanel agent={agent} />}
        {activeTab === 'memory' && managed && <MemoryPanel agent={agent} />}
      </div>
    </div>
  );
}
