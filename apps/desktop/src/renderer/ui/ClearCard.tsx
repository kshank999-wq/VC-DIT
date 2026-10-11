import { useEffect, useRef, useState } from 'react';
import { formatBytes, type ClearCheck } from '../../shared/media';
import { jobState, legState } from '../model/status';
import type { TransferJob, Volume } from '../model/types';
import { engine } from '../state/engine';
import { useStore, type AppState } from '../state/store';
import { StatusText } from './kit';

/**
 * Clearing a card so it can go back to camera (spec §8, as amended). Three
 * steps, none skippable:
 *
 * 1. A fresh check: the card holds exactly what was copied, and every copy
 *    the production relies on verified and is still there now.
 * 2. "All of this is backed up. Clear the card?"
 * 3. "Are you sure? This erases …": yes, clear it.
 *
 * The engine checks once more just before it erases anything, and erases
 * only the files that were ingested. Formatting is left to the camera.
 */

/** The mounted volume a card's transfer came from, if it is still plugged in. */
export const volumeOfJob = (state: AppState, job: TransferJob): Volume | undefined =>
  state.volumes.find((volume) => (job.sourceId ? volume.id === job.sourceId && volume.name === (job.card ?? job.id) : volume.name === job.id) && (volume.role === 'Camera' || volume.role === 'Sound'));

/** The newest transfer of a mounted card. */
export const jobOfVolume = (state: AppState, volume: Volume): TransferJob | undefined =>
  [...state.jobs].reverse().find((job) => (job.sourceId ? job.sourceId === volume.id && (job.card ?? job.id) === volume.name : job.id === volume.name));

/** Where a card stands for clearing: still copying, safe to clear (and plugged in), cleared, or a problem. */
export type CardStage = 'copying' | 'waiting' | 'eject' | 'safe' | 'problem' | 'cleared';
export const cardStage = (state: AppState, job: TransferJob): CardStage => {
  if (job.clearedAt) return 'cleared';
  const now = jobState(job, state.production.formatRule);
  return now === 'running' ? 'copying' : now;
};

/** "RAID", "RAID and SHTL", "RAID, SHTL and NAS". */
const names = (list: string[]) => (list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** The preview has no engine: a stand-in check from what the screens know. */
const demoCheck = (state: AppState, job: TransferJob): ClearCheck => {
  const counted = state.production.formatRule === 'every' ? job.legs : job.legs.filter((leg) => !leg.relay);
  const files = Number(job.files.replace(/\D/g, '')) || 0;
  return {
    ok: counted.every((leg) => legState(leg) === 'verified'),
    card: job.card ?? job.id,
    files,
    bytes: 0,
    copies: counted.map((leg) => ({ name: leg.name, ok: legState(leg) === 'verified', problem: legState(leg) === 'verified' ? null : 'Not verified.', files })),
    problems: [],
    checkedAt: new Date().toISOString(),
  };
};

export function ClearCardDialog({ job, onClose }: { job: TransferJob; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const media = state.engine ? engine() : null;
  const card = job.card ?? job.id;
  const [step, setStep] = useState<'checking' | 'checked' | 'confirm' | 'clearing' | 'done' | 'failed'>('checking');
  const [check, setCheck] = useState<ClearCheck | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [removed, setRemoved] = useState(0);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && step !== 'clearing' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step]);

  // Step 1: the fresh check.
  useEffect(() => {
    void (async () => {
      const found = media ? await media.checkClear(job.id, state.production.formatRule) : demoCheck(state, job);
      if (!live.current) return;
      if ('copies' in found) setCheck(found);
      setProblems(found.problems);
      setStep('checked');
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = async () => {
    setStep('clearing');
    if (!media) {
      dispatch({ type: 'cardCleared', job: job.id, at: new Date().toISOString() });
      setRemoved(check?.files ?? 0);
      setStep('done');
      return;
    }
    const result = await media.clearCard(job.id, state.production.formatRule);
    if (!live.current) return;
    if (result.ok) {
      setRemoved(result.removed);
      setStep('done');
    } else {
      setProblems([result.reason]);
      setStep('failed');
    }
  };

  const ok = step !== 'checking' && check?.ok === true && problems.length === 0;
  const mounted = volumeOfJob(state, job);
  return (
    <div className="dialog-backdrop" onClick={step === 'clearing' ? undefined : onClose}>
      <div className="dialog clear-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-title" onClick={(event) => event.stopPropagation()}>
        {step === 'confirm' ? (
          <>
            <h2 id="clear-title">Are you sure?</h2>
            <p>
              This permanently erases the <strong>{check!.files.toLocaleString('en-US')} files</strong>
              {check!.bytes ? ` (${formatBytes(check!.bytes)})` : ''} on <strong className="mono">{card}</strong>. They stay on {names(check!.copies.map((copy) => copy.name))}.
            </p>
            <p className="muted small">VC DIT checks everything once more before it erases anything. Format the card in the camera before shooting on it again.</p>
            <div className="row clear-actions">
              <button type="button" className="btn" autoFocus onClick={onClose}>
                No, keep it
              </button>
              <button type="button" className="btn danger" onClick={() => void clear()}>
                Yes, clear {card}
              </button>
            </div>
          </>
        ) : step === 'clearing' ? (
          <>
            <h2 id="clear-title">Clearing {card}…</h2>
            <p className="muted">Checking the copies once more, then erasing. Leave the card in.</p>
          </>
        ) : step === 'done' ? (
          <>
            <h2 id="clear-title">{card} is clear</h2>
            <p>
              {removed.toLocaleString('en-US')} files erased. Eject it and give it back to camera; they should format it in the camera before shooting on it.
            </p>
            <p className="muted small">A note of it was written beside the transfer log on each copy.</p>
            <div className="row clear-actions">
              <button type="button" className="btn" onClick={onClose}>
                Done
              </button>
              {mounted ? <EjectButton volume={mounted} primary onEjected={onClose} /> : <span className="muted small">Ejected. It can come out.</span>}
            </div>
          </>
        ) : (
          <>
            <h2 id="clear-title">{step === 'failed' ? `${card} was not cleared` : `Clear ${card} for camera?`}</h2>
            {step === 'checking' ? (
              <p className="muted" role="status">
                Checking that everything on {card} is backed up…
              </p>
            ) : (
              <>
                {check ? (
                  <ul className="clear-check" aria-label="What was checked">
                    <li>
                      {check.problems.some((problem) => /on the card|cannot be read/.test(problem)) ? <StatusText status="problem" word="Problem" /> : <StatusText status="done" word="OK" />}
                      <span>
                        On the card: {check.files.toLocaleString('en-US')} files{check.bytes ? ` · ${formatBytes(check.bytes)}` : ''}, exactly what was copied
                      </span>
                    </li>
                    {check.copies.map((copy) => (
                      <li key={copy.name}>
                        {copy.ok ? <StatusText status="done" word="OK" /> : <StatusText status="problem" word="Problem" />}
                        <span>
                          <span className="mono">{copy.name}</span>: {copy.ok ? `all ${copy.files.toLocaleString('en-US')} verified copies there now` : copy.problem}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {problems.length ? (
                  <div className="clear-problems" role="alert">
                    {problems.map((problem) => (
                      <p key={problem}>{problem}</p>
                    ))}
                  </div>
                ) : null}
                {ok && step === 'checked' ? <p>All of this is backed up. Clear the card so it can go back to camera?</p> : null}
              </>
            )}
            <div className="row clear-actions">
              <button type="button" className="btn" onClick={onClose}>
                {ok ? 'Cancel' : 'Close'}
              </button>
              {ok && step === 'checked' ? (
                <button type="button" className="btn danger" onClick={() => setStep('confirm')}>
                  Clear {card}…
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Says so, once, when a card that is still plugged in becomes safe to clear:
 * a notice in the app (with the button), and the system's notification when
 * the window is in the background.
 */
export function SafeToClearNotices() {
  const { state } = useStore();
  const [shown, setShown] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [clearing, setClearing] = useState<TransferJob | null>(null);
  const seenSafe = useRef<Set<string> | null>(null);

  const ready = state.jobs.filter((job) => cardStage(state, job) === 'safe' && volumeOfJob(state, job));
  useEffect(() => {
    // What was already safe when the app opened is not news.
    if (seenSafe.current === null) {
      seenSafe.current = new Set(ready.map((job) => job.id));
      return;
    }
    const fresh = ready.filter((job) => !seenSafe.current!.has(job.id));
    if (!fresh.length) return;
    for (const job of fresh) seenSafe.current.add(job.id);
    setShown((before) => [...before, ...fresh.map((job) => job.id)]);
    if (typeof document !== 'undefined' && !document.hasFocus() && typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
      for (const job of fresh) {
        try {
          new Notification(`${job.card ?? job.id} is safe to clear`, { body: `Verified on ${names(job.legs.filter((leg) => !leg.relay).map((leg) => leg.name))}. Give it back to camera when you're ready.` });
        } catch {
          // No system notifications here: the notice in the app still shows.
        }
      }
    }
  }, [ready.map((job) => job.id).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = ready.filter((job) => shown.includes(job.id) && !dismissed.includes(job.id));
  return (
    <>
      {visible.length ? (
        <div className="clear-notices" aria-live="polite">
          {visible.map((job) => (
            <div key={job.id} className="clear-notice" role="status">
              <StatusText status="done" word={`${job.card ?? job.id} is safe to clear`} />
              <span className="muted small">Verified on {names(job.legs.filter((leg) => !leg.relay).map((leg) => leg.name))}</span>
              <span className="grow" />
              <button type="button" className="btn small" onClick={() => setClearing(job)}>
                Clear card…
              </button>
              <button type="button" className="btn ghost small" aria-label={`Dismiss the notice for ${job.card ?? job.id}`} onClick={() => setDismissed([...dismissed, job.id])}>
                Later
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {clearing ? (
        <ClearCardDialog
          job={clearing}
          onClose={() => {
            setDismissed((before) => [...before, clearing.id]);
            setClearing(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Eject a card, as Finder or Explorer would, so it can be pulled out and
 * handed back. Says so if another app is holding it.
 */
export function EjectButton({ volume, primary = false, onEjected }: { volume: Volume; primary?: boolean; onEjected?: () => void }) {
  const { state, dispatch } = useStore();
  const media = state.engine ? engine() : null;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const eject = async () => {
    setBusy(true);
    setProblem(null);
    const result = media ? await media.eject(volume.id) : { ok: true };
    setBusy(false);
    if (!result.ok) {
      setProblem(result.reason ?? `${volume.name} was not ejected.`);
      return;
    }
    if (!media) dispatch({ type: 'volumeEjected', volume: volume.id });
    onEjected?.();
  };
  return (
    <>
      <button type="button" className={`btn small${primary ? ' primary' : ''}`} disabled={busy} onClick={() => void eject()} title="Eject it, so it can be pulled out safely">
        {busy ? 'Ejecting…' : `⏏ Eject ${volume.name}`}
      </button>
      {problem ? (
        <span className="eject-problem small" role="alert">
          {problem}
        </span>
      ) : null}
    </>
  );
}

export const clearedWord = (job: TransferJob) => (job.clearedAt ? `Cleared ${time(job.clearedAt)}` : '');
