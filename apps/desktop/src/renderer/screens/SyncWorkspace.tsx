import type { Status, SyncItem } from '../model/types';
import { useStore } from '../state/store';
import { Chip, ScreenHeader, statusVar } from '../ui/kit';
import './output.css';

/**
 * Audio Sync: pair each take's picture with its production sound. Timecode
 * first, waveform as the fallback, a manual frame nudge for the exceptions
 * (spec §4.6). Nothing here touches the camera or sound originals; the sync
 * relationship is stored as metadata.
 */

const FPS = 24;
/** Pixels the sound row moves per frame of offset, so a nudge is visible. */
const PX_PER_FRAME = 5;

/** The prototype's deterministic stand-in for decoded audio. */
const wave = (seed: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => {
    const x = Math.abs(Math.sin(i * 0.37 + seed) * Math.sin(i * 0.11 + seed * 2) + Math.sin(i * 1.7) * 0.25);
    return Math.max(3, Math.round(x * 50));
  });
const BARS = wave(1, 160);

export const formatOffset = (frames: number) => `${frames > 0 ? '+' : frames < 0 ? '−' : '±'}${Math.abs(frames)} fr`;

const confidenceStatus = (confidence: number): Status => (confidence >= 90 ? 'done' : confidence >= 50 ? 'needs' : 'problem');
const confidenceText = (confidence: number) => (confidence > 0 ? `${confidence}%` : '—');

const syncChip = (item: SyncItem) => {
  if (item.accepted) return <Chip color={statusVar('done')}>Synced</Chip>;
  if (item.method === 'None') return <Chip color={statusVar('problem')}>No sound</Chip>;
  if (item.confidence === 0) return <Chip color={statusVar('problem')}>No TC</Chip>;
  return <Chip color={statusVar('needs')}>Review</Chip>;
};

/** Loudness bars: the clip's own (0–100) when the engine has drawn them, the sample shape otherwise. */
function Waveform({ label, color, shift, levels }: { label: string; color: string; shift: number; levels?: number[] }) {
  const heights = levels ? levels.map((level) => Math.max(2, Math.round(level / 2))) : BARS;
  return (
    <>
      <span className="label">{label}</span>
      {heights.length ? (
        <div className="wave" style={{ transform: `translateX(${shift}px)` }} aria-hidden="true">
          {heights.map((height, index) => (
            <span key={index} style={{ height, background: color }} />
          ))}
        </div>
      ) : (
        <div className="wave wave-empty muted">No audio to draw</div>
      )}
    </>
  );
}

const rateText = (fps: number | null | undefined) => (fps ? `${Number.isInteger(fps) ? fps : fps.toFixed(3)} fps` : `${FPS} fps`);

export function SyncWorkspace() {
  const { state, dispatch } = useStore();
  const real = state.project !== null;
  const selected = state.sync[state.selectedSync] ?? state.sync[0];
  const toReview = state.sync.filter((item) => !item.accepted).length;
  const exceptions = state.sync.filter((item) => !item.accepted && item.confidence < 50).length;
  // The sample day batches Scene 14; a real day accepts everything at 90% or more.
  const batchScene = real ? '' : '14';
  const batchable = state.sync.filter((item) => item.take.startsWith(batchScene) && !item.accepted && item.confidence >= 90).length;
  const header = (
    <ScreenHeaderSync
      toReview={toReview}
      exceptions={exceptions}
      batchable={batchable}
      batchLabel={real ? (batchable ? `Accept ${batchable} at 90%+` : 'Accept all at 90%+') : 'Batch sync Scene 14'}
      busy={Boolean(state.syncActivity)}
      onWaveform={() => dispatch({ type: 'waveformPass' })}
      onBatch={() => dispatch({ type: 'batchSync', scene: batchScene })}
    />
  );

  if (!selected) {
    return (
      <div className="screen out">
        {header}
        <p className="muted" role="status">
          {state.syncActivity ?? 'No camera clips today yet. Each clip is paired with its sound here as its card comes in.'}
        </p>
      </div>
    );
  }

  return (
    <div className="screen out">
      {header}
      {state.syncActivity ? (
        <p className="muted sync-activity" role="status">
          {state.syncActivity}
        </p>
      ) : null}

      <section className="card sync-top" aria-label={`Sync for ${selected.take}`}>
        <div className="row sync-title">
          <span className="mono sync-take">{selected.take}</span>
          <span className="mono muted">
            {selected.clip} ⟷ {selected.sound}
          </span>
          <span className="grow" />
          <span className="muted">Method</span>
          <span className="mono strong">{selected.method}</span>
          <span className="muted">Confidence</span>
          <span className="mono strong" style={{ color: statusVar(confidenceStatus(selected.confidence)) }}>
            {confidenceText(selected.confidence)}
          </span>
        </div>
        {selected.why ? <p className="muted sync-why">{selected.why}</p> : null}

        <div className="wave-compare">
          <div className="playhead" aria-hidden="true" />
          <Waveform label="Camera scratch" color="var(--st-intake)" shift={0} levels={real ? (selected.barsPicture ?? []) : undefined} />
          <Waveform
            label={real ? `Production sound · ${selected.sound}` : 'Production sound · 888 TRK 1 (Boom)'}
            color="var(--s-done)"
            shift={selected.offsetFrames * PX_PER_FRAME}
            levels={real ? (selected.barsSound ?? []) : undefined}
          />
        </div>

        <div className="row">
          <span className="muted">Offset</span>
          <button
            type="button"
            className="btn nudge mono"
            aria-label="Nudge sound one frame earlier"
            disabled={selected.method === 'None'}
            onClick={() => dispatch({ type: 'nudgeSync', frames: -1 })}
          >
            −
          </button>
          <span className="mono offset" aria-live="polite">
            {formatOffset(selected.offsetFrames)}
          </span>
          <button
            type="button"
            className="btn nudge mono"
            aria-label="Nudge sound one frame later"
            disabled={selected.method === 'None'}
            onClick={() => dispatch({ type: 'nudgeSync', frames: 1 })}
          >
            +
          </button>
          <span className="faint">1 frame @ {rateText(selected.fps)}</span>
          <span className="grow" />
          <button type="button" className="btn primary" disabled={selected.accepted || selected.method === 'None'} onClick={() => dispatch({ type: 'acceptSync' })}>
            {selected.accepted ? 'Accepted' : 'Accept sync'}
          </button>
        </div>
      </section>

      <div className="card table-card">
        <table className="grid mono sync-table">
          <thead>
            <tr>
              <th className="label">Take</th>
              <th className="label">Picture</th>
              <th className="label">Sound</th>
              <th className="label">Method</th>
              <th className="label">Offset</th>
              <th className="label">Conf.</th>
              <th className="label">Status</th>
            </tr>
          </thead>
          <tbody>
            {state.sync.map((item, index) => (
              <tr
                key={item.id ?? item.take}
                className="clickable"
                aria-selected={index === state.selectedSync}
                tabIndex={0}
                onClick={() => dispatch({ type: 'selectSync', index })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    dispatch({ type: 'selectSync', index });
                  }
                }}
              >
                <td className="strong">{item.take}</td>
                <td>{item.clip}</td>
                <td className="muted">{item.sound}</td>
                <td>{item.method}</td>
                <td>{item.method === 'None' ? '—' : formatOffset(item.offsetFrames)}</td>
                <td style={{ color: statusVar(confidenceStatus(item.confidence)) }}>{confidenceText(item.confidence)}</td>
                <td>{syncChip(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScreenHeaderSync({
  toReview,
  exceptions,
  batchable,
  batchLabel,
  busy,
  onWaveform,
  onBatch,
}: {
  toReview: number;
  exceptions: number;
  batchable: number;
  batchLabel: string;
  busy: boolean;
  onWaveform: () => void;
  onBatch: () => void;
}) {
  return (
    <ScreenHeader
      step="sync"
      eyebrow="05 · Audio Sync"
      title="Picture / sound sync"
      description={
        <>
          Timecode first, waveform fallback, manual for exceptions. Sources stay untouched — sync is stored as metadata.{' '}
          <strong className="review-count" style={{ color: statusVar(toReview > 0 ? 'needs' : 'done') }}>
            {toReview > 0 ? `${toReview} take${toReview === 1 ? '' : 's'} still need${toReview === 1 ? 's' : ''} review.` : 'Every take is in sync.'}
          </strong>
        </>
      }
      actions={
        <>
          <button
            type="button"
            className="btn tall"
            disabled={exceptions === 0 || busy}
            title={exceptions === 0 ? 'No takes without timecode left to analyse.' : 'Compares each one\'s scratch audio with nearby sound files.'}
            onClick={onWaveform}
          >
            Waveform pass on exceptions
          </button>
          <button
            type="button"
            className="btn primary tall"
            disabled={batchable === 0 || busy}
            title={batchable === 0 ? 'Every take at 90% or more is already synced; the rest need a look.' : 'Accepts every take at 90% confidence or more.'}
            onClick={onBatch}
          >
            {batchLabel}
          </button>
        </>
      }
    />
  );
}
