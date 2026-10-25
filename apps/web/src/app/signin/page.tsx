'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeNextPath } from '@/lib/auth-redirect';
import { browserClient } from '@/lib/supabase-browser';

/**
 * Sign in with a password, or with a link by email for anyone who has none
 * or has forgotten it. A forgotten password is reset by a link to
 * /account/password, where a signed-in customer can also set one.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

type Status = 'idle' | 'busy' | 'link-sent' | 'reset-sent';

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const failed = params.get('error') === 'link_expired';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const callback = (to: string) => `${window.location.origin}/auth/callback?next=${encodeURIComponent(to)}`;

  const run = async (action: () => Promise<{ error: { message: string } | null }>, done: Status | (() => void)) => {
    setStatus('busy');
    setError(null);
    const { error: failure } = await action();
    if (failure) {
      setError(failure.message);
      setStatus('idle');
      return;
    }
    if (typeof done === 'function') done();
    else setStatus(done);
  };

  const signIn = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) {
      setError('Enter your password, or use “Email me a link”.');
      return;
    }
    void run(
      async () => {
        const { error: failure } = await browserClient().auth.signInWithPassword({ email, password });
        return {
          error: failure
            ? {
                message:
                  failure.message === 'Invalid login credentials'
                    ? 'That email and password do not match. No password yet? Use “Email me a link”, then set one on your account page.'
                    : failure.message,
              }
            : null,
        };
      },
      () => {
        router.replace(next);
        router.refresh();
      },
    );
  };

  const needEmail = () => {
    if (email.includes('@')) return true;
    setError('Enter your email address first.');
    return false;
  };

  const emailLink = () => {
    if (!needEmail()) return;
    void run(() => browserClient().auth.signInWithOtp({ email, options: { emailRedirectTo: callback(next) } }), 'link-sent');
  };

  const forgot = () => {
    if (!needEmail()) return;
    void run(() => browserClient().auth.resetPasswordForEmail(email, { redirectTo: callback('/account/password') }), 'reset-sent');
  };

  const busy = status === 'busy';

  return (
    <>
      <div className="hero">
        <h1>Sign in</h1>
        <p className="lede">With your password, or with a link we email you.</p>
      </div>
      <div className="panel" style={{ maxWidth: 520 }}>
        {failed && status === 'idle' ? (
          <p className="notice" role="status">
            That link could not sign you in: it had been used already, or it was opened in a different browser from the one
            that asked for it. Ask for a new one and open it in this browser.
          </p>
        ) : null}
        {status === 'link-sent' ? (
          <p className="notice">Check {email} for your sign-in link, and open it in this browser.</p>
        ) : status === 'reset-sent' ? (
          <p className="notice">Check {email} for a link to choose a new password, and open it in this browser.</p>
        ) : (
          <form className="stack" onSubmit={signIn}>
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              aria-label="Email address"
              autoComplete="email"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              aria-label="Password"
              autoComplete="current-password"
            />
            <button type="submit" className="button" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={emailLink}>
              Email me a link instead
            </button>
            <button type="button" className="link-button" disabled={busy} onClick={forgot} style={{ justifySelf: 'start' }}>
              Forgot your password?
            </button>
          </form>
        )}
        {error ? (
          <p className="error" role="alert" style={{ marginTop: 16 }}>
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}
