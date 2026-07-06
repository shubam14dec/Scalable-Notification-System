import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login, signup, ApiError } from '../lib/api';
import { Button, Card, Field, Input } from '../ui';

function AuthFrame({ children, title }: { children: React.ReactNode; title: string }) {
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

export function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <AuthFrame title="Log in">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input name="email" type="email" required autoFocus placeholder="you@company.com" />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" required placeholder="••••••••" />
        </Field>
        {error && <p className="text-[12px] text-err">{error}</p>}
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
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
          <Input name="password" type="password" minLength={8} required placeholder="••••••••" />
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
