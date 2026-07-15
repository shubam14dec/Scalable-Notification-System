import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import {
  Button,
  Card,
  EmptyState,
  Input,
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
