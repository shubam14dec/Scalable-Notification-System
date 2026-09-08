import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, resetPassword } from '../lib/api';
import { Button, Field, PasswordInput } from '../ui';
import { AuthFrame, ForgotPasswordForm } from './Login';

/**
 * S1.7a — where a reset link lands.
 *
 * Signed OUT (it is in the public routes, above RequireAuth): the token in the
 * URL is the whole credential, which is the point — the person clicking it is,
 * by definition, someone who cannot log in.
 *
 * On success it does NOT sign them in. The server mints no session here
 * (src/api/routes/auth.ts), so this page hands them to /login, where typing the
 * new password proves it works. A reset that ends at a dashboard has tested
 * nothing.
 */
export default function ResetPasswordPage() {
  // Read once per mount, like the Google gcode: a re-render must not re-read a
  // URL, and the token is not something to keep re-parsing.
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  // A dead link drops straight into the "ask for another one" form — the only
  // useful next step, and it saves a trip back through /login to find it.
  const [expired, setExpired] = useState(!token);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirm'))) {
      setError('Those two passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      // 401 is the single-use/expired verdict; anything else is a real error
      // worth showing verbatim.
      if (err instanceof ApiError && err.status === 401) setExpired(true);
      else setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthFrame title="Password changed">
        <p className="text-[13px] leading-relaxed text-t2">
          Your new password is set. Log in with it to continue.
        </p>
        <Link to="/login" className="mt-4 block">
          <Button variant="primary" className="w-full">
            Go to log in
          </Button>
        </Link>
      </AuthFrame>
    );
  }

  if (expired) {
    return (
      <AuthFrame title="That link has expired">
        <p className="mb-4 text-[13px] leading-relaxed text-t2">
          Reset links last 30 minutes and work once. Enter your email and we'll send a new one.
        </p>
        {/* No "back" destination that isn't /login for a signed-out visitor. */}
        <ForgotPasswordForm onBack={() => window.location.assign('/login')} />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password" hint="At least 8 characters">
          <PasswordInput
            name="password"
            minLength={8}
            required
            autoFocus
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
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Set password'}
        </Button>
      </form>
      <p className="mt-4 text-center text-[12px] text-t3">
        <Link to="/login" className="text-t1 underline underline-offset-2">
          Back to log in
        </Link>
      </p>
    </AuthFrame>
  );
}
