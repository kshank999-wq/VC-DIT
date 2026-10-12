import { useState } from 'react';
import { projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { StatusText } from './kit';

/**
 * The scene folders read back on every destination (uploads included):
 * how many clips are in their take's folder as the card's own data, per
 * drive, and what is not, with a way to look again and to put it back.
 */
export function FolderCheck() {
  const { state, dispatch } = useStore();
  const api = state.project ? projectApi() : null;
  const check = state.organize?.check ?? null;
  const [busy, setBusy] = useState(false);
  const act = async (call: () => Promise<{ ok: boolean; state?: unknown }>) => {
    setBusy(true);
    const result = await call();
    setBusy(false);
    if (result.ok && result.state) dispatch({ type: 'projectState', project: result.state as never });
  };
  if (!api) return null;
  return (
    <section className="card folder-check" aria-label="Scene folders on every drive">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="strong">Scene folders on every drive</span>
        <span className="row" style={{ gap: 6 }}>
          {check?.total ? (
            <button type="button" className="btn small primary" disabled={busy} onClick={() => void act(() => api.repairSceneFolders())}>
              Put back {check.total}
            </button>
          ) : null}
          <button type="button" className="btn small" disabled={busy} onClick={() => void act(() => api.checkSceneFolders())}>
            {busy ? 'Checking…' : 'Check again'}
          </button>
        </span>
      </div>
      {!check ? (
        <p className="muted small">Checked after every change, once clips are placed.</p>
      ) : (
        <>
          <ul className="folder-check-drives">
            {check.destinations.map((drive) => (
              <li key={drive.destination}>
                <StatusText status={drive.ok === drive.clips ? 'done' : 'problem'} word={drive.destination} />
                <span className="mono small">
                  {drive.ok}/{drive.clips} in place
                </span>
              </li>
            ))}
          </ul>
          {check.total ? (
            <div className="folder-check-findings" role="alert">
              {check.findings.map((finding) => (
                <p key={`${finding.clip}|${finding.destination}|${finding.folder}`} className="small">
                  <span className="mono">{finding.clip}</span> on {finding.destination}: {finding.problem}. <span className="muted">{finding.detail}</span>
                </p>
              ))}
              {check.total > check.findings.length ? <p className="small muted">…and {check.total - check.findings.length} more.</p> : null}
            </div>
          ) : (
            <p className="small muted">
              Every clip is in its scene, setup and take folder on every drive, as the card's own data. Checked {new Date(check.checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
