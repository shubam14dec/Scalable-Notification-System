import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Blocks,
  KeyRound,
  LayoutGrid,
  LogOut,
  Moon,
  Sun,
  Users,
  Workflow,
} from 'lucide-react';
import { fetchMe, logout, session } from '../lib/api';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/subscribers', label: 'Subscribers', icon: Users },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/integrations', label: 'Integrations', icon: Blocks },
  { to: '/keys', label: 'API keys', icon: KeyRound },
];

/** Signature element: live queue backlog, 24 ticks, 5s poll. Quiet, mono. */
function QueuePulse() {
  const [ticks, setTicks] = useState<number[]>(Array(24).fill(0));
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch('/ops/queues');
        const depths = (await res.json()) as Record<string, Record<string, number>>;
        let backlog = 0;
        for (const [name, c] of Object.entries(depths)) {
          if (name === 'dead-letter') continue;
          backlog += (c.waiting ?? 0) + (c.active ?? 0);
        }
        if (alive) setTicks((prev) => [...prev.slice(1), backlog]);
      } catch {
        /* api offline — pulse just flatlines */
      }
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
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
  const currentEnv = environments?.find((e) => e.id === session.envId) ?? environments?.[0];

  useEffect(() => {
    if (currentEnv && session.envId !== currentEnv.id) session.setEnv(currentEnv.id);
  }, [currentEnv]);

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
          <span className="text-[14px] font-semibold tracking-tight">notify</span>
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
