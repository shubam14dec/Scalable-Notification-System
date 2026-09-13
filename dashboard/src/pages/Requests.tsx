import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveAccessRequest,
  declineAccessRequest,
  listAccessRequests,
  restoreAccountAccess,
  revokeAccountAccess,
  type AccessRequestRow,
} from '../lib/api';
import { Button, Card, EmptyState, Mono, PageHeader, Select, Skeleton, td, th } from '../ui';
import { timeAgo } from './Activity';

/**
 * B1 — THE OPERATOR'S WAITING LIST.
 *
 * Everyone who asked to be let in while the deployment runs invite-only, and
 * the two decisions that can be made about them. Rendered only for an operator
 * (Shell hides the nav item unless `me.operator`), and every button here calls
 * a route that checks that again server-side.
 *
 * ONE filtered table rather than tabs: the three states are a lifecycle, not
 * three different subjects, and an operator's whole job on this page is "work
 * the pending pile, then check nobody's invite went stale". The house Select
 * carries the filter — three options, no new component, and it reads as the
 * one control it is.
 */

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Invited' },
  { value: 'declined', label: 'Declined' },
];

type Status = 'pending' | 'approved' | 'declined';

/** Short absolute date for an expiry — "expires 16 Sep", not "in 7d". */
function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function RowActions({ row, onDone }: { row: AccessRequestRow; onDone: () => void }) {
  const [error, setError] = useState('');

  const approve = useMutation({
    mutationFn: () => approveAccessRequest(row.id),
    onSuccess: onDone,
    onError: (err) => setError(err.message),
  });
  const decline = useMutation({
    mutationFn: () => declineAccessRequest(row.id),
    onSuccess: onDone,
    onError: (err) => setError(err.message),
  });
  // B2 — the two account actions. Same idiom as the two above, which is what
  // lets one `busy` disable the whole row while any of them is in flight.
  const revoke = useMutation({
    mutationFn: () => revokeAccountAccess(row.id),
    onSuccess: onDone,
    onError: (err) => setError(err.message),
  });
  const restore = useMutation({
    mutationFn: () => restoreAccountAccess(row.id),
    onSuccess: onDone,
    onError: (err) => setError(err.message),
  });

  const busy = approve.isPending || decline.isPending || revoke.isPending || restore.isPending;

  /**
   * B2 — a spent seat used to be a dead end ("signed up" and nothing else). It
   * is now the one place an operator can reach the ACCOUNT that seat became:
   * revoke its access, or give it back.
   *
   * `accountStatus` is absent when the account no longer exists, and then the
   * row goes back to being the plain statement of fact it was — there is
   * nothing to act on.
   */
  if (row.consumedAt) {
    if (!row.accountStatus) {
      return <span className="text-[12px] text-t3">signed up</span>;
    }
    const suspended = row.accountStatus === 'suspended';
    return (
      <div className="flex items-center justify-end gap-2">
        {error && <span className="text-[12px] text-err">{error}</span>}
        {suspended ? (
          <span className="flex items-center gap-1.5 text-[12px] text-t2">
            {/* The one spot of color on this page, and it is a status — which
                is the only thing color is for here. */}
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-err" />
            suspended
          </span>
        ) : (
          <span className="text-[12px] text-t3">signed up · active</span>
        )}
        {suspended ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Restore access for ${row.email}?`)) restore.mutate();
            }}
          >
            Restore access
          </Button>
        ) : (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              // Spelled out because the consequence lands on somebody else, in
              // another browser, immediately — and is not obvious from a verb.
              if (
                window.confirm(
                  `Revoke access for ${row.email}? They will be signed out and unable to log in until restored.`,
                )
              ) {
                revoke.mutate();
              }
            }}
          >
            Revoke access
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="text-[12px] text-err">{error}</span>}
      {row.status === 'approved' && (
        <span className="text-[12px] text-t3">invited — expires {shortDate(row.inviteExpiresAt)}</span>
      )}
      {row.status === 'pending' && (
        <Button variant="secondary" disabled={busy} onClick={() => decline.mutate()}>
          Decline
        </Button>
      )}
      {row.status !== 'declined' && (
        <Button variant="primary" disabled={busy} onClick={() => approve.mutate()}>
          {/* Re-approving an approved row re-mints the code and re-sends the
              email, which is the only cure for an invite lost to a spam
              folder — so the same call wears two labels. */}
          {row.status === 'approved' ? 'Resend' : 'Approve'}
        </Button>
      )}
    </div>
  );
}

export default function RequestsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('pending');

  const { data, isLoading, error } = useQuery({
    queryKey: ['access-requests', status],
    queryFn: () => listAccessRequests(status),
    retry: false,
  });

  const rows = data?.requests ?? [];
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['access-requests'] });

  return (
    <>
      <PageHeader
        title="Requests"
        action={
          <Select
            ariaLabel="Status"
            className="w-[140px] text-[12px]"
            value={status}
            onChange={(v) => setStatus(v as Status)}
            options={STATUS_OPTIONS}
          />
        }
      />
      <p className="-mt-4 mb-5 max-w-2xl text-[12px] text-t3">
        People who asked for access while signup is invite-only. Approving emails them a link that
        works once, for seven days, and only for the address it was sent to.
      </p>

      {error ? (
        <EmptyState
          title="Not your page"
          body="Access requests are visible to platform operators only."
        />
      ) : isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            status === 'pending'
              ? 'Nobody waiting'
              : status === 'approved'
                ? 'Nobody invited yet'
                : 'Nobody declined'
          }
          body={
            status === 'pending'
              ? 'New requests from the sign-up page land here.'
              : 'Approve a pending request and it moves to this list.'
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Name</th>
                <th className={th}>Email</th>
                <th className={th}>Use case</th>
                <th className={th}>Asked</th>
                <th className={`${th} text-right`}>{status === 'declined' ? '' : 'Action'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={td}>{row.name}</td>
                  <td className={td}>
                    <Mono className="text-t2">{row.email}</Mono>
                  </td>
                  {/* Truncated with the full text on hover: a use case is a
                      paragraph, and the table is a queue to work, not a
                      document to read. */}
                  <td className={`${td} max-w-[280px]`}>
                    <span className="block truncate text-[12px] text-t2" title={row.useCase}>
                      {row.useCase}
                    </span>
                  </td>
                  <td className={td}>
                    <Mono className="text-t3">{timeAgo(row.createdAt)}</Mono>
                  </td>
                  <td className={`${td} text-right`}>
                    <RowActions row={row} onDone={refresh} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
