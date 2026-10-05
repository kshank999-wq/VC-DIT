import { useEffect, useState } from 'react';
import { SCREENS } from './screens';

/**
 * The app shell: the spec's screens down the side, the license in the corner.
 * Every screen is a placeholder until the UI mockup is handed off.
 */

const DEV_ACCESS: Access = {
  plan: 'dit',
  state: 'not-configured',
  email: null,
  serial: null,
  paidThrough: null,
  validUntil: null,
  message: null,
};

const useAccess = (): Access => {
  const host = window.vcdit?.license;
  const [access, setAccess] = useState<Access>(() => host?.now() ?? DEV_ACCESS);
  useEffect(() => host?.onChange(setAccess), [host]);
  return access;
};

const date = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : '—');

export function LicenseBadge({ access }: { access: Access }) {
  const label =
    access.state === 'licensed'
      ? 'Licensed'
      : access.state === 'not-configured'
        ? 'Developer build'
        : access.state === 'expired-offline'
          ? 'Offline too long'
          : 'Not activated';
  return <span className={`badge ${access.plan === 'none' ? 'warn' : 'ok'}`}>{label}</span>;
}

/** Activation: the authorization code from the purchase email. */
export function Activate({ access }: { access: Access }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const host = window.vcdit?.license;
  return (
    <form
      className="activate"
      onSubmit={(event) => {
        event.preventDefault();
        if (!host) return;
        setBusy(true);
        void host.activate(code).finally(() => setBusy(false));
      }}
    >
      <h2>{access.state === 'expired-offline' ? 'Reconnect to keep working' : 'Activate VC DIT'}</h2>
      <p className="muted">
        {access.state === 'expired-offline'
          ? 'This computer has been offline for more than 14 days. Connect to the internet and check again, or re-enter your code.'
          : 'Enter the authorization code from your purchase email. Each subscription runs on two computers.'}
      </p>
      <input
        aria-label="Authorization code"
        className="code"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="VCDIT-XXXXX-XXXXX-XXXXX-XXXXX"
        spellCheck={false}
        autoComplete="off"
      />
      <div className="row">
        <button type="submit" disabled={busy || !code.trim() || !host}>
          {busy ? 'Activating…' : 'Activate this computer'}
        </button>
        {access.state === 'expired-offline' ? (
          <button type="button" className="secondary" onClick={() => void host?.refresh()}>
            Check again
          </button>
        ) : null}
        <button type="button" className="link" onClick={() => void host?.open('pricing')}>
          Need a subscription?
        </button>
      </div>
      {access.message ? (
        <p className="error" role="alert">
          {access.message}
        </p>
      ) : null}
    </form>
  );
}

export function App() {
  const access = useAccess();
  const [screenId, setScreenId] = useState(SCREENS[0]!.id);
  const screen = SCREENS.find((candidate) => candidate.id === screenId) ?? SCREENS[0]!;
  const [showLicense, setShowLicense] = useState(false);
  const licensed = access.plan !== 'none';

  return (
    <div className="shell">
      <nav className="side" aria-label="Screens">
        <div className="brand">
          VC <b>DIT</b>
        </div>
        {SCREENS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={candidate.id === screen.id ? 'nav active' : 'nav'}
            aria-current={candidate.id === screen.id ? 'page' : undefined}
            onClick={() => setScreenId(candidate.id)}
          >
            {candidate.name}
          </button>
        ))}
        <div className="side-foot">
          <button type="button" className="link" onClick={() => setShowLicense((open) => !open)}>
            <LicenseBadge access={access} />
          </button>
          <div className="muted small">Version {__APP_VERSION__}</div>
        </div>
      </nav>
      <main className="content">
        {!licensed || showLicense ? (
          licensed ? (
            <section className="license">
              <h2>License</h2>
              <dl>
                <dt>Licensed to</dt>
                <dd>{access.email ?? '—'}</dd>
                <dt>Authorization code</dt>
                <dd className="mono">{access.serial ?? '—'}</dd>
                <dt>Paid through</dt>
                <dd>{date(access.paidThrough)}</dd>
                <dt>Works offline until</dt>
                <dd>{date(access.validUntil)}</dd>
              </dl>
              <div className="row">
                <button type="button" className="secondary" onClick={() => void window.vcdit?.license.open('account')}>
                  Account and computers
                </button>
                {access.state === 'licensed' ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      if (window.confirm('Deactivate this computer? It frees the seat for another one. Your media and productions are untouched.')) {
                        void window.vcdit?.license.deactivate();
                      }
                    }}
                  >
                    Deactivate this computer
                  </button>
                ) : null}
              </div>
            </section>
          ) : (
            <Activate access={access} />
          )
        ) : null}
        <section className="placeholder">
          <h1>{screen.name}</h1>
          <p className="muted">{screen.purpose}</p>
          <p className="note">Placeholder: this screen is built from the UI mockup.</p>
        </section>
      </main>
    </div>
  );
}
