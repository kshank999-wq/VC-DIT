import { useEffect, useState } from 'react';
import { legState } from '../model/status';
import type { Volume } from '../model/types';
import { engine } from '../state/engine';
import { DESTINATION_ROLES, SOURCE_ROLES, useStore, type AppState } from '../state/store';
import { cardBackedUp, cardStage, jobOfVolume } from './ClearCard';
import { Check, StatusText } from './kit';

/**
 * Eject several cards and drives at once, at a card change or at wrap. It
 * lists what is plugged in and says what each is: cleared and safe cards,
 * shuttles and archives are ticked; a card not yet copied and the main
 * backup are listed but not ticked; anything being copied is not offered.
 * Each is ejected in turn and says how it went.
 */

type Row = { volume: Volume; note: string; ticked: boolean; busy: boolean };

const rowsOf = (state: AppState): Row[] =>
  state.volumes
    .filter((volume) => SOURCE_ROLES.includes(volume.role) || DESTINATION_ROLES.includes(volume.role))
    .map((volume) => {
      if (SOURCE_ROLES.includes(volume.role)) {
        const job = jobOfVolume(state, volume);
        const stage = job ? cardStage(state, job) : null;
        if (stage === 'copying' || stage === 'waiting') return { volume, note: 'Being copied', ticked: false, busy: true };
        // Not backed up on at least one drive: it stays in.
        if (!cardBackedUp(job)) return { volume, note: stage === null ? 'Not backed up · stays in' : 'Not fully backed up · stays in', ticked: false, busy: true };
        const note = stage ? { cleared: 'Cleared', safe: 'Safe to clear', eject: 'Copied · not safe to clear yet', problem: 'A copy failed' }[stage] : null;
        return { volume, note: note ?? '', ticked: true, busy: false };
      }
      const legs = state.jobs.flatMap((job) => job.legs.filter((leg) => leg.id === volume.id));
      // Safeguard: a drive leaves only with every card copied to it verified there.
      if (legs.some((leg) => leg.failed)) return { volume, note: 'A copy failed · stays in', ticked: false, busy: true };
      if (legs.some((leg) => legState(leg) === 'copying' || legState(leg) === 'checking')) return { volume, note: 'Being copied to', ticked: false, busy: true };
      if (legs.some((leg) => legState(leg) === 'waiting')) return { volume, note: 'Still to copy · stays in', ticked: false, busy: true };
      if (volume.role === 'Destination') return { volume, note: 'Main backup', ticked: false, busy: false };
      return { volume, note: volume.role === 'Shuttle' ? 'Shuttle' : 'Archive', ticked: true, busy: false };
    });

export function EjectAllButton() {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const count = rowsOf(state).length;
  if (!count) return null;
  return (
    <>
      <button type="button" className="btn small" onClick={() => setOpen(true)} title="Eject several cards and drives at once">
        ⏏ Eject all…
      </button>
      {open ? <EjectAllDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function EjectAllDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const media = state.engine ? engine() : null;
  // The list as it was when opened, so drives leaving it as they eject still show how they went.
  const [rows] = useState(() => rowsOf(state));
  const [picked, setPicked] = useState(() => rows.filter((row) => row.ticked && !row.busy).map((row) => row.volume.id));
  const [results, setResults] = useState<Record<string, { ok: boolean; reason?: string } | 'ejecting'>>({});
  const [running, setRunning] = useState(false);
  const done = !running && Object.keys(results).length > 0;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !running && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, running]);

  const ejectAll = async () => {
    setRunning(true);
    for (const id of picked) {
      setResults((before) => ({ ...before, [id]: 'ejecting' }));
      const result = media ? await media.eject(id) : { ok: true };
      if (result.ok && !media) dispatch({ type: 'volumeEjected', volume: id });
      setResults((before) => ({ ...before, [id]: result }));
    }
    setRunning(false);
  };

  const failed = Object.values(results).filter((result) => result !== 'ejecting' && !result.ok).length;
  return (
    <div className="dialog-backdrop" onClick={running ? undefined : onClose}>
      <div className="dialog eject-all" role="dialog" aria-modal="true" aria-labelledby="eject-all-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="eject-all-title">Eject cards and drives</h2>
        <ul className="eject-list" aria-label="Plugged in">
          {rows.map((row) => {
            const result = results[row.volume.id];
            return (
              <li key={row.volume.id}>
                <Check
                  checked={picked.includes(row.volume.id)}
                  disabled={row.busy || running || done}
                  onChange={() => setPicked(picked.includes(row.volume.id) ? picked.filter((id) => id !== row.volume.id) : [...picked, row.volume.id])}
                  label={`Eject ${row.volume.name}`}
                />
                <span className="mono">{row.volume.name}</span>
                <span className="muted small grow">{row.note}</span>
                {result === 'ejecting' ? (
                  <StatusText status="working" word="Ejecting…" />
                ) : result?.ok ? (
                  <StatusText status="done" word="Ejected" />
                ) : result ? (
                  <span className="eject-problem small">{result.reason}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="muted small">A card stays in until everything on it has verified on at least one drive; a shuttle stays in until every card copied to it has verified there. The main backup is not ticked unless you tick it.</p>
        <div className="row clear-actions">
          {done ? (
            <>
              {failed ? <span className="muted small grow">{failed} could not be ejected; the reason is beside each.</span> : null}
              <button type="button" className="btn primary" autoFocus onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" disabled={running} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={running || picked.length === 0} onClick={() => void ejectAll()}>
                {running ? 'Ejecting…' : `⏏ Eject ${picked.length}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
