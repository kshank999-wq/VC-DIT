import type { Volume } from '../model/types';
import { legState } from '../model/status';
import { useStore } from '../state/store';
import { EjectButton } from './ClearCard';
import { SealButton, sealOf, sealWords } from './SealDrive';
import { StatusText } from './kit';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A shuttle (or archive drive) on its way out: whether everything sent to it
 * today has verified, and the button to eject it so it can be carried off.
 */
export function ShuttleOut({ volume }: { volume: Volume }) {
  const { state } = useStore();
  const sealed = sealWords(sealOf(state, volume));
  const legs = state.jobs.flatMap((job) => job.legs.filter((leg) => leg.id === volume.id || (!leg.id && leg.name === volume.name)));
  const copying = legs.filter((leg) => !leg.failed && legState(leg) !== 'verified').length;
  const failed = legs.filter((leg) => leg.failed).length;
  const verified = legs.length - copying - failed;
  const word = failed
    ? { status: 'problem' as const, text: `${plural(failed, 'card')} failed here` }
    : copying
      ? { status: 'working' as const, text: `${plural(copying, 'card')} still copying` }
      : legs.length
        ? { status: 'done' as const, text: `${plural(verified, 'card')} verified · ready to go` }
        : { status: 'idle' as const, text: 'Nothing copied here today' };
  return (
    <div className="offload-eject">
      <StatusText status={word.status} word={word.text} />
      {/* Safeguard: it leaves only with every card on it verified. */}
      {failed || copying ? (
        <button
          type="button"
          className="btn small"
          disabled
          aria-label={`Eject ${volume.name} (locked until every copy has verified)`}
          title={failed ? 'A copy to it failed. Retry it in Verify, then eject.' : 'Eject it when every card copied to it has verified.'}
        >
          🔒 Eject when verified
        </button>
      ) : (
        <>
          {/* Sealing: the last check before it goes, and a manifest for the other end. */}
          {legs.length > 0 && <SealButton volume={volume} />}
          <EjectButton volume={volume} />
        </>
      )}
      {sealed && <span className="muted small">{sealed}</span>}
    </div>
  );
}

