import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/updates';

/**
 * A newer VC DIT, said once in a corner: its version and what is new, with
 * Download (the site's download page, through the license as always), Later
 * (until tomorrow) and Skip this version. Never in the way of a transfer: it
 * only offers, and installing is the person's to do when the cart is quiet.
 */

const bridge = () => (typeof window !== 'undefined' ? (window.vcdit?.updates ?? null) : null);

/** The update check's state, kept current; null where there is none (the browser preview, a test). */
export const useUpdates = (): UpdateState | null => {
  const updates = bridge();
  const [state, setState] = useState<UpdateState | null>(() => updates?.now() ?? null);
  useEffect(() => updates?.onChange(setState), [updates]);
  return state;
};

/** The first lines of the release notes, short enough for a notice. */
const summary = (notes: string) => {
  const text = notes.trim().split(/\n+/).slice(0, 2).join(' ');
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
};

export function UpdateNotice() {
  const state = useUpdates();
  const updates = bridge();
  if (!state?.showing || !state.available || !updates) return null;
  const { version, notes, minimumOs } = state.available;
  return (
    <div className="update-notice" role="status" aria-live="polite">
      <div className="stack gap-3 grow">
        <span className="strong-500">VC DIT {version} is available</span>
        <span className="muted small">
          You have {state.current}.{notes ? ` ${summary(notes)}` : ''}
          {minimumOs ? ` Needs ${minimumOs} or later.` : ''}
        </span>
      </div>
      <div className="row gap-6 update-actions">
        <button type="button" className="btn primary small" onClick={() => void window.vcdit?.license.open('download')}>
          Download
        </button>
        <button type="button" className="btn ghost small" title="Remind me tomorrow" onClick={() => void updates.dismiss('later')}>
          Later
        </button>
        <button type="button" className="btn ghost small" onClick={() => void updates.dismiss('skip')}>
          Skip this version
        </button>
      </div>
    </div>
  );
}

/** For Preferences: the version, and a check on demand. */
export function UpdateCheck() {
  const state = useUpdates();
  const updates = bridge();
  const [asked, setAsked] = useState(false);
  if (!state || !updates) return null;
  const answer = state.checking
    ? 'Checking…'
    : state.error && asked
      ? state.error
      : state.available
        ? `VC DIT ${state.available.version} is available.`
        : state.checkedAt
          ? 'This is the latest version.'
          : null;
  return (
    <div className="field">
      <span className="label">Version</span>
      <div className="row gap-8 wrap">
        <span className="mono">{state.current}</span>
        <button
          type="button"
          className="btn small"
          disabled={state.checking}
          onClick={() => {
            setAsked(true);
            void updates.check();
          }}
        >
          Check for updates
        </button>
        {state.available ? (
          <button type="button" className="btn primary small" onClick={() => void window.vcdit?.license.open('download')}>
            Download {state.available.version}
          </button>
        ) : null}
      </div>
      {answer ? (
        <span className="muted small" role="status">
          {answer}
        </span>
      ) : null}
    </div>
  );
}
