import { engine } from '../state/engine';
import { useStore } from '../state/store';

/**
 * Pause or resume every upload, and how fast they may go: on set internet a
 * full-speed upload can take the whole connection, so it can be held to a
 * share of it. In MB/s, as transfers show speed, with the Mbit/s an
 * internet connection is sold in alongside.
 */

const MB = 1_000_000;
export const UPLOAD_LIMITS: (number | null)[] = [null, 1 * MB, 2.5 * MB, 5 * MB, 10 * MB, 25 * MB, 50 * MB, 100 * MB];

export const limitWord = (bytesPerSecond: number | null): string =>
  bytesPerSecond ? `${+(bytesPerSecond / MB).toFixed(1)} MB/s (${Math.round((bytesPerSecond * 8) / MB)} Mbit/s)` : 'No limit';

export function UploadControls() {
  const { state } = useStore();
  const media = state.engine ? engine() : null;
  if (!media) return null;
  const limits = state.relayLimit && !UPLOAD_LIMITS.includes(state.relayLimit) ? [...UPLOAD_LIMITS, state.relayLimit].sort((a, b) => (a ?? 0) - (b ?? 0)) : UPLOAD_LIMITS;
  return (
    <span className="upload-controls">
      <label className="upload-limit" title="The most all uploads together may send. Card copies, and copies from the backup to drives on the cart, are never held to it.">
        <span className="faint small">Upload speed</span>
        <select
          className="select"
          aria-label="Upload speed limit"
          value={state.relayLimit ?? ''}
          onChange={(event) => void media.setRelayLimit(event.target.value ? Number(event.target.value) : null)}
        >
          {limits.map((limit) => (
            <option key={limit ?? 'none'} value={limit ?? ''}>
              {limitWord(limit)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn ghost small" aria-pressed={state.relaysPaused} onClick={() => void media.pauseRelays(!state.relaysPaused)}>
        {state.relaysPaused ? 'Resume uploads' : 'Pause uploads'}
      </button>
    </span>
  );
}
