import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchAuthMethods,
  login,
  redeemGoogleCode,
  requestAccess,
  requestPasswordReset,
  signup,
  ApiError,
  type AuthMethods,
} from '../lib/api';
import { Button, Field, Input, PasswordInput, Skeleton } from '../ui';
import {
  AuthFooter,
  AuthLayout,
  Receipt,
  ReceiptLine,
} from './auth/AuthLayout';

/** B1 — the one sentence a bounced Google sign-in lands on. */
const INVITE_ONLY_NOTICE = 'Asyncify is invite-only right now — request access below.';

/** Read a query param once, at mount. */
function useQueryParam(name: string): string {
  return useState(() => new URLSearchParams(window.location.search).get(name) ?? '')[0];
}

/** The quiet line that sits above a form and explains why it is there. */
function FormNotice({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-[12px] leading-relaxed text-t3">{children}</p>;
}

const linkStyle = 'text-t1 underline underline-offset-2';

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
 * U3 — the Google door, now ABOVE the email form: it is the faster way in for
 * the people who have it, and a divider says the two are alternatives rather
 * than steps. Same gate as before (only when /auth/methods says google), same
 * plain navigation — the whole point of the redirect flow is that the browser
 * walks to Google itself, so this is a location assignment, never a fetch.
 */
function GoogleSignIn({ disabled }: { disabled: boolean }) {
  return (
    <>
      <Button
        type="button"
        className="w-full"
        disabled={disabled}
        onClick={() => {
          window.location.href = '/auth/google';
        }}
      >
        <GoogleMark />
        Continue with Google
      </Button>
      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-bd" />
        <span className="text-[11px] uppercase tracking-wide text-t3">or</span>
        <span className="h-px flex-1 bg-bd" />
      </div>
    </>
  );
}

/**
 * "Forgot password?" — the same frame, one field.
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
        <Receipt label="Reset link sent" stagger>
          <ReceiptLine index={0}>
            If that account exists, a reset link is on its way. The link works for 30 minutes.
          </ReceiptLine>
        </Receipt>
        <Button type="button" className="mt-5 w-full" onClick={onBack}>
          Back to log in
        </Button>
      </>
    );
  }

  return (
    <>
      <FormNotice>
        Enter the email you sign in with and we'll send a link to choose a new password.
      </FormNotice>
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
        <Field label="Email">
          <Input name="email" type="email" required autoFocus placeholder="you@company.com" />
        </Field>
        {error && <p className="text-[12px] text-err">{error}</p>}
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      <AuthFooter>
        <button type="button" className={linkStyle} onClick={onBack}>
          Back to log in
        </button>
      </AuthFooter>
    </>
  );
}

/**
 * B1 — "let me in", the form that stands where the signup form stands while the
 * deployment runs in invite mode.
 *
 * The confirmation NEVER varies, exactly like ForgotPasswordForm above and for
 * the same reason: the server answers the same 200 to a first ask, a repeat, an
 * address it already declined, and an address that already has an account. A
 * friendlier "you already have an account" here would hand back the
 * enumeration oracle the endpoint deliberately withholds.
 */
export function RequestAccessForm({ notice, onBack }: { notice?: string; onBack?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  // U3 — the answer to something they just did, so it arrives as a receipt:
  // same sentence, printed a line at a time.
  if (sent) {
    return (
      <Receipt label="Request received" stagger>
        <ReceiptLine index={0}>Thanks — we'll email you when you're in.</ReceiptLine>
      </Receipt>
    );
  }

  return (
    <>
      <FormNotice>
        {notice ?? "We're onboarding teams a few at a time. Tell us who you are and we'll be in touch."}
      </FormNotice>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          try {
            await requestAccess({
              name: String(form.get('name')),
              email: String(form.get('email')),
              useCase: String(form.get('useCase')),
            });
            setSent(true);
          } catch (err) {
            // Only a transport or rate-limit failure can land here — the
            // endpoint has no unhappy answer of its own for a valid form.
            setError(
              err instanceof ApiError && err.status === 429
                ? 'Too many requests — try again in a minute.'
                : 'Could not reach the server. Try again in a moment.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Your name">
          <Input name="name" required autoFocus maxLength={120} placeholder="Ada Lovelace" />
        </Field>
        <Field label="Email">
          <Input
            name="email"
            type="email"
            required
            maxLength={320}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="What would you use it for?">
          <textarea
            name="useCase"
            required
            rows={7}
            maxLength={500}
            placeholder="Transactional email and in-app notifications for our support product."
            className="w-full rounded-md border border-bd bg-transparent p-2.5 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong"
          />
        </Field>
        {error && <p className="text-[12px] text-err">{error}</p>}
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>
          {busy ? 'Sending…' : 'Request access'}
        </Button>
      </form>
      <AuthFooter>
        Already have an account?{' '}
        {onBack ? (
          <button type="button" className={linkStyle} onClick={onBack}>
            Log in
          </button>
        ) : (
          <Link to="/login" className={linkStyle}>
            Log in
          </Link>
        )}
      </AuthFooter>
    </>
  );
}

/**
 * The account-creation form itself. Extracted from SignupPage because B1 gave
 * it a second home: an invite link lands on /login?invite=<code>, and that page
 * must be able to render the same form with the code wired in rather than
 * bouncing an invited person through another navigation.
 */
function SignupForm({ inviteCode }: { inviteCode?: string }) {
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
        // Held in state, not in a hidden field: it is a credential, and a form
        // field is one autofill extension away from being somewhere else.
        inviteCode: inviteCode || undefined,
      });
      navigate('/keys?welcome=1');
    } catch (err) {
      // The server's own words — "a valid invite for this email is required"
      // is the one message an invited person actually needs to see.
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {inviteCode && (
        <>
          {/* U3 — the invite as a ticket. What it shows is that an invite is in
              hand, never its value: the code is semi-sensitive, it is already
              held in state for the submit, and printing it teaches nobody
              anything. No expiry either — the client is not told one, and a
              made-up date is worse than no date. */}
          <Receipt label="Invite" className="mb-4">
            <ReceiptLine>single use</ReceiptLine>
          </Receipt>
          <FormNotice>
            Invited — create your account with the email that received the invite.
          </FormNotice>
        </>
      )}
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
      <AuthFooter>
        Already have an account?{' '}
        <Link to="/login" className={linkStyle}>
          Log in
        </Link>
      </AuthFooter>
    </>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [forgot, setForgot] = useState(false);
  const [requesting, setRequesting] = useState(false);
  // U3 — the 400ms between "you're in" and the navigation, during which the
  // mark on the brand panel rings once. Never true when the panel is hidden or
  // motion is turned down; those paths navigate on the spot.

  /**
   * B1 — the two ways this page is reached with a story attached:
   *   ?invite=<code>  the link out of an approval email -> show the signup form
   *   ?gate=request   a Google sign-in with no invite    -> show the ask form
   * Read once at mount, like `gcode` below.
   */
  const invite = useQueryParam('invite');
  const [gate, setGate] = useState(
    () => new URLSearchParams(window.location.search).get('gate') ?? '',
  );

  // The one-time code the Google callback bounced us back with. Read once per
  // mount; a re-render must not re-read a URL we are about to rewrite.
  const [gcode] = useState(() => new URLSearchParams(window.location.search).get('gcode') ?? '');
  // The code is SINGLE-USE server-side, so a second redeem is a guaranteed
  // 401 — and StrictMode runs every mount effect twice in dev. The ref
  // survives that simulated remount; a state flag would not be set yet.
  const redeeming = useRef(false);

  /** Where every successful sign-in lands — password and Google alike.
      Instant: the success ring was retired (his call, 2026-09-11). */
  const enter = useCallback(() => navigate('/'), [navigate]);

  useEffect(() => {
    // Feature detection, not a build flag: one bundle serves deployments with
    // and without Google configured, open or invite-only.
    fetchAuthMethods()
      .then(setMethods)
      .catch(() => setMethods({ google: false, signupMode: 'open' }));
  }, []);

  useEffect(() => {
    if (!gcode || redeeming.current) return;
    redeeming.current = true;
    // Strip it before anything else: a login code must not survive in the
    // address bar, in history, or in a bookmark.
    window.history.replaceState(null, '', window.location.pathname);
    setBusy(true);
    redeemGoogleCode(gcode)
      .then(() => enter())
      .catch(() => setError('Sign-in expired — try again'))
      .finally(() => setBusy(false));
  }, [gcode, enter]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await login(String(form.get('email')), String(form.get('password')));
      enter();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  if (forgot) {
    return (
      <AuthLayout title="Reset your password" subtitle="Choose a new password for your account.">
        <ForgotPasswordForm onBack={() => setForgot(false)} />
      </AuthLayout>
    );
  }

  // An invite link lands here. The code is the reason this person came, so the
  // page becomes the signup form rather than making them find it.
  if (invite) {
    return (
      <AuthLayout title="Create your account" subtitle="A few details and you are in.">
        <SignupForm inviteCode={invite} />
      </AuthLayout>
    );
  }

  if (requesting || gate === 'request') {
    return (
      <AuthLayout title="Request access">
        <RequestAccessForm
          notice={gate === 'request' ? INVITE_ONLY_NOTICE : undefined}
          onBack={() => {
            setRequesting(false);
            // The Google bounce put ?gate=request in the address bar; clear it
            // too, or a reload would land straight back on this form.
            if (gate) {
              setGate('');
              window.history.replaceState(null, '', window.location.pathname);
            }
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Log in" subtitle="Welcome back — log in to continue.">
      {methods?.google && <GoogleSignIn disabled={busy} />}
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
      {/* Held back until /auth/methods answers: in invite mode this is "request
          access", and offering "create an account" for a beat first would send
          people to a door that is not there. */}
      {methods && (
        <AuthFooter>
          No account?{' '}
          {methods.signupMode === 'invite' ? (
            <button type="button" className={linkStyle} onClick={() => setRequesting(true)}>
              Request access
            </button>
          ) : (
            <Link to="/signup" className={linkStyle}>
              Create one
            </Link>
          )}
        </AuthFooter>
      )}
    </AuthLayout>
  );
}

/**
 * B1 — the signup form, or the request-access form in its place.
 *
 * Which one is decided by the SERVER's answer, never by a build flag, so one
 * bundle serves an open deployment and an invite-only one. It is held behind a
 * skeleton until that answer lands: rendering "create your account" for a beat
 * and then swapping it for "request access" is the kind of flicker that makes
 * people think they missed something.
 */
export function SignupPage() {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const invite = useQueryParam('invite');

  useEffect(() => {
    fetchAuthMethods()
      .then(setMethods)
      .catch(() => setMethods({ google: false, signupMode: 'open' }));
  }, []);

  if (!methods) {
    return (
      <AuthLayout title="Create your account" subtitle="A few details and you are in.">
        <Skeleton className="h-56 w-full" />
      </AuthLayout>
    );
  }

  // Invite mode with no code in hand: there is nothing to create yet.
  if (methods.signupMode === 'invite' && !invite) {
    return (
      <AuthLayout title="Request access">
        <RequestAccessForm notice={INVITE_ONLY_NOTICE} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create your account" subtitle="A few details and you are in.">
      <SignupForm inviteCode={invite || undefined} />
    </AuthLayout>
  );
}
