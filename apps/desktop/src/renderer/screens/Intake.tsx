import { useState, type ReactNode } from 'react';
import { jobState, legProgress, legState, legWord } from '../model/status';
import type { ChecksumMethod, TransferJob, TransferLeg, Volume, VolumeRole } from '../model/types';
import { engine, formatEta, formatRate, ingestRequest } from '../state/engine';
import { DESTINATION_ROLES, SOURCE_ROLES, useStore } from '../state/store';
import { Check, ProgressBar, ScreenHeader, StartButton, StatusText, statusVar, stepVar, tone } from '../ui/kit';
import { folderLook, KIND_WORD, MediaIcon, volumeLook, type MediaLook } from '../ui/media-icons';
import './ingest.css';

/**
 * Intake, laid out as an offload: what is coming in on the left, the copies
 * being made in the middle, where they go on the right, each source and
 * destination drawn as what it is (a camera card, a sound card, a RAID, a
 * shuttle, a network share, a cloud folder). Spec rules: a camera or sound
 * card is read-only and never a destination (§4.2); every copy is read back
 * and checked before it counts (§4.3).
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
const sizeOf = (volume: Volume) => volume.media.split(' · ').slice(1).join(' · ') || volume.used;
/** The last few folders of a path: "…/SHOOT_DAY_014/CAMERA_ORIGINALS/A015". */
const tail = (path: string | undefined, parts = 3) => {
  if (!path) return '';
  const pieces = path.split(/[\\/]/).filter(Boolean);
  return `${pieces.length > parts ? '…/' : ''}${pieces.slice(-parts).join('/')}`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
      answer(await media.ingest(ingestRequest(state)));
    } finally {
      setStarting(false);
    }
  };

  const isSource = (volume: Volume) => SOURCE_ROLES.includes(volume.role);
  const sourceVolumes = state.volumes.filter(isSource);
  const unused = state.volumes.filter((volume) => volume.role === 'Other');
  const sources = sourceVolumes.filter((volume) => volume.included && !volume.ingested);
  const volumeDestinations = state.volumes.filter((volume) => DESTINATION_ROLES.includes(volume.role));
  const destinations = [
    ...state.destinations.filter((destination) => destination.selected).map((destination) => destination.name),
    ...volumeDestinations.filter((volume) => volume.included).map((volume) => volume.name),
  ];

  const blocker = starting
    ? 'Reading the cards…'
    : sources.length === 0
      ? 'Tick at least one camera or sound card that has not been ingested yet.'
      : destinations.length === 0
        ? 'Pick at least one destination on the right.'
        : null;

  /** How a card's transfer is drawn: the card's own look while it is mounted, else by camera or sound. */
  const lookOfJob = (job: TransferJob): MediaLook => {
    const volume = state.volumes.find((candidate) => candidate.name === (job.card ?? job.id) || candidate.id === job.id);
    return volume ? volumeLook(volume) : { kind: job.sound || /^sound/i.test(job.label) ? 'sound' : 'card', service: null };
  };
  // Newest first; a card copying or waiting stays above the finished ones.
  const rows = [...state.jobs]
    .map((job, index) => ({ job, index, active: jobState(job) === 'running' || jobState(job) === 'waiting' }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.index - a.index);

  return (
    <div className="screen">
      <ScreenHeader step="intake" eyebrow="01 · Intake" title="Bring media in" description="Sources on the left, where the verified copies go on the right. Every copy is read back and checked." />

      <div className="offload">
        {/* ------------------------------------------------ sources */}
        <section className="offload-col" aria-label="Sources">
          <h2 className="offload-head">Sources</h2>
          {sourceVolumes.length === 0 ? (
            <p className="offload-empty muted" role="status">
              No cards yet. Plug in a camera card, sound card or card reader; it shows up here within a few seconds.
            </p>
          ) : null}
          <div className="offload-tiles">
            {sourceVolumes.map((volume) => {
              const look = volumeLook(volume);
              const picked = volume.included && !volume.ingested;
              return (
                <div key={volume.id} className={`offload-tile${picked ? ' picked' : ''}${volume.ingested ? ' done' : ''}`}>
                  <label className="offload-tile-main" title={`${KIND_WORD[look.kind]} · ${volume.detected}`}>
                    {!volume.ingested ? (
                      <span className="offload-check">
                        <Check checked={volume.included} onChange={() => dispatch({ type: 'toggleVolume', volume: volume.id })} label={`Include ${volume.name}`} />
                      </span>
                    ) : null}
                    <MediaIcon look={look} size={72} />
                    <span className="offload-name mono">{volume.name}</span>
                    <span className="offload-sub">{sizeOf(volume)}</span>
                    <span className="offload-sub">
                      {volume.used} used{volume.filesystem ? ` · ${volume.filesystem}` : ''}
                    </span>
                    <span className="offload-sub faint">{volume.detected}</span>
                  </label>
                  <div className="offload-tile-foot">
                    <select className="select offload-role" aria-label={`Role of ${volume.name}`} value={volume.role} disabled={volume.ingested} onChange={(event) => setRole(volume, event.target.value as VolumeRole)}>
                      {ROLES.map((role) => (
                        <option key={role}>{role}</option>
                      ))}
                    </select>
                    {volume.ingested ? <StatusText status="done" word="Ingested" /> : <span className="offload-ro mono" style={{ color: statusVar('done') }}>Read-only</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {unused.length ? (
            <div className="offload-unused">
              <span className="label">Not used</span>
              {unused.map((volume) => (
                <div key={volume.id} className="row offload-unused-row">
                  <MediaIcon look={volumeLook(volume)} size={28} />
                  <span className="grow">
                    <span className="mono">{volume.name}</span>
                    <span className="faint small"> · {volume.detected}</span>
                  </span>
                  <select className="select offload-role" aria-label={`Role of ${volume.name}`} value={volume.role} onChange={(event) => setRole(volume, event.target.value as VolumeRole)}>
                    {ROLES.map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                </div>
              ))}
              <p className="faint small">Never read from or written to until you give it a role.</p>
            </div>
          ) : null}
        </section>

        {/* ------------------------------------------------ transfers */}
        <section className="offload-col offload-transfers" aria-label="Transfers">
          <h2 className="offload-head">Transfers</h2>
          <div className="offload-plan">
            <div className="grow">
              <div className="intake-summary">
                {plural(sources.length, 'source')} → {plural(destinations.length, 'destination')}
              </div>
              <div className="muted small">
                {sources.length > 0 ? sources.map((volume) => volume.name).join(', ') : 'No source picked'}
                {destinations.length > 0 ? ` → ${destinations.join(', ')}` : ''}
              </div>
            </div>
            <div className="intake-checksums" role="group" aria-label="Checksum">
              {CHECKSUMS.map((option) => (
                <button key={option.value} type="button" aria-pressed={state.checksum === option.value} title={option.note} onClick={() => dispatch({ type: 'setChecksum', checksum: option.value })}>
                  <span className="mono">{option.value}</span>
                </button>
              ))}
            </div>
            <StartButton step="intake" disabledReason={blocker} onClick={() => void start()}>
              Start verified ingest
            </StartButton>
          </div>
          {destinations.length === 1 ? (
            <div className="intake-warning" role="note" style={tone(statusVar('needs'))}>
              <StatusText status="needs" word="Only one destination" />
              <span className="muted">Keep at least two verified copies before a card is formatted.</span>
            </div>
          ) : null}
          {notice ? (
            <div className="intake-warning" role="alert" style={tone(statusVar('problem'))}>
              <StatusText status="problem" word="Not started" />
              <span className="muted">{notice}</span>
            </div>
          ) : null}

          <div className="offload-rows">
            {rows.length === 0 ? (
              <p className="offload-empty muted">Nothing copying yet. Each card gets a row per destination here: copied, read back and checked.</p>
            ) : null}
            {rows.flatMap(({ job }) =>
              job.legs.map((leg) => (
                <TransferRow
                  key={`${job.id}|${leg.id ?? leg.name}`}
                  job={job}
                  leg={leg}
                  look={lookOfJob(job)}
                  onStop={media && (jobState(job) === 'running' || jobState(job) === 'waiting') ? () => void media.stopJob(job.id).then(answer) : undefined}
                  onShow={media && leg.targetDir ? () => void media.show(leg.targetDir!) : undefined}
                  onOpen={() => dispatch({ type: 'go', screen: 'verify' })}
                />
              )),
            )}
          </div>
        </section>

        {/* ------------------------------------------------ destinations */}
        <section className="offload-col" aria-label="Destinations">
          <h2 className="offload-head">Destinations</h2>
          <div className="offload-tiles">
            {state.destinations.map((destination) => (
              <DestinationTile
                key={destination.id}
                name={destination.name}
                sub={destination.kind}
                free={destination.free}
                fillPct={destination.fillPct}
                look={folderLook(destination)}
                selected={destination.selected}
                onToggle={() => dispatch({ type: 'toggleDestination', destination: destination.id })}
                onRemove={media ? () => void media.removeFolder(destination.id) : undefined}
              />
            ))}
            {volumeDestinations.map((volume) => (
              <DestinationTile
                key={volume.id}
                name={volume.name}
                sub={volume.role}
                free={freeOf(volume)}
                fillPct={volume.fillPct}
                look={volumeLook(volume)}
                selected={volume.included}
                onToggle={() => dispatch({ type: 'toggleDestination', destination: volume.id })}
                role={<select className="select offload-role" aria-label={`Role of ${volume.name}`} value={volume.role} onChange={(event) => setRole(volume, event.target.value as VolumeRole)}>{ROLES.map((role) => <option key={role}>{role}</option>)}</select>}
              />
            ))}
          </div>
          {media && state.destinations.length === 0 && volumeDestinations.length === 0 ? (
            <p className="offload-empty muted">No destinations yet. Give a drive the Destination, Shuttle or Archive role, or add a folder: a NAS share, a LucidLink filespace, a folder on the RAID.</p>
          ) : null}
          <button
            type="button"
            className="intake-add"
            disabled={!media}
            title={media ? 'A NAS share, a LucidLink or Dropbox folder, a folder on the RAID' : 'Available in the desktop app'}
            onClick={() => media && void media.addFolder().then(answer)}
          >
            + Add destination folder
          </button>
        </section>
      </div>
    </div>
  );
}

function TransferRow({ job, leg, look, onStop, onShow, onOpen }: { job: TransferJob; leg: TransferLeg; look: MediaLook; onStop?: () => void; onShow?: () => void; onOpen: () => void }) {
  const stateNow = legState(leg);
  const status = stateNow === 'verified' ? 'done' : stateNow === 'failed' ? 'problem' : stateNow === 'waiting' ? 'idle' : 'working';
  const right =
    stateNow === 'copying' && job.bytesPerSecond
      ? `${job.etaSeconds !== null && job.etaSeconds !== undefined ? formatEta(job.etaSeconds) : ''} (${formatRate(job.bytesPerSecond)})`
      : stateNow === 'failed'
        ? (leg.error ?? 'Failed')
        : legWord(leg);
  return (
    <div className={`offload-row is-${stateNow}`}>
      <MediaIcon look={look} size={40} />
      <div className="grow offload-row-body">
        <div className="offload-row-title">
          <span className="strong mono">{job.card ?? job.id}</span>
          <span className="faint" aria-hidden="true">
            {' → '}
          </span>
          <span className="strong mono">{leg.name}</span>
          <span className="faint mono offload-path">{tail(leg.targetDir)}</span>
        </div>
        <ProgressBar pct={legProgress(leg)} color={statusVar(status)} label={`${job.card ?? job.id} to ${leg.name}`} />
        <div className="offload-row-foot">
          <span className="mono ellipsis">{stateNow === 'copying' ? (job.currentFile?.split('/').pop() ?? '') : stateNow === 'verified' ? `${job.files} · ${job.size} · ${job.checksum}` : ''}</span>
          <span className="grow" />
          <span className="nowrap" style={{ color: stateNow === 'failed' ? statusVar('problem') : undefined }}>
            {right}
          </span>
        </div>
      </div>
      <div className="offload-row-actions">
        {onStop ? (
          <button type="button" className="round-btn" aria-label={`Stop ${job.card ?? job.id}`} title="Stop this card (it can be retried)" onClick={onStop}>
            ■
          </button>
        ) : null}
        <button type="button" className="round-btn" aria-label={onShow ? `Show ${job.card ?? job.id} on ${leg.name}` : `Open ${job.card ?? job.id} in Verify`} title={onShow ? 'Show the copy' : 'Open in Verify'} onClick={onShow ?? onOpen}>
          ⌕
        </button>
      </div>
    </div>
  );
}

function DestinationTile({
  name,
  sub,
  free,
  fillPct,
  look,
  selected,
  onToggle,
  onRemove,
  role,
}: {
  name: string;
  sub: string;
  free: string;
  fillPct: number;
  look: MediaLook;
  selected: boolean;
  onToggle: () => void;
  onRemove?: () => void;
  role?: ReactNode;
}) {
  return (
    <div className={`offload-tile${selected ? ' picked' : ''}`}>
      <label className="offload-tile-main" title={look.service ? `${look.service} folder` : KIND_WORD[look.kind]}>
        <span className="offload-check">
          <Check checked={selected} onChange={onToggle} label={`Write to ${name}`} />
        </span>
        <MediaIcon look={look} size={72} />
        {look.service ? <span className="offload-service">{look.service}</span> : null}
        <span className="offload-name mono">{name}</span>
        <span className="offload-sub ellipsis" title={sub}>
          {sub}
        </span>
        <span className="offload-sub faint">{free} free</span>
      </label>
      <ProgressBar pct={fillPct} color="var(--s-working)" label={`${name} capacity used`} />
      {role || onRemove ? (
        <div className="offload-tile-foot">
          {role}
          {onRemove ? (
            <button type="button" className="btn ghost small" aria-label={`Remove ${name} from destinations`} title="Remove from the list (nothing is deleted)" onClick={onRemove}>
              Remove
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
