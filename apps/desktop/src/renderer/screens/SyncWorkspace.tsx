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
  if (item.confidence === 0) return <Chip color={statusVar('problem')}>No TC</Chip>;
  return <Chip color={statusVar('needs')}>Review</Chip>;
};

function Waveform({ label, color, shift }: { label: string; color: string; shift: number }) {
  return (
    <>
      <span className="label">{label}</span>
      <div className="wave" style={{ transform: `translateX(${shift}px)` }} aria-hidden="true">
        {BARS.map((height, index) => (
          <span key={index} style={{ height, background: color }} />
        ))}
      </div>
    </>
  );
}

export function SyncWorkspace() {
  const { state, dispatch } = useStore();
  const selected = state.sync[state.selectedSync] ?? state.sync[0]!;
  const toReview = state.sync.filter((item) => !item.accepted).length;
  const exceptions = state.sync.filter((item) => !item.accepted && item.confidence < 50).length;
  const scene14 = state.sync.filter((item) => item.take.startsWith('14') && !item.accepted && item.confidence >= 90).length;

  return (
    <div className="screen out">
      <ScreenHeaderSync
        toReview={toReview}
        exceptions={exceptions}
        scene14={scene14}
        onWaveform={() => dispatch({ type: 'waveformPass' })}
        onBatch={() => dispatch({ type: 'batchSync', scene: '14' })}
      />

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

        <div className="wave-compare">
          <div className="playhead" aria-hidden="true" />
          <Waveform label="Camera scratch" color="var(--st-intake)" shift={0} />
          <Waveform label="Production sound · 888 TRK 1 (Boom)" color="var(--s-done)" shift={selected.offsetFrames * PX_PER_FRAME} />
        </div>

        <div className="row">
          <span className="muted">Offset</span>
          <button type="button" className="btn nudge mono" aria-label="Nudge sound one frame earlier" onClick={() => dispatch({ type: 'nudgeSync', frames: -1 })}>
            −
          </button>
          <span className="mono offset" aria-live="polite">
            {formatOffset(selected.offsetFrames)}
          </span>
          <button type="button" className="btn nudge mono" aria-label="Nudge sound one frame later" onClick={() => dispatch({ type: 'nudgeSync', frames: 1 })}>
            +
          </button>
          <span className="faint">1 frame @ {FPS} fps</span>
          <span className="grow" />
          <button type="button" className="btn primary" disabled={selected.accepted} onClick={() => dispatch({ type: 'acceptSync' })}>
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
                key={item.take}
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
                <td>{formatOffset(item.offsetFrames)}</td>
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
  scene14,
  onWaveform,
  onBatch,
}: {
  toReview: number;
  exceptions: number;
  scene14: number;
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
          <button type="button" className="btn tall" disabled={exceptions === 0} title={exceptions === 0 ? 'No takes without timecode left to analyse.' : undefined} onClick={onWaveform}>
            Waveform pass on exceptions
          </button>
          <button
            type="button"
            className="btn primary tall"
            disabled={scene14 === 0}
            title={scene14 === 0 ? 'Every Scene 14 take at 90% or more is already synced; the rest need a look.' : 'Accepts every Scene 14 take at 90% confidence or more.'}
            onClick={onBatch}
          >
            Batch sync Scene 14
          </button>
        </>
      }
    />
  );
}
