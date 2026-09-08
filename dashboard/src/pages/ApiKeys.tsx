import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, changePassword, fetchMe, session } from '../lib/api';
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
  td,
  th,
} from '../ui';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * S1.7a — the account's own credential, on the page that already owns
 * credentials. Two shapes, and the SERVER decides which: `hasPassword` comes
 * from /auth/me, read out of the same ['me'] query the Shell already keeps
 * warm, so this costs no extra request.
 *
 *   hasPassword  -> current + new + confirm. Re-proving possession is what
 *                   stops a borrowed laptop becoming a permanent takeover.
 *   !hasPassword -> a Google-only account (S1.6) that has never had one. There
 *                   is no current password to ask for, so the card asks for
 *                   nothing it cannot get.
 *
 * On success it invalidates ['me'], and the card flips to the has-password
 * shape on the refetch — the state is the server's, not a local flag that could
 * drift from it.
 */
function PasswordCard() {
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const hasPassword = me?.hasPassword ?? false;

  const save = useMutation({
    mutationFn: changePassword,
    onSuccess: () => {
      setDone(true);
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not reach the server'),
  });

  if (isLoading) return <Skeleton className="h-48 w-full max-w-md" />;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get('newPassword'));
    if (newPassword !== String(form.get('confirm'))) {
      setDone(false);
      setError('Those two passwords do not match.');
      return;
    }
    setDone(false);
    save.mutate({
      newPassword,
      // Omitted entirely when there is none — the server ignores it on that
      // path, and sending an empty string would just be noise.
      ...(hasPassword ? { currentPassword: String(form.get('currentPassword')) } : {}),
    });
  };

  return (
    <Card className="max-w-md p-5">
      <h2 className="text-[15px] font-semibold text-t1">
        {hasPassword ? 'Password' : 'Set a password'}
      </h2>
      <p className="mb-4 mt-1 text-[12px] leading-relaxed text-t3">
        {hasPassword
          ? 'Used to sign in with your email address.'
          : 'You sign in with Google today. Setting a password lets you sign in without it — Google keeps working either way.'}
      </p>
      {/* key: remounting on the flip clears the fields the old shape held. */}
      <form key={hasPassword ? 'change' : 'set'} onSubmit={submit} className="space-y-4">
        {hasPassword && (
          <Field label="Current password">
            <Input
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
            {/* The forgot-while-logged-in case: the email reset flow is the
                identity proof when the current password is gone — the same
                reason this field exists at all (an open session must not be
                enough to change the lock). */}
            <p className="mt-1 text-[11px] text-t3">
              Forgot it? Log out and use "Forgot password?" on the login page.
            </p>
          </Field>
        )}
        <Field label="New password" hint="At least 8 characters">
          <Input
            name="newPassword"
            type="password"
            minLength={8}
            required
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </Field>
        <Field label="Confirm new password">
          <Input
            name="confirm"
            type="password"
            minLength={8}
            required
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </Field>
        {error && <p className="text-[12px] text-err">{error}</p>}
        {done && !error && <p className="text-[12px] text-t2">Password updated.</p>}
        <Button variant="primary" type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}
        </Button>
      </form>
    </Card>
  );
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const envId = session.envId;
  const [createOpen, setCreateOpen] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', envId],
    queryFn: () =>
      api<{ apiKeys: ApiKey[] }>(`/v1/account/environments/${envId}/api-keys`),
    enabled: Boolean(envId),
  });

  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ apiKey: string }>(`/v1/account/environments/${envId}/api-keys`, {
        method: 'POST',
        body: { name },
      }),
    onSuccess: (res) => {
      setCreateOpen(false);
      setFreshKey(res.apiKey);
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) =>
      api(`/v1/account/environments/${envId}/api-keys/${keyId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <>
      <PageHeader
        title="API keys"
        action={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Create key
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.apiKeys.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Name</th>
                <th className={th}>Key</th>
                <th className={th}>Created</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {data.apiKeys.map((k) => (
                <tr key={k.id} className="transition-colors hover:bg-elevated">
                  <td className={td}>{k.name}</td>
                  <td className={td}>
                    <Mono className="text-t2">{k.prefix}</Mono>
                  </td>
                  <td className={td}>
                    <Mono className="text-t3">{new Date(k.createdAt).toLocaleDateString()}</Mono>
                  </td>
                  <td className={td}>
                    {k.revokedAt ? (
                      <span className="text-[12px] text-t3">revoked</span>
                    ) : (
                      <span className="text-[12px] text-t2">active</span>
                    )}
                  </td>
                  <td className={`${td} text-right`}>
                    {!k.revokedAt && (
                      <Button
                        variant="danger"
                        onClick={() => {
                          if (window.confirm(`Revoke "${k.name}"? Requests using it will fail immediately.`)) {
                            revoke.mutate(k.id);
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No API keys"
          body="Create a key to trigger notifications from your backend. Keys are shown once and stored hashed."
        />
      )}

      <div className="mt-10">
        <PasswordCard />
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(String(new FormData(e.currentTarget).get('name')) || 'default');
          }}
          className="space-y-4"
        >
          <Field label="Name" hint="Something that tells you where it's used, e.g. backend-prod">
            <Input name="name" autoFocus placeholder="backend-prod" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(freshKey)} onClose={() => setFreshKey(null)} title="Copy your new key">
        <p className="mb-3 text-t2">
          This is the only time the full key is shown. Store it somewhere safe.
        </p>
        {freshKey && <CopyField value={freshKey} />}
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={() => setFreshKey(null)}>
            Done
          </Button>
        </div>
      </Modal>
    </>
  );
}
