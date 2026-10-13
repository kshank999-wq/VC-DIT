'use client';

import { useEffect, useState } from 'react';
import { browserClient } from '@/lib/supabase-browser';

const post = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(url, { method: 'POST', ...init });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body['error'] === 'string' ? body['error'] : `Request failed (${response.status})`);
  return body;
};

export function SignOut() {
  return (
    <button
      type="button"
      className="link-button"
      onClick={() => void browserClient().auth.signOut().then(() => (window.location.href = '/'))}
    >
      Sign out
    </button>
  );
}

export function BillingButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          post('/api/billing/portal')
            .then((body) => (window.location.href = String(body['url'])))
            .catch((cause: Error) => {
              setError(cause.message);
              setBusy(false);
            });
        }}
      >
        {busy ? 'Opening…' : 'Billing, card and cancellation'}
      </button>
      {error ? <span className="error">{error}</span> : null}
    </>
  );
}

export function ResendLicense() {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | string>('idle');
  return (
    <p className="muted">
      <button
        type="button"
        className="link-button"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy');
          post('/api/account/resend-license')
            .then(() => setState('sent'))
            .catch((cause: Error) => setState(cause.message));
        }}
      >
        Email it to me
      </button>
      {state === 'sent' ? <span className="ok"> · Sent.</span> : state !== 'idle' && state !== 'busy' ? <span className="error"> · {state}</span> : null}
    </p>
  );
}

const PLATFORMS = [
  ['macos', 'Download for Mac'],
  ['windows', 'Download for Windows'],
] as const;

/** The download page's form: the authorization code from the purchase email, no sign-in. */
export function CodeDownload() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (platform: 'macos' | 'windows') => {
    setBusy(platform);
    setError(null);
    try {
      const response = await fetch(`/api/downloads/${platform}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? 'The download could not be prepared');
      window.location.href = body.url;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <label className="field">
        <span>Authorization code</span>
        <input
          className="serial-input"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="VCDIT-XXXXX-XXXXX-XXXXX-XXXXX"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <div className="actions">
        {PLATFORMS.map(([platform, label]) => (
          <button key={platform} type="button" className="button" disabled={busy !== null || !code.trim()} onClick={() => void start(platform)}>
            {busy === platform ? 'Preparing…' : label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function Downloads() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (platform: 'macos' | 'windows') => {
    setBusy(platform);
    setError(null);
    try {
      const response = await fetch(`/api/downloads/${platform}`);
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? 'The download could not be prepared');
      window.location.href = body.url;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="actions">
        <button type="button" className="button" disabled={busy !== null} onClick={() => void start('macos')}>
          {busy === 'macos' ? 'Preparing…' : 'Download for Mac'}
        </button>
        <button type="button" className="button" disabled={busy !== null} onClick={() => void start('windows')}>
          {busy === 'windows' ? 'Preparing…' : 'Download for Windows'}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

interface Device {
  id: string;
  name: string;
  platform: 'windows' | 'macos';
  appVersion: string;
  activatedAt: string;
  lastSeenAt: string | null;
  deactivatedAt: string | null;
}

export function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    fetch('/api/licenses/devices')
      .then((response) => response.json() as Promise<{ devices?: Device[]; error?: string }>)
      .then((body) => (body.devices ? setDevices(body.devices) : setError(body.error ?? 'Could not load your computers')))
      .catch(() => setError('Could not load your computers'));
  useEffect(() => {
    void load();
  }, []);
  const free = async (id: string) => {
    if (!window.confirm('Free this seat? That computer cannot start new ingests or deliveries until it is activated again.')) return;
    const response = await fetch('/api/licenses/devices', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activationId: id }),
    });
    if (!response.ok) setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not free it');
    void load();
  };
  if (error) return <p className="error">{error}</p>;
  if (!devices) return <p className="muted">Loading…</p>;
  if (devices.length === 0) return <p className="muted">No computers yet. Install the app and enter your authorization code to activate one.</p>;
  return (
    <table className="list">
      <thead>
        <tr>
          <th>Computer</th>
          <th>Status</th>
          <th>Last seen</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {devices.map((device) => (
          <tr key={device.id}>
            <td>
              {device.name || 'Unnamed computer'} <span className="muted">· {device.platform === 'macos' ? 'Mac' : 'Windows'}</span>
              {device.appVersion ? <div className="muted">Version {device.appVersion}</div> : null}
            </td>
            <td>{device.deactivatedAt ? <span className="badge">Freed</span> : <span className="badge active">Active</span>}</td>
            <td>{new Date(device.lastSeenAt ?? device.activatedAt).toLocaleDateString()}</td>
            <td>
              {device.deactivatedAt ? null : (
                <button type="button" className="link-button" onClick={() => void free(device.id)}>
                  Free this seat
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
