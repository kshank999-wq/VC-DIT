'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { safeNextPath } from '@/lib/auth-redirect';
import { browserClient } from '@/lib/supabase-browser';

/**
 * Email sign-in, as VC Writer's: a link, no password. The account is shared
 * with VC Writer, so a VC Writer customer signs in with the address they
 * already use.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

function SignInForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const failed = params.get('error') === 'link_expired';
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus('sending');
    setError(null);
    const { error: signInError } = await browserClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (signInError) {
      setError(signInError.message);
      setStatus('idle');
      return;
    }
    setStatus('sent');
  };

  return (
    <>
      <div className="hero">
        <h1>Sign in</h1>
        <p className="lede">We will email you a link. One VC account covers VC DIT, VC Writer and VC Game Studio.</p>
      </div>
      <div className="panel" style={{ maxWidth: 520 }}>
        {failed && status !== 'sent' ? (
          <p className="notice" role="status">
            That link could not sign you in: it had been used already, or it was opened in a different browser from the one
            that asked for it. Ask for a new one and open it in this browser.
          </p>
        ) : null}
        {status === 'sent' ? (
          <p className="notice">Check {email} for your sign-in link, and open it in this browser.</p>
        ) : (
          <form className="stack" onSubmit={submit}>
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              aria-label="Email address"
              autoComplete="email"
            />
            <button type="submit" className="button" disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Email me a link'}
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
