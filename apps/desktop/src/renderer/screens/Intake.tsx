import { useState } from 'react';
import type { ChecksumMethod, Volume, VolumeRole } from '../model/types';
import { engine, ingestRequest } from '../state/engine';
import { DESTINATION_ROLES, SOURCE_ROLES, useStore } from '../state/store';
import { Check, ProgressBar, ScreenHeader, StartButton, StatusText, statusVar, stepVar, tone } from '../ui/kit';
import './ingest.css';

/**
 * Intake: pick the cards coming in (left), how they are checked (centre)
 * and where the verified copies go (right), then start. Spec rules: a camera
 * or sound card is read-only and can never be a destination (§4.2); every
 * copy is read back and checked before it counts (§4.3).
 */

const ROLES: VolumeRole[] = ['Camera', 'Sound', 'Destination', 'Shuttle', 'Archive', 'Other'];
const CHECKSUMS: { value: ChecksumMethod; note: string }[] = [
  { value: 'xxHash64', note: 'Fast · default' },
  { value: 'MD5', note: 'Widely accepted' },
  { value: 'SHA-1', note: 'Slower · strongest' },
];

const toGb = (text: string): number => {
  const found = /([\d.]+)\s*(TB|GB|MB)/.exec(text);
  if (!found) return 0;
  const value = Number(found[1]);
  return found[2] === 'TB' ? value * 1000 : found[2] === 'MB' ? value / 1000 : value;
};
const freeOf = (volume: Volume): string => {
  const free = Math.max(0, toGb(volume.media) - toGb(volume.used));
  return free >= 1000 ? `${(free / 1000).toFixed(1)} TB` : `${Math.round(free)} GB`;
};

export function Intake() {
  const { state, dispatch } = useStore();
  const media = state.engine ? engine() : null;
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const answer = (result: { ok: boolean; reason?: string }) => setNotice(result.ok ? null : (result.reason ?? null));

  const setRole = (volume: Volume, role: VolumeRole) => {
    dispatch({ type: 'setVolumeRole', volume: volume.id, role });
    if (media) void media.setRole(volume.id, role).then(answer);
  };
  const start = async () => {
    if (!media) {
      dispatch({ type: 'startIngest' });
      return;
    }
    setStarting(true);
    try {
      const result = await media.ingest(ingestRequest(state));
      answer(result);
      if (result.ok) dispatch({ type: 'go', screen: 'verify' });
    } finally {
      setStarting(false);
    }
  };
  const isSource = (volume: Volume) => SOURCE_ROLES.includes(volume.role);
  const sources = state.volumes.filter((volume) => isSource(volume) && volume.included && !volume.ingested);
  const volumeDestinations = state.volumes.filter((volume) => DESTINATION_ROLES.includes(volume.role));
  const destinations = [
    ...state.destinations.filter((destination) => destination.selected).map((destination) => destination.name),
    ...volumeDestinations.filter((volume) => volume.included).map((volume) => volume.name),
  ];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const blocker = starting
    ? 'Reading the cards…'
    : sources.length === 0
      ? 'Tick at least one camera or sound card that has not been ingested yet.'
      : destinations.length === 0
        ? 'Pick at least one destination on the right.'
        : null;

  return (
    <div className="screen">
      <ScreenHeader step="intake" eyebrow="01 · Intake" title="Bring media in" description="Left: what's coming in. Right: where the verified copies go." />

      <div className="intake">
        <section className="intake-zone" aria-labelledby="intake-in">
          <div className="intake-zone-head" style={tone(stepVar('intake'), 'var(--on-step)')}>
            <span className="intake-badge mono">IN</span>
            <h2 id="intake-in">Sources</h2>
            <span className="grow" />
            <span className="muted">Cards · read-only</span>
          </div>
          <div className="intake-list">
            {state.volumes.length === 0 ? (
              <div className="intake-empty muted" role="status">
                No cards or drives found. Plug in a camera card, sound card or drive and it shows up here within a few seconds.
              </div>
            ) : null}
            {state.volumes.map((volume) => {
              const source = isSource(volume);
              return (
                <div key={volume.id} className={`card intake-card${source && volume.included && !volume.ingested ? ' selected' : ''}`}>
                  <div className="row intake-card-top">
                    {source && !volume.ingested ? (
                      <Check checked={volume.included} onChange={() => dispatch({ type: 'toggleVolume', volume: volume.id })} label={`Include ${volume.name}`} />
                    ) : (
                      <span className="intake-check-space" aria-hidden="true" />
                    )}
                    <div className="grow">
                      <div className="row intake-name-row">
                        <span className="mono intake-name">{volume.name}</span>
                        <span className="muted intake-detected">{volume.detected}</span>
                      </div>
                      <div className="muted">
                        {volume.media} · {volume.used} used{volume.filesystem ? ` · ${volume.filesystem}` : ''}
                      </div>
                    </div>
                    <select
                      className="select intake-role"
                      aria-label={`Role of ${volume.name}`}
                      value={volume.role}
                      disabled={volume.ingested}
                      onChange={(event) => setRole(volume, event.target.value as VolumeRole)}
                    >
                      {ROLES.map((role) => (
                        <option key={role}>{role}</option>
                      ))}
                    </select>
                  </div>
                  <div className="row intake-card-foot">
                    <div className="grow">
                      <ProgressBar pct={volume.fillPct} color="var(--s-working)" label={`${volume.name} capacity used`} />
                    </div>
                    {volume.ingested ? (
                      <StatusText status="done" word="Ingested" />
                    ) : source ? (
                      <span className="mono intake-ro" style={{ color: statusVar('done') }}>
                        Read-only
                      </span>
                    ) : null}
                  </div>
                  {!source ? (
                    <div className="faint intake-hint">
                      {DESTINATION_ROLES.includes(volume.role) ? 'Can receive copies — pick it on the right.' : 'Not ingested and not written to.'}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="intake-lane" aria-label="Copy and check">
          <div className="intake-arrow" style={{ color: stepVar('intake') }} aria-hidden="true">
            →
          </div>
          <div className="label intake-center">Copy + check</div>
          <div className="stack intake-tight">
            <span className="label">Checksum</span>
            <div className="intake-checksums" role="group" aria-label="Checksum">
              {CHECKSUMS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={state.checksum === option.value}
                  onClick={() => dispatch({ type: 'setChecksum', checksum: option.value })}
                >
                  <span className="mono">{option.value}</span>
                  <span className="intake-checksum-note">{option.note}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="muted intake-promises">
            <div>✓ Re-read after copy</div>
            <div>✓ ASC MHL + transfer log</div>
          </div>
          <div>
            <div className="intake-summary">
              {plural(sources.length, 'source')} → {plural(destinations.length, 'destination')}
            </div>
            <div className="muted">
              {sources.length > 0 ? sources.map((volume) => volume.name).join(', ') : 'No source picked'}
              {sources.length > 0 && destinations.length > 0 ? ` · ${sources.length * destinations.length} verified copies` : ''}
            </div>
            {destinations.length > 0 ? <div className="faint">to {destinations.join(', ')}</div> : null}
          </div>
          {destinations.length === 1 ? (
            <div className="intake-warning" role="note" style={tone(statusVar('needs'))}>
              <StatusText status="needs" word="Only one destination" />
              <span className="muted">Keep at least two verified copies before a card is formatted.</span>
            </div>
          ) : null}
          <StartButton step="intake" big disabledReason={blocker} onClick={() => void start()}>
            Start verified ingest
          </StartButton>
          {notice ? (
            <div className="intake-warning" role="alert" style={tone(statusVar('problem'))}>
              <StatusText status="problem" word="Not started" />
              <span className="muted">{notice}</span>
            </div>
          ) : null}
        </section>

        <section className="intake-zone" aria-labelledby="intake-out">
          <div className="intake-zone-head" style={tone(stepVar('verify'), 'var(--on-step)')}>
            <span className="intake-badge mono">OUT</span>
            <h2 id="intake-out">Destinations</h2>
            <span className="grow" />
            <span className="muted">All written at once</span>
          </div>
          <div className="intake-list">
            {state.destinations.map((destination) => (
              <DestinationCard
                key={destination.id}
                name={destination.name}
                kind={destination.kind}
                free={destination.free}
                fillPct={destination.fillPct}
                selected={destination.selected}
                onToggle={() => dispatch({ type: 'toggleDestination', destination: destination.id })}
                onRemove={media ? () => void media.removeFolder(destination.id) : undefined}
              />
            ))}
            {volumeDestinations.map((volume) => (
              <DestinationCard
                key={volume.id}
                name={volume.name}
                kind={`${volume.role} · from detected volume`}
                free={freeOf(volume)}
                fillPct={volume.fillPct}
                selected={volume.included}
                onToggle={() => dispatch({ type: 'toggleDestination', destination: volume.id })}
              />
            ))}
            {media && state.destinations.length === 0 && volumeDestinations.length === 0 ? (
              <div className="intake-empty muted">
                No destinations yet. Set a drive's role to Destination, Shuttle or Archive on the left, or add a folder (a NAS share, a LucidLink
                folder, a folder on the RAID).
              </div>
            ) : null}
            <button
              type="button"
              className="intake-add"
              disabled={!media}
              title={media ? 'Pick a folder to copy into: a NAS share, a LucidLink folder, a folder on the RAID' : 'Available in the desktop app'}
              onClick={() => media && void media.addFolder().then(answer)}
            >
              + Add destination folder
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function DestinationCard({
  name,
  kind,
  free,
  fillPct,
  selected,
  onToggle,
  onRemove,
}: {
  name: string;
  kind: string;
  free: string;
  fillPct: number;
  selected: boolean;
  onToggle: () => void;
  onRemove?: () => void;
}) {
  return (
    <label className={`card intake-card intake-dest${selected ? ' selected' : ''}`}>
      <div className="row intake-card-top">
        <Check checked={selected} onChange={onToggle} label={`Write to ${name}`} />
        <div className="grow">
          <div className="mono intake-name">{name}</div>
          <div className="muted">{kind}</div>
        </div>
        <span className="muted">{free} free</span>
        {onRemove ? (
          <button
            type="button"
            className="btn ghost small"
            aria-label={`Remove ${name} from destinations`}
            title="Remove from the list (nothing is deleted)"
            onClick={(event) => {
              event.preventDefault();
              onRemove();
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      <ProgressBar pct={fillPct} color="var(--s-working)" label={`${name} capacity used`} />
    </label>
  );
}
