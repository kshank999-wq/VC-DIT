import { useEffect, useRef, useState } from 'react';
import { formatBytes, type SealOutcome } from '../../shared/media';
import type { DriveSeal } from '../../shared/project';
import type { Volume } from '../model/types';
import { projectApi } from '../state/engine';
import { useStore, type AppState } from '../state/store';

/**
 * Sealing a shuttle or archive drive before it leaves set: every file the
 * production copied to it, on every day, checked against the drive — read
 * back in full when there is time — and a manifest written to it for the
 * other end. Missing or changed files block the seal.
 */

/** A drive's last seal, found by where it is mounted or by its name. */
export const sealOf = (state: AppState, volume: Volume): DriveSeal | undefined =>
  state.seals.find((seal) => (volume.mountPath && seal.root === volume.mountPath) || seal.name === volume.name);

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "Sealed 18:40 · read back" or "Copied to since its seal". */
export const sealWords = (seal: DriveSeal | undefined): string | null =>
  !seal ? null : seal.stale ? `Copied to since its seal at ${time(seal.sealedAt)}` : `Sealed ${time(seal.sealedAt)} · ${seal.verified ? 'read back' : 'sizes checked'}`;

export function SealButton({ volume }: { volume: Volume }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const seal = sealOf(state, volume);
  return (
    <>
      <button type="button" className="btn small" onClick={() => setOpen(true)} title="Check every file copied to it, then write a manifest to it">
        {seal && !seal.stale ? 'Seal again…' : 'Seal…'}
      </button>
      {open && <SealDialog volume={volume} onClose={() => setOpen(false)} />}
    </>
  );
}

type Progress = { files: number; totalFiles: number; bytes: number; totalBytes: number; file: string | null };

export function SealDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const api = projectApi();
  const [verify, setVerify] = useState(true);
  const [step, setStep] = useState<'ask' | 'sealing' | 'sealed' | 'refused'>('ask');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<SealOutcome | null>(null);
  const [reason, setReason] = useState('');
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && step !== 'sealing' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step]);
  useEffect(() => api?.onSealProgress((next) => next.id === volume.id && live.current && setProgress(next)), [api, volume.id]);

  const seal = async () => {
    if (!api) {
      setReason('Sealing a drive needs the desktop app.');
      setStep('refused');
      return;
    }
    setStep('sealing');
    const result = await api.seal(volume.id, verify);
    if (!live.current) return;
    if (result.ok) {
      setOutcome(result.outcome);
      setStep('sealed');
    } else {
      setOutcome(result.outcome ?? null);
      setReason(result.reason);
      setStep('refused');
    }
  };

  const pct = progress && progress.totalBytes ? Math.round((progress.bytes / progress.totalBytes) * 100) : 0;
  return (
    <div className="dialog-backdrop" onClick={step === 'sealing' ? undefined : onClose}>
      <div className="dialog clear-dialog" role="dialog" aria-modal="true" aria-labelledby="seal-title" onClick={(event) => event.stopPropagation()}>
        {step === 'ask' ? (
          <>
            <h2 id="seal-title">Seal {volume.name}</h2>
            <p>
              VC DIT checks every file this production copied to {volume.name}, on every day, against what is on it now. If nothing is missing or changed it writes a
              manifest of every file and its checksum to the drive, in the production's SEALS folder.
            </p>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={verify} onChange={(event) => setVerify(event.target.checked)} />
              Read every file back and compare its checksum (slower: the whole drive is read)
            </label>
            <p className="muted small">Nothing is copied to it and it cannot be ejected while it is being sealed.</p>
            <div className="row clear-actions">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn primary" autoFocus onClick={() => void seal()}>
                Seal {volume.name}
              </button>
            </div>
          </>
        ) : step === 'sealing' ? (
          <>
            <h2 id="seal-title">Sealing {volume.name}…</h2>
            <p className="muted">
              {progress
                ? `${progress.files.toLocaleString('en-US')} of ${progress.totalFiles.toLocaleString('en-US')} files · ${formatBytes(progress.bytes)} of ${formatBytes(progress.totalBytes)} (${pct}%)`
                : 'Reading the drive…'}
            </p>
            {progress?.file && <p className="muted small mono">{progress.file}</p>}
            <div className="row clear-actions">
              <button type="button" className="btn" onClick={() => void api?.stopSeal()}>
                Stop
              </button>
            </div>
          </>
        ) : step === 'sealed' && outcome ? (
          <>
            <h2 id="seal-title">{volume.name} is sealed</h2>
            <p>
              {outcome.files.toLocaleString('en-US')} files ({formatBytes(outcome.bytes)}) {outcome.verified ? 'read back and matched their checksums' : 'present at the size they were copied'}. The manifest is on
              the drive.
            </p>
            {outcome.unhashed > 0 && <p className="muted small">{outcome.unhashed.toLocaleString('en-US')} had no checksum recorded, so only their size was checked.</p>}
            {outcome.added.length > 0 && (
              <p className="muted small">
                {outcome.added.length.toLocaleString('en-US')} file{outcome.added.length === 1 ? '' : 's'} in its card folders {outcome.added.length === 1 ? 'is' : 'are'} not from this production (e.g.{' '}
                <span className="mono">{outcome.added[0]}</span>). They are listed in the seal, not checked.
              </p>
            )}
            <div className="row clear-actions">
              <button type="button" className="btn primary" autoFocus onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="seal-title">{volume.name} was not sealed</h2>
            <p role="alert">{reason}</p>
            {outcome && (outcome.missing.length > 0 || outcome.changed.length > 0) && (
              <ul className="muted small mono" style={{ margin: 0, maxHeight: 160, overflow: 'auto' }}>
                {outcome.missing.slice(0, 20).map((path) => (
                  <li key={`m${path}`}>missing · {path}</li>
                ))}
                {outcome.changed.slice(0, 20).map((item) => (
                  <li key={`c${item.path}`}>
                    changed · {item.path}: {item.why}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">Copy the cards to it again from the main backup (Verify → Retry), then seal it.</p>
            <div className="row clear-actions">
              <button type="button" className="btn" autoFocus onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
