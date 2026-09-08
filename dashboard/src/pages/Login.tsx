import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchAuthMethods,
  login,
  redeemGoogleCode,
  requestPasswordReset,
  signup,
  ApiError,
} from '../lib/api';
import { Button, Card, Field, Input, PasswordInput } from '../ui';

/** Shared by every signed-out page, including /reset-password. */
export function AuthFrame({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-app">
      <div className="w-full max-w-[360px] px-4">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--accent)' }} />
          <span className="text-[15px] font-semibold tracking-tight">asyncify</span>
        </div>
        <Card className="p-6">
          <h1 className="mb-5 text-center text-[15px] font-semibold">{title}</h1>
          {children}
        </Card>
      </div>
    </div>
  );
}

/**
 * The Google "G", monochrome. The brand mark is normally four colors; the
 * design system reserves color for delivery status, so it is drawn in
 * currentColor like every other icon here. One path, inlined — the strict CSP
 * (S1.3) blocks third-party assets, and this way there is nothing to load.
 */
function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}

/**
 * "Forgot password?" — the same card, one field.
 *
 * The confirmation NEVER varies: whether or not that address has an account,
 * the answer is the same sentence, because the server deliberately returns the
 * same 200 either way. A friendlier "we couldn't find that email" here would
 * hand back exactly the account-enumeration oracle /auth/forgot is built to
 * withhold.
 */
export function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  if (sent) {
    return (
      <>
        <p className="text-[13px] leading-relaxed text-t2">
          If that account exists, a reset link is on its way. The link works for 30 minutes.
        </p>
        <Button type="button" className="mt-4 w-full" onClick={onBack}>
          Back to log in
        </Button>
      </>
    );
  }

  return (
    <>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const email = String(new FormData(e.currentTarget).get('email'));
          setBusy(true);
          setError('');
          try {
            await requestPasswordReset(email);
            setSent(true);
          } catch {
            // Only a transport/limit failure can land here — the endpoint has
            // no unhappy answer of its own.
            setError('Could not reach the server. Try again in a moment.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-[12px] leading-relaxed text-t3">
          Enter the email you sign in with and we'll send a link to choose a new password.
        </p>
        <Field label="Email">
          <Input name="email" type="email" required autoFocus placeholder="you@company.com" />
        </Field>
        {error && <p className="text-[12px] text-err">{error}</p>}
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      <p className="mt-4 text-center text-[12px] text-t3">
        <button type="button" className="text-t1 underline underline-offset-2" onClick={onBack}>
          Back to log in
        </button>
      </p>
    </>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [forgot, setForgot] = useState(false);

  // The one-time code the Google callback bounced us back with. Read once per
  // mount; a re-render must not re-read a URL we are about to rewrite.
  const [gcode] = useState(() => new URLSearchParams(window.location.search).get('gcode') ?? '');
  // The code is SINGLE-USE server-side, so a second redeem is a guaranteed
  // 401 — and StrictMode runs every mount effect twice in dev. The ref
  // survives that simulated remount; a state flag would not be set yet.
  const redeeming = useRef(false);

  useEffect(() => {
    // Feature detection, not a build flag: one bundle serves deployments with
    // and without Google configured.
    fetchAuthMethods()
      .then((m) => setGoogleEnabled(m.google))
      .catch(() => setGoogleEnabled(false));
  }, []);

  useEffect(() => {
    if (!gcode || redeeming.current) return;
    redeeming.current = true;
    // Strip it before anything else: a login code must not survive in the
    // address bar, in history, or in a bookmark.
    window.history.replaceState(null, '', window.location.pathname);
    setBusy(true);
    redeemGoogleCode(gcode)
      .then(() => navigate('/'))
      .catch(() => setError('Sign-in expired — try again'))
      .finally(() => setBusy(false));
  }, [gcode, navigate]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await login(String(form.get('email')), String(form.get('password')));
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  if (forgot) {
    return (
      <AuthFrame title="Reset your password">
        <ForgotPasswordForm onBack={() => setForgot(false)} />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Log in">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input name="email" type="email" required autoFocus placeholder="you@company.com" />
        </Field>
        <Field label="Password">
          <PasswordInput name="password" required placeholder="••••••••" />
        </Field>
        {error && <p className="text-[12px] text-err">{error}</p>}
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
      {/* Quiet on purpose: t3, no border, no button chrome. It belongs to the
          small fraction of sign-ins that need it, and should not compete with
          the primary action above it. */}
      <p className="mt-3 text-center text-[12px]">
        <button
          type="button"
          className="text-t3 transition-colors hover:text-t1"
          onClick={() => setForgot(true)}
        >
          Forgot password?
        </button>
      </p>
      {googleEnabled && (
        <>
          <div className="my-4 flex items-center gap-3">
            <span className="h-px flex-1 bg-bd" />
            <span className="text-[11px] uppercase tracking-wide text-t3">or</span>
            <span className="h-px flex-1 bg-bd" />
          </div>
          {/* A plain navigation, not fetch: the whole point of the redirect
              flow is that the browser walks to Google itself. */}
          <Button
            type="button"
            className="w-full"
            disabled={busy}
            onClick={() => {
              window.location.href = '/auth/google';
            }}
          >
            <GoogleMark />
            Continue with Google
          </Button>
        </>
      )}
      <p className="mt-4 text-center text-[12px] text-t3">
        New here?{' '}
        <Link to="/signup" className="text-t1 underline underline-offset-2">
          Create an account
        </Link>
      </p>
    </AuthFrame>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await signup({
        name: String(form.get('name')),
        email: String(form.get('email')),
        password: String(form.get('password')),
        organizationName: String(form.get('org')),
      });
      navigate('/keys?welcome=1');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Create your account">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name">
          <Input name="name" required autoFocus placeholder="Ada Lovelace" />
        </Field>
        <Field label="Organization">
          <Input name="org" required placeholder="Acme Inc" />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" required placeholder="you@company.com" />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <PasswordInput name="password" minLength={8} required placeholder="••••••••" />
        </Field>
        {error && <p className="text-[12px] text-err">{error}</p>}
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-4 text-center text-[12px] text-t3">
        Already have an account?{' '}
        <Link to="/login" className="text-t1 underline underline-offset-2">
          Log in
        </Link>
      </p>
    </AuthFrame>
  );
}
