import { useCallback, useEffect, useState } from 'react';
import type { MissingCopies } from '../../shared/media';
import { projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { StatusText, statusVar, tone } from './kit';

/**
 * Copies not where they were written: a drive back under a new letter or
 * name, a production folder someone moved. Find… asks where it is now, and
 * VC DIT proves each card's copy there (every file at its size, one read
 * back to its checksum) before pointing the production at it.
 */
export function MissingCopiesPanel() {
  const { state } = useStore();
  const api = state.project ? projectApi() : null;
  const [missing, setMissing] = useState<MissingCopies[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (api) setMissing(await api.relinkScan());
  }, [api]);
  useEffect(() => void scan(), [scan, state.project?.file, state.jobs.length]);

  if (!api || missing.length === 0) return said ? <p className="muted small" role="status">{said}</p> : null;

  const find = async (drive: MissingCopies) => {
    setBusy(drive.name);
    const result = await api.relink(drive.name, drive.root);
    setBusy(null);
    if (!result.ok) {
      if (result.reason) setSaid(result.reason);
      return;
    }
    setSaid(
      result.found === 0
        ? `None of ${drive.name}'s copies were found in ${result.place}. Pick the drive itself, or the folder its media was moved to.`
        : `${result.found} cop${result.found === 1 ? 'y' : 'ies'} of ${drive.name} found in ${result.place} and checked.${result.missing.length ? ` Still not found: ${result.missing.join(', ')}.` : ''}`,
    );
    await scan();
  };

  return (
    <section className="card relink-card" aria-label="Copies not where they were" style={tone(statusVar('needs'))}>
      <StatusText status="needs" word="Copies not where they were" />
      <p className="muted small">
        These drives' card folders are not at the place they were written to: a drive back under a new name or letter, or a folder that was moved. Point VC DIT at where
        they are now; each card's copy is checked before anything changes.
      </p>
      <ul className="relink-list">
        {missing.map((drive) => (
          <li key={`${drive.name}|${drive.root}`} className="row" style={{ gap: 10 }}>
            <span className="grow">
              <span className="strong mono">{drive.name}</span>
              <span className="muted small">
                {' '}
                · was {drive.root} · {drive.copies} card cop{drive.copies === 1 ? 'y' : 'ies'} ({drive.cards.slice(0, 6).join(', ')}
                {drive.cards.length > 6 ? '…' : ''}) · day{drive.days.length === 1 ? '' : 's'} {drive.days.join(', ')}
              </span>
            </span>
            <button type="button" className="btn small" disabled={busy !== null} onClick={() => void find(drive)}>
              {busy === drive.name ? 'Checking…' : 'Find…'}
            </button>
          </li>
        ))}
      </ul>
      {said ? (
        <p className="small" role="status">
          {said}
        </p>
      ) : null}
    </section>
  );
}
