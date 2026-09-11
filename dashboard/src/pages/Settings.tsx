import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  changePassword,
  fetchMe,
  renameOrganization,
  session,
  subscribeToEnv,
} from '../lib/api';
import { startTour } from '../lib/tour';
import { Button, Card, Field, Input, PageHeader, PasswordInput, Skeleton } from '../ui';

/**
 * U2 — the organization's display name, which is the left half of every row in
 * the sidebar's environment switcher ("{org} — {env}").
 *
 * Both the current name and the caller's ROLE come out of the same ['me'] query
 * the Shell already keeps warm (/auth/me returns `organizations[].role`), so
 * this card costs no extra request and the button can be disabled for a member
 * rather than letting them type a name only to be refused. WHICH organization
 * is being renamed follows the selected environment — an environment belongs to
 * exactly one org, so for a user in several, the one they are looking at is the
 * one this edits, and the same `x-environment-id` tells the server so.
 *
 * On success it invalidates ['me'], which is what feeds the switcher: the new
 * name appears in the sidebar on the refetch, with no reload.
 */
function OrganizationCard() {
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false });
  // localStorage is not reactive; the Shell's switcher writes it. Same store,
  // so switching environments re-points this card at the matching org.
  const envId = useSyncExternalStore(subscribeToEnv, () => session.envId);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const save = useMutation({
    mutationFn: renameOrganization,
    onSuccess: () => {
      setDone(true);
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => {
      setDone(false);
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    },
  });

  if (isLoading) return <Skeleton className="h-44 w-full max-w-md" />;

  const org =
    me?.organizations.find((o) => o.environments.some((e) => e.id === envId)) ??
    me?.organizations[0];
  if (!org) return null;

  const canRename = org.role === 'owner' || org.role === 'admin';

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDone(false);
    save.mutate(String(new FormData(e.currentTarget).get('name')).trim());
  };

  return (
    <Card className="w-full p-5">
      <h2 className="text-[15px] font-semibold text-t1">Organization</h2>
      <p className="mb-4 mt-1 text-[12px] leading-relaxed text-t3">
        The name shown beside each environment in the sidebar. Renaming it changes nothing else —
        your API keys, workflows and data all stay exactly where they are.
      </p>
      {/* key: after a save the query refetches, and remounting adopts the
          stored name as the field's new starting point. */}
      <form key={org.name} onSubmit={submit} className="space-y-4">
        <Field label="Name" hint={canRename ? undefined : 'Only an owner or admin can change this.'}>
          <Input
            name="name"
            defaultValue={org.name}
            required
            maxLength={120}
            disabled={!canRename}
            placeholder="Acme Inc"
          />
        </Field>
        {error && <p className="text-[12px] text-err">{error}</p>}
        {done && !error && <p className="text-[12px] text-t2">Organization name updated.</p>}
        <Button variant="primary" type="submit" disabled={!canRename || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Card>
  );
}

/**
 * S1.7a — the account's own credential. Two shapes, and the SERVER decides
 * which: `hasPassword` comes from /auth/me, read out of the same ['me'] query
 * the Shell already keeps warm, so this costs no extra request.
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
    <Card className="w-full p-5">
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
            <PasswordInput
              name="currentPassword"
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
          <PasswordInput
            name="newPassword"
            minLength={8}
            required
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </Field>
        <Field label="Confirm new password">
          <PasswordInput
            name="confirm"
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

/** U5 — the tour, re-runnable on demand: a card like its two neighbors. */
function TourCard() {
  return (
    <Card className="w-full p-5">
      <h2 className="text-[14px] font-semibold text-t1">Product tour</h2>
      <p className="mb-3 mt-1 text-[12px] leading-relaxed text-t3">
        The walkthrough from your first visit — replay it anytime.
      </p>
      <Button type="button" onClick={() => startTour()}>
        Replay the tour
      </Button>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      {/* His layout: the two account cards stacked in a centered main
          column, the tour as a small aside on their right; everything
          single-column under 900px. */}
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 min-[900px]:flex-row min-[900px]:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <OrganizationCard />
          <PasswordCard />
        </div>
        <div className="w-full shrink-0 min-[900px]:w-[240px]">
          <TourCard />
        </div>
      </div>

    </>
  );
}
