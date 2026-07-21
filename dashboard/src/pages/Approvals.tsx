import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
// Dogfooding: the same QR component customers get from the published package.
import { QrCode } from '../../../packages/react/src';
import {
  Button,
  Card,
  CopyField,
  EmptyState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Skeleton,
  StatusBadge,
} from '../ui';
import { timeAgo } from './Activity';

/** A tool call paused for a human decision — Phase 18 Approvals contract. */
interface Approval {
  id: string;
  agentIdentifier: string;
  toolName: string;
  args: unknown;
  conversationId: string;
  status: string;
  note: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  expiresAt: string | null;
  // Not in the frozen field list, but the History tab shows it when present.
  result?: unknown;
}

const PRE_CLS =
  'overflow-x-auto rounded-md border border-bd bg-elevated p-3 font-mono text-[12px] leading-relaxed text-t2';

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Short "expires in Nm" / "expired" hint from an ISO timestamp. */
function expiresHint(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `expires in ${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `expires in ${hrs}h`;
  return `expires in ${Math.floor(hrs / 24)}d`;
}

/** Collapsible args block — collapsed by default when the JSON is long. */
function ArgsBlock({ value }: { value: unknown }) {
  const text = prettyJson(value);
  const long = text.length > 200;
  const [expanded, setExpanded] = useState(false);
  const collapsed = long && !expanded;
  return (
    <div>
      <pre className={`${PRE_CLS} ${collapsed ? 'max-h-24 overflow-hidden' : ''}`}>{text}</pre>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-t3 transition-colors hover:text-t1"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** 'failed' lives in the shared status vocabulary; the rest render locally. */
const DECISION_COLORS: Record<string, string> = {
  executed: 'var(--ok)',
  denied: 'var(--t3)',
  expired: 'var(--warn)',
};

function DecisionBadge({ status }: { status: string }) {
  if (status === 'failed') return <StatusBadge status="failed" />;
  const color = DECISION_COLORS[status] ?? 'var(--t3)';
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-t2">
      <span
        aria-hidden
        className="inline-block h-[7px] w-[7px] rounded-full"
        style={{ background: color }}
      />
      {status}
    </span>
  );
}

function PendingCard({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');

  const decide = useMutation({
    mutationFn: (v: { decision: 'approve' | 'deny'; note?: string }) =>
      api<{ id: string; status: string }>(`/v1/approvals/${approval.id}/decision`, {
        method: 'POST',
        body: v,
      }),
    onSuccess: () => onDecided(),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        onDecided();
      } else {
        setError(err.message);
      }
    },
  });

  const hint = expiresHint(approval.expiresAt);

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Mono className="text-t1">{approval.toolName}</Mono>
          <span className="ml-2 text-[12px] text-t3">{approval.agentIdentifier}</span>
        </div>
        <div className="shrink-0 text-right">
          <Mono className="block text-t3">{timeAgo(approval.requestedAt)}</Mono>
          {hint && <span className="mt-0.5 block text-[11px] text-t3">{hint}</span>}
        </div>
      </div>

      {/* Guard-tripped pendings carry context for the approver (the ⚠ repeat-
          action history line) in `note` — the same text the channel cards show. */}
      {approval.status === 'pending' && approval.note && (
        <p className="mt-3 text-[12px] text-t2">
          <Mono>{approval.note}</Mono>
        </p>
      )}

      <div className="mt-3">
        <ArgsBlock value={approval.args} />
      </div>

      {conflict ? (
        <p className="mt-3 text-[12px] text-t3">Already decided elsewhere.</p>
      ) : (
        <>
          {error && <p className="mt-3 text-[12px] text-err">{error}</p>}
          {denying && (
            <div className="mt-3">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                autoFocus
                placeholder="Reason for denial (optional)"
                aria-label="Denial note"
              />
              <div className="mt-1 text-right">
                <Mono className="text-t3">{note.length}/500</Mono>
              </div>
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            {denying ? (
              <>
                <Button type="button" onClick={() => setDenying(false)} disabled={decide.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ decision: 'deny', note: note.trim() || undefined })}
                >
                  Confirm deny
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={decide.isPending}
                  onClick={() => setDenying(true)}
                >
                  Deny
                </Button>
                <Button
                  variant="primary"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ decision: 'approve' })}
                >
                  Approve
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function HistoryCard({ approval }: { approval: Approval }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Mono className="text-t1">{approval.toolName}</Mono>
          <span className="ml-2 text-[12px] text-t3">{approval.agentIdentifier}</span>
        </div>
        <DecisionBadge status={approval.status} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-t3">
        {approval.decidedAt && <span>{timeAgo(approval.decidedAt)}</span>}
        {approval.decidedBy && (
          <span>
            by <span className="text-t2">{approval.decidedBy}</span>
          </span>
        )}
      </div>

      {approval.note && <p className="mt-2 text-[12px] text-t2">{approval.note}</p>}

      {approval.result !== undefined && approval.result !== null && (
        <pre className={`${PRE_CLS} mt-3 max-h-32 overflow-auto`}>{prettyJson(approval.result)}</pre>
      )}
    </Card>
  );
}

/** Minimal shape of a /v1/connections row — see Connections.tsx for the full one. */
interface ApprovalConn {
  id: string;
  channel: 'telegram' | 'email' | 'slack';
  status: 'active' | 'disabled' | 'pending';
  config: { teamName?: string; teamId?: string; botUsername?: string };
  agent: { identifier: string };
}

interface ApprovalSettings {
  settings: {
    slackConnectionId: string | null;
    slackChannelId: string | null;
    telegramConnectionId: string | null;
  };
  telegramApproverCount: number;
}

const SELECT_CLS =
  'h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[13px] text-t1 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong';

function slackLabel(c: ApprovalConn): string {
  return `${c.config.teamName ?? c.config.teamId ?? '—'} — ${c.agent.identifier}`;
}

/** Trim a Slack channel id down to a tidy inline chip: #C0123456… */
function channelChip(id: string): string {
  return `#${id.length > 10 ? `${id.slice(0, 10)}…` : id}`;
}

/**
 * Pull the bot username and start token out of a t.me deep link
 * (https://t.me/<bot>?start=<token>) — mirrors the widget's parser in
 * packages/react (not exported from there). Anything else returns null.
 */
function parseTelegramLink(url: string): { bot: string; token: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 't.me' && u.hostname !== 'telegram.me') return null;
    const bot = u.pathname.replace(/^\//, '');
    const token = u.searchParams.get('start');
    if (!bot || bot.includes('/') || !token) return null;
    return { bot, token };
  } catch {
    return null;
  }
}

/**
 * A freshly minted approver deep link: QR for phones (light tile, like
 * Connections.tsx, so it stays scannable in dark theme) plus the manual
 * /start command for networks that block t.me.
 */
function AddApproverModal({ url, onClose }: { url: string; onClose: () => void }) {
  const parsed = parseTelegramLink(url);
  return (
    <Modal open onClose={onClose} title="Add an approver">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div
            className="shrink-0 rounded-md border border-bd p-2"
            style={{ background: '#ffffff', color: '#000000', lineHeight: 0 }}
          >
            <QrCode value={url} size={132} />
          </div>
          <p className="text-[12px] text-t2">
            Ask the approver to scan or send this — the link is single-use and expires in 24h.
            Mint one per approver.
          </p>
        </div>
        <CopyField value={url} />
        {parsed && (
          <div>
            <p className="mb-1.5 text-[12px] text-t2">
              Can't open t.me? In Telegram, message <Mono>@{parsed.bot}</Mono> and send this.
            </p>
            <CopyField value={`/start ${parsed.token}`} />
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Phase 19 Slice D — where approval cards get routed. Collapsed by default,
 * showing a one-line status; expands to a Slack + Telegram settings form that
 * PUTs the three connection/channel fields (null clears each).
 */
function ChannelApprovals() {
  const [open, setOpen] = useState(false);
  const [slackConn, setSlackConn] = useState('');
  const [slackChan, setSlackChan] = useState('');
  const [tgConn, setTgConn] = useState('');
  const [error, setError] = useState('');
  const [approverLink, setApproverLink] = useState<string | null>(null);
  const [mintError, setMintError] = useState('');

  const settingsQuery = useQuery({
    queryKey: ['approval-settings'],
    queryFn: () => api<ApprovalSettings>('/v1/settings/approvals'),
  });
  const connQuery = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ connections: ApprovalConn[] }>('/v1/connections'),
  });

  const settings = settingsQuery.data?.settings;
  const approverCount = settingsQuery.data?.telegramApproverCount ?? 0;
  const conns = connQuery.data?.connections ?? [];
  const slackConns = conns.filter((c) => c.channel === 'slack' && c.status === 'active');
  const tgConns = conns.filter((c) => c.channel === 'telegram' && c.status === 'active');

  // Seed the draft from the saved settings each time the panel opens.
  const resetDraft = () => {
    setSlackConn(settings?.slackConnectionId ?? '');
    setSlackChan(settings?.slackChannelId ?? '');
    setTgConn(settings?.telegramConnectionId ?? '');
    setError('');
  };

  const toggle = () => {
    if (!open) resetDraft();
    setOpen((v) => !v);
  };

  const save = useMutation({
    mutationFn: () =>
      api('/v1/settings/approvals', {
        method: 'PUT',
        body: {
          slackConnectionId: slackConn || null,
          // A channel only makes sense with a connection; clearing one clears both.
          slackChannelId: slackConn ? slackChan.trim() || null : null,
          telegramConnectionId: tgConn || null,
        },
      }),
    onSuccess: () => {
      setError('');
      void settingsQuery.refetch();
      setOpen(false);
    },
    onError: (err) => setError(err.message),
  });

  // The connection approver links ride on is the SAVED one — a draft change
  // that hasn't been PUT yet would mint links against the wrong bot.
  const savedTgConn = settings?.telegramConnectionId ?? null;

  // POST link-tokens upserts the subscriber itself (see mintLinkTokenCore in
  // src/api/routes/identities.ts), so this one call both ensures the
  // 'approvals' subscriber exists and mints the single-use t.me deep link.
  const mintApprover = useMutation({
    mutationFn: () =>
      api<{ deepLink: string }>(
        `/v1/connections/${encodeURIComponent(savedTgConn!)}/link-tokens`,
        { method: 'POST', body: { subscriberId: 'approvals' } },
      ),
    onSuccess: (res) => {
      setMintError('');
      setApproverLink(res.deepLink);
    },
    onError: (err) => setMintError(err.message),
  });

  const summary = (() => {
    if (!settings) return 'Not configured — approvals are dashboard-only';
    const parts: string[] = [];
    if (settings.slackConnectionId) {
      const conn = conns.find((c) => c.id === settings.slackConnectionId);
      const via = conn ? ` via ${conn.agent.identifier}` : '';
      const chan = settings.slackChannelId ? channelChip(settings.slackChannelId) : 'no channel';
      parts.push(`Slack: ${chan}${via}`);
    }
    if (settings.telegramConnectionId) {
      parts.push(`Telegram: ${approverCount} approver${approverCount === 1 ? '' : 's'}`);
    }
    return parts.length ? parts.join(' · ') : 'Not configured — approvals are dashboard-only';
  })();

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <Card className="mb-5">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <span className="text-[13px] font-medium text-t1">Channel approvals</span>
          {open ? (
            <span className="mt-0.5 block text-[12px] text-t3">
              Route approval cards to a Slack channel and Telegram approvers.
            </span>
          ) : settingsQuery.isLoading ? (
            <Skeleton className="mt-1 h-3 w-64" />
          ) : (
            <span className="mt-0.5 block truncate text-[12px] text-t3">{summary}</span>
          )}
        </div>
        <Chevron className="h-4 w-4 shrink-0 text-t3" aria-hidden />
      </button>

      {open && (
        <div className="space-y-6 border-t border-bd px-4 py-4">
          {/* Slack */}
          <div className="space-y-3">
            <span className="block text-[12px] font-medium text-t2">Slack</span>
            <Field label="Connection">
              <select
                aria-label="Slack connection"
                className={SELECT_CLS}
                value={slackConn}
                onChange={(e) => {
                  const v = e.target.value;
                  setSlackConn(v);
                  if (!v) setSlackChan('');
                }}
              >
                <option value="" className="bg-surface">
                  None
                </option>
                {slackConn && !slackConns.some((c) => c.id === slackConn) && (
                  <option value={slackConn} className="bg-surface">
                    {slackConn} (inactive)
                  </option>
                )}
                {slackConns.map((c) => (
                  <option key={c.id} value={c.id} className="bg-surface">
                    {slackLabel(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Channel ID"
              hint="the channel's ID (channel details → about) — /invite the bot there first"
            >
              <Input
                value={slackChan}
                onChange={(e) => setSlackChan(e.target.value)}
                disabled={!slackConn}
                placeholder="C0123456789"
                className="font-mono disabled:opacity-50"
                aria-label="Slack channel ID"
              />
            </Field>
          </div>

          {/* Telegram */}
          <div className="space-y-3">
            <span className="block text-[12px] font-medium text-t2">Telegram</span>
            <Field label="Connection">
              <select
                aria-label="Telegram connection"
                className={SELECT_CLS}
                value={tgConn}
                onChange={(e) => setTgConn(e.target.value)}
              >
                <option value="" className="bg-surface">
                  None
                </option>
                {tgConn && !tgConns.some((c) => c.id === tgConn) && (
                  <option value={tgConn} className="bg-surface">
                    {tgConn} (inactive)
                  </option>
                )}
                {tgConns.map((c) => (
                  <option key={c.id} value={c.id} className="bg-surface">
                    @{c.config.botUsername ?? '—'}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <span className="text-[12px] text-t2">
                Approvers: {approverCount} linked telegram{' '}
                {approverCount === 1 ? 'identity' : 'identities'} on the{' '}
                <Mono className="text-t2">approvals</Mono> subscriber
              </span>
              {approverCount === 0 && (
                <span className="mt-1 block text-[11px] text-t3">
                  link telegram identities to a subscriber with ID{' '}
                  <Mono className="text-t3">approvals</Mono> — each gets the approval card; they must{' '}
                  <Mono className="text-t3">/start</Mono> the bot
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                disabled={!savedTgConn || mintApprover.isPending}
                onClick={() => mintApprover.mutate()}
              >
                {mintApprover.isPending ? 'Generating…' : 'Add approver'}
              </Button>
              {!savedTgConn && (
                <span className="text-[11px] text-t3">
                  choose a telegram connection and save first
                </span>
              )}
            </div>
            {mintError && <p className="text-[12px] text-err">{mintError}</p>}
          </div>

          {error && <p className="text-[12px] text-err">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}

      {approverLink && (
        <AddApproverModal
          url={approverLink}
          onClose={() => {
            setApproverLink(null);
            // The approver may have just scanned + /start'ed — pick up the count.
            void settingsQuery.refetch();
          }}
        />
      )}
    </Card>
  );
}

export default function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const apiStatus = tab === 'pending' ? 'pending' : 'decided';

  const { data, isLoading } = useQuery({
    queryKey: ['approvals', apiStatus],
    queryFn: () => api<{ approvals: Approval[] }>(`/v1/approvals?status=${apiStatus}`),
    refetchInterval: tab === 'pending' ? 10_000 : false,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['approvals'] });

  const tabCls = (active: boolean) =>
    `h-7 rounded px-3 text-[12px] font-medium transition-colors duration-150 ${
      active ? 'bg-elevated text-t1' : 'text-t2 hover:text-t1'
    }`;

  const approvals = data?.approvals ?? [];

  return (
    <>
      <PageHeader title="Approvals" />
      <p className="-mt-4 mb-5 max-w-2xl text-[12px] text-t3">
        Tools you marked "require approval" pause here before they run. Approve to let the call
        through, or deny to block it and tell the agent why.
      </p>

      <ChannelApprovals />

      <div className="mb-5 inline-flex rounded-md border border-bd p-0.5">
        <button className={tabCls(tab === 'pending')} onClick={() => setTab('pending')}>
          Pending
        </button>
        <button className={tabCls(tab === 'history')} onClick={() => setTab('history')}>
          History
        </button>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : approvals.length === 0 ? (
        tab === 'pending' ? (
          <EmptyState
            title="No approvals waiting"
            body="Tools marked 'require approval' pause here before running."
          />
        ) : (
          <EmptyState
            title="No decisions yet"
            body="Approved, denied, and expired tool calls will show up here once you've acted on them."
          />
        )
      ) : (
        <div className="space-y-3">
          {approvals.map((a) =>
            tab === 'pending' ? (
              <PendingCard key={a.id} approval={a} onDecided={invalidate} />
            ) : (
              <HistoryCard key={a.id} approval={a} />
            ),
          )}
        </div>
      )}
    </>
  );
}
