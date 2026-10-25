'use client';

import Link from 'next/link';
import { useState } from 'react';
import { browserClient } from '@/lib/supabase-browser';

/**
 * Set or change the account's password, signed in: from the account page, or
 * from the "Forgot your password?" email, whose link signs the customer in
 * and lands here.
 */

const MIN_LENGTH = 8;

export default function PasswordPage() {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [status, setStatus] = useState<'idle' | 'busy' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== again) return setError('The two passwords are not the same.');
    setStatus('busy');
    const client = browserClient();
    const { data } = await client.auth.getUser();
    if (!data.user) {
      setStatus('idle');
      return setError('Your sign-in has ended. Sign in again (or use “Forgot your password?”), then set it here.');
    }
    const { error: failure } = await client.auth.updateUser({ password });
    if (failure) {
      setStatus('idle');
      return setError(failure.message);
    }
    setStatus('saved');
  };

  return (
    <>
      <div className="hero">
        <div className="eyebrow">Account</div>
        <h1>Password</h1>
        <p className="lede">Set a password to sign in without waiting for an email. The emailed link keeps working too.</p>
      </div>
      <div className="panel" style={{ maxWidth: 520 }}>
        {status === 'saved' ? (
          <>
            <p className="notice" role="status">
              Saved. Next time, sign in with your email and this password.
            </p>
            <div className="actions">
              <Link className="button" href="/account">
                Back to your account
              </Link>
            </div>
          </>
        ) : (
          <form className="stack" onSubmit={save}>
            <input
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="New password"
              aria-label="New password"
              autoComplete="new-password"
              minLength={MIN_LENGTH}
            />
            <input
              type="password"
              required
              value={again}
              onChange={(event) => setAgain(event.target.value)}
              placeholder="The same again"
              aria-label="Repeat the new password"
              autoComplete="new-password"
            />
            <button type="submit" className="button" disabled={status === 'busy'}>
              {status === 'busy' ? 'Saving…' : 'Save password'}
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
