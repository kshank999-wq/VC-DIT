import { useState } from 'react';
import { useAccess } from '../ui/kit';

const date = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : '—');

/**
 * Activation and the license, in a dialog over the app: the authorization
 * code from the purchase email takes one of the subscription's two seats.
 */
export function LicenseDialog({ onClose }: { onClose: () => void }) {
  const access = useAccess();
  const host = window.vcdit?.license;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const licensed = access.plan !== 'none';

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="License" onClick={(event) => event.stopPropagation()}>
        {licensed ? (
          <>
            <h2>{access.state === 'not-configured' ? 'Developer build' : 'VC DIT is activated'}</h2>
            {access.state === 'not-configured' ? (
              <p className="muted">Licensing is switched off in this build, so everything is unlocked.</p>
            ) : (
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
            )}
            <div className="row">
              <button type="button" className="btn" onClick={() => void host?.open('account')} disabled={!host}>
                Account and computers
              </button>
              {access.state === 'licensed' ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (window.confirm('Deactivate this computer? It frees the seat for another one. Your media and productions are untouched.')) {
                      void host?.deactivate();
                    }
                  }}
                >
                  Deactivate this computer
                </button>
              ) : null}
              <span className="grow" />
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form
            className="stack"
            style={{ gap: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!host) return;
              setBusy(true);
              void host.activate(code).finally(() => setBusy(false));
            }}
          >
            <h2>{access.state === 'expired-offline' ? 'Reconnect to keep working' : 'Activate VC DIT'}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {access.state === 'expired-offline'
                ? 'This computer has been offline for more than 14 days. Connect and check again, or re-enter your code.'
                : 'Enter the authorization code from your purchase email. Each subscription runs on two computers. Until then you can look around, but no new ingest or delivery starts.'}
            </p>
            <input
              aria-label="Authorization code"
              className="input code-input"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="VCDIT-XXXXX-XXXXX-XXXXX-XXXXX"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            {access.message ? (
              <p className="error" role="alert" style={{ margin: 0 }}>
                {access.message}
              </p>
            ) : null}
            <div className="row">
              <button type="submit" className="btn primary" disabled={busy || !code.trim() || !host}>
                {busy ? 'Activating…' : 'Activate this computer'}
              </button>
              {access.state === 'expired-offline' ? (
                <button type="button" className="btn" onClick={() => void host?.refresh()}>
                  Check again
                </button>
              ) : null}
              <button type="button" className="link" onClick={() => void host?.open('pricing')}>
                Need a subscription?
              </button>
              <span className="grow" />
              <button type="button" className="btn ghost" onClick={onClose}>
                Later
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
