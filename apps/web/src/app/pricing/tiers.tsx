'use client';

import { useState } from 'react';
import type { Interval } from '@/lib/env';

interface Props {
  name: string;
  tagline: string;
  features: string[];
  prices: Partial<Record<Interval, string>>;
  signedIn: boolean;
}

export function PricingTiers({ name, tagline, features, prices, signedIn }: Props) {
  const [busy, setBusy] = useState<Interval | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subscribe = async (interval: Interval) => {
    setError(null);
    if (!signedIn) {
      window.location.href = `/signin?next=${encodeURIComponent('/pricing')}`;
      return;
    }
    setBusy(interval);
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ interval }),
      });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string; signIn?: boolean };
      if (body.signIn) {
        window.location.href = `/signin?next=${encodeURIComponent('/pricing')}`;
        return;
      }
      if (!response.ok || !body.url) throw new Error(body.error ?? 'Checkout could not be started');
      window.location.href = body.url;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };

  const tier = (interval: Interval) => (
    <div key={interval} className={`panel tier${interval === 'year' ? ' featured' : ''}`}>
      <div className="eyebrow">{interval === 'year' ? 'Yearly · two months free' : 'Monthly'}</div>
      <h2>{name}</h2>
      <p className="muted">{tagline}</p>
      <div className="price">
        {prices[interval] ?? '—'} <small>/ {interval}</small>
      </div>
      <button
        type="button"
        className={interval === 'year' ? 'button' : 'button secondary'}
        disabled={busy !== null}
        onClick={() => void subscribe(interval)}
      >
        {busy === interval ? 'Opening checkout…' : signedIn ? `Subscribe ${interval === 'year' ? 'yearly' : 'monthly'}` : 'Sign in to subscribe'}
      </button>
    </div>
  );

  return (
    <>
      <div className="tiers">{(['month', 'year'] as const).map(tier)}</div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h3>Everything in VC DIT</h3>
        <ul>
          {features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
