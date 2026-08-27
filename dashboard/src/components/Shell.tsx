import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Bell,
  Blocks,
  Bot,
  Cable,
  KeyRound,
  LayoutGrid,
  LayoutTemplate,
  LogOut,
  MessagesSquare,
  Moon,
  ShieldCheck,
  Sun,
  Tag,
  Users,
  Workflow,
} from 'lucide-react';
import { fetchMe, logout, session } from '../lib/api';
import { useAdminEvents } from '../lib/adminEvents';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/subscribers', label: 'Subscribers', icon: Users },
  { to: '/topics', label: 'Topics', icon: Tag },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/connections', label: 'Connections', icon: Cable },
  { to: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/integrations', label: 'Integrations', icon: Blocks },
  { to: '/inbox-preview', label: 'Inbox preview', icon: Bell },
  { to: '/keys', label: 'API keys', icon: KeyRound },
];

/**
 * Signature element: live queue backlog, 24 ticks. Quiet, mono.
 *
 * Phase 25 D8: NO network poll. Reads the ['queues'] react-query cache, which
 * useAdminEvents feeds via `queue.depths` setQueryData (plus Overview's REST
 * seed when that page is open). A one-shot fetch runs ONLY if the cache is
 * empty on mount (staleTime Infinity + refetchInterval off), so the sparkline
 * isn't blank on non-Overview pages before the first pushed frame. After that,
 * QueuePulse makes zero network requests: it appends a tick when the cached
 * value CHANGES, and a 5s keep-alive timer carries the last-known value forward
 * by reading MEMORY (a ref), never the network — so the pulse keeps animating
 * on an idle system and reflects last-known depth in degraded mode (socket
 * down; Overview's 60s poll refreshes it when open).
 */
function QueuePulse() {
  const { data: queues } = useQuery({
    queryKey: ['queues'],
    queryFn: async () => {
      const res = await fetch('/ops/queues');
      return (await res.json()) as Record<string, Record<string, number>>;
    },
    refetchInterval: false,
    staleTime: Infinity, // fed by queue.depths pushes + Overview's seed; never auto-refetch
    refetchOnWindowFocus: false,
  });

  const backlog = queues
    ? Object.entries(queues)
        .filter(([name]) => name !== 'dead-letter')
        .reduce((sum, [, c]) => sum + (c.waiting ?? 0) + (c.active ?? 0), 0)
    : null;

  const [ticks, setTicks] = useState<number[]>(Array(24).fill(0));
  const backlogRef = useRef(0);

  // Append immediately whenever the pushed cache value changes.
  useEffect(() => {
    if (backlog === null) return;
    backlogRef.current = backlog;
    setTicks((prev) => [...prev.slice(1), backlog]);
  }, [backlog]);

  // Keep-alive on the original 5s grid, reading the ref (memory), never network.
  useEffect(() => {
    const t = setInterval(() => {
      setTicks((prev) => [...prev.slice(1), backlogRef.current]);
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const max = Math.max(...ticks, 1);
  const current = ticks[ticks.length - 1];
  return (
    <div className="px-3 py-2" title="Live queue backlog (waiting + active jobs)">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] text-t3">queue backlog</span>
        <span className="font-mono text-[11px] text-t2">{current}</span>
      </div>
      <div className="flex h-6 items-end gap-[2px]" aria-hidden>
        {ticks.map((v, i) => (
          <div
            key={i}
            className="w-full rounded-[1px] bg-t3 transition-all duration-150"
            style={{ height: `${Math.max(8, (v / max) * 100)}%`, opacity: v === 0 ? 0.25 : 0.7 }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * D9 live-status affordance. Design-system rule: color is delivery-status only,
 * so this uses filled-vs-hollow (the MemoryModal SourceTag precedent), never a
 * status color. Filled = live push; hollow + pulse = reconnecting (the per-page
 * 60s safety poll keeps the UI fresh meanwhile).
 */
function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span
      className="flex h-7 w-7 items-center justify-center"
      title={connected ? 'live updates connected' : 'reconnecting — periodic refresh active'}
    >
      <span
        aria-hidden
        className={`inline-block h-[7px] w-[7px] rounded-full ${
          connected ? 'bg-t3' : 'animate-pulse border border-bd-strong'
        }`}
      />
      <span className="sr-only">
        {connected ? 'Live updates connected' : 'Reconnecting — periodic refresh active'}
      </span>
    </span>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(document.documentElement.dataset.theme !== 'light');
  return (
    <button
      className="flex h-7 w-7 items-center justify-center rounded-md text-t3 transition-colors hover:bg-elevated hover:text-t1"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.dataset.theme = next ? 'dark' : 'light';
        localStorage.setItem('nk_theme', next ? 'dark' : 'light');
      }}
    >
      {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </button>
  );
}

function subscribeToEnv(onChange: () => void) {
  window.addEventListener('asyncify:env-changed', onChange);
  return () => window.removeEventListener('asyncify:env-changed', onChange);
}

export default function Shell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false });

  useEffect(() => {
    if (!session.authed) navigate('/login');
  }, [navigate]);

  const environments = me?.organizations.flatMap((o) =>
    o.environments.map((e) => ({ ...e, orgName: o.name })),
  );
  // The selected env lives in localStorage, which React cannot see — subscribe
  // to setEnv's event so the switcher re-renders on EVERY change, including
  // ones made elsewhere (a promote's "switch and open it"). Without this the
  // controlled <select> silently snaps back to its stale value.
  const envId = useSyncExternalStore(subscribeToEnv, () => session.envId);
  const currentEnv = environments?.find((e) => e.id === envId) ?? environments?.[0];

  useEffect(() => {
    if (currentEnv && session.envId !== currentEnv.id) session.setEnv(currentEnv.id);
  }, [currentEnv]);

  // One admin socket for the whole authed app; re-opens when the env switches.
  const { connected: liveConnected } = useAdminEvents(currentEnv?.id);

  return (
    <div className="flex h-full">
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-bd bg-surface">
        {/* Brand: the only place the accent lives besides active nav */}
        <div className="flex items-center gap-2 px-4 pb-2 pt-4">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: 'var(--accent)' }}
          />
          <span className="text-[14px] font-semibold tracking-tight">asyncify</span>
        </div>

        <div className="px-3 pb-3 pt-1">
          <select
            aria-label="Environment"
            className="h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[12px] text-t1 hover:border-bd-strong"
            value={currentEnv?.id ?? ''}
            onChange={(e) => {
              session.setEnv(e.target.value);
              void queryClient.invalidateQueries();
            }}
          >
            {environments?.map((e) => (
              <option key={e.id} value={e.id} className="bg-surface text-t1">
                {e.orgName} — {e.name}
              </option>
            ))}
          </select>
        </div>

        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-150 ${
                  isActive ? 'bg-elevated text-t1' : 'text-t2 hover:bg-elevated hover:text-t1'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute left-0 h-4 w-[2px] rounded-full"
                      style={{ background: 'var(--accent)' }}
                    />
                  )}
                  <Icon className="h-4 w-4" strokeWidth={1.5} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-bd">
          <QueuePulse />
          <div className="flex items-center justify-between border-t border-bd px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-[12px] font-medium text-t1">{me?.user.name ?? '—'}</p>
              <p className="truncate text-[11px] text-t3">{me?.user.email}</p>
            </div>
            <div className="flex items-center gap-0.5">
              <LiveDot connected={liveConnected} />
              <ThemeToggle />
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-t3 transition-colors hover:bg-elevated hover:text-t1"
                aria-label="Log out"
                onClick={logout}
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1080px] px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
