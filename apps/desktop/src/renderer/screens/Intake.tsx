import { useState, type ReactNode } from 'react';
import { jobState, legProgress, legState, legWord } from '../model/status';
import type { ChecksumMethod, Status, TransferJob, TransferLeg, Volume, VolumeRole } from '../model/types';
import { engine, formatEta, formatRate, ingestRequest } from '../state/engine';
import { DESTINATION_ROLES, SOURCE_ROLES, useStore } from '../state/store';
import { Check, ProgressBar, ScreenHeader, StartButton, StatusText, statusVar, stepVar, tone } from '../ui/kit';
import { UploadControls } from '../ui/UploadControls';
import { cardStage, ClearCardDialog, clearedWord, jobOfVolume, type CardStage } from '../ui/ClearCard';
import { brandOf, DeviceIcon, ICON_PX, folderLook, KIND_WORD, volumeLook, type MediaLook } from '../ui/media-icons';
import './ingest.css';

/**
 * Intake, laid out as an offload: what is coming in on the left, the copies
 * being made in the middle, where they go on the right, each source and
 * destination drawn as what it is (a camera card, a sound card, a RAID, a
 * shuttle, a network share, a cloud folder). Spec rules: a camera or sound
 * card is read-only and never a destination (§4.2); every copy is read back
 * and checked before it counts (§4.3). A slow destination (cloud, network)
 * is uploaded to from the verified backup, not the card, so the card can
 * come out while the upload carries on (§4.3.1).
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
  const px = ICON_PX[state.prefs.iconSize];
  const [clearing, setClearing] = useState<TransferJob | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const answer = (result: { ok: boolean; reason?: string }) => setNotice(result.ok ? null : (result.reason ?? null));

  const setRelay = (id: string, relay: boolean) => {
    dispatch({ type: 'setDestinationRelay', destination: id, relay });
    if (media) void media.setRelay(id, relay).then(answer);
  };
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
  const picked = [
    ...state.destinations.filter((destination) => destination.selected).map((destination) => ({ name: destination.name, relay: !!destination.relay })),
    ...volumeDestinations.filter((volume) => volume.included).map((volume) => ({ name: volume.name, relay: !!volume.relay })),
  ];
  const destinations = picked.filter((destination) => !destination.relay).map((destination) => destination.name);
  const uploads = picked.filter((destination) => destination.relay).map((destination) => destination.name);
  const rule = state.production.formatRule;

  const blocker = starting
    ? 'Reading the cards…'
    : sources.length === 0
      ? 'Tick at least one camera or sound card that has not been ingested yet.'
      : picked.length === 0
        ? 'Pick at least one destination on the right.'
        : destinations.length === 0
          ? 'Pick at least one destination that copies straight from the card, like the RAID. Uploads are fed from it.'
          : null;

  /** How a card's transfer is drawn: the card's own look while it is mounted, else by camera or sound. */
  const lookOfJob = (job: TransferJob): MediaLook => {
    const volume = state.volumes.find((candidate) => candidate.name === (job.card ?? job.id) || candidate.id === job.id);
    return volume ? volumeLook(volume) : { kind: job.sound || /^sound/i.test(job.label) ? 'sound' : 'card', service: null };
  };
  const lookOfLeg = (leg: TransferLeg): MediaLook | null => {
    const volume = state.volumes.find((candidate) => candidate.id === leg.id);
    if (volume) return volumeLook(volume);
    const folder = state.destinations.find((candidate) => candidate.id === leg.id);
    return folder ? folderLook(folder) : null;
  };
  const pathOfLeg = (leg: TransferLeg): string | undefined =>
    state.volumes.find((candidate) => candidate.id === leg.id)?.mountPath ?? state.destinations.find((candidate) => candidate.id === leg.id)?.path;
  const legActive = (leg: TransferLeg) => !leg.failed && legState(leg) !== 'verified';
  // Newest first; a card copying or uploading stays above the finished ones.
  const rows = [...state.jobs]
    .map((job, index) => ({ job, index, active: jobState(job, rule) === 'running' || jobState(job, rule) === 'waiting' || job.legs.some((leg) => leg.relay && legActive(leg)) }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.index - a.index);
  const anyUploads = state.jobs.some((job) => job.legs.some((leg) => leg.relay));

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
              // The card's colour follows its copy: copying, safe to clear, a problem, cleared.
              const job = jobOfVolume(state, volume);
              const stage = job ? cardStage(state, job) : null;
              return (
                <div key={volume.id} className={`offload-tile${picked ? ' picked' : ''}${stage ? ` stage-${stage}` : ''}`} data-stage={stage ?? undefined}>
                  <label className="offload-tile-main" title={`${KIND_WORD[look.kind]} · ${volume.detected}`}>
                    {!volume.ingested ? (
                      <span className="offload-check">
                        <Check checked={volume.included} onChange={() => dispatch({ type: 'toggleVolume', volume: volume.id })} label={`Include ${volume.name}`} />
                      </span>
                    ) : null}
                    <DeviceIcon look={look} size={px.tile} brand={volume.role === 'Camera' ? brandOf(volume.detected) : null} />
                    <span className="offload-name mono">{volume.name}</span>
                    <span className="offload-sub">
                      {KIND_WORD[look.kind]} · {sizeOf(volume)}
                    </span>
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
                    {stage ? (
                      <StatusText status={STAGE[stage].status} word={STAGE[stage].word(job!)} />
                    ) : (
                      <span className="offload-ro mono" style={{ color: statusVar('done') }}>
                        Read-only
                      </span>
                    )}
                  </div>
                  {stage === 'safe' ? (
                    <button type="button" className="btn small offload-clear" onClick={() => setClearing(job!)}>
                      Clear card…
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {unused.length ? (
            <div className="offload-unused">
              <span className="label">Not used</span>
              {unused.map((volume) => (
                <div key={volume.id} className="row offload-unused-row">
                  <DeviceIcon look={volumeLook(volume)} size={px.list} path={volume.mountPath} />
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
          <div className="offload-transfers-head">
            <h2 className="offload-head">Transfers</h2>
            {anyUploads || picked.some((destination) => destination.relay) ? <UploadControls /> : null}
          </div>
          <div className="offload-plan">
            <div className="grow">
              <div className="intake-summary">
                {plural(sources.length, 'source')} → {plural(destinations.length, 'destination')}
                {uploads.length ? ` + ${plural(uploads.length, 'upload')}` : ''}
              </div>
              <div className="muted small">
                {sources.length > 0 ? sources.map((volume) => volume.name).join(', ') : 'No source picked'}
                {destinations.length > 0 ? ` → ${destinations.join(', ')}` : ''}
                {uploads.length > 0 ? ` → ↑ ${uploads.join(', ')} from ${destinations[0] ?? 'the backup'}` : ''}
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
              <StatusText status="needs" word={uploads.length ? 'Only one local copy' : 'Only one destination'} />
              <span className="muted">
                {rule === 'two-local'
                  ? 'This production counts a card safe to format once two local copies have verified. Add a shuttle or a second drive.'
                  : 'Keep at least two verified copies before a card is formatted.'}
              </span>
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
              job.legs.map((leg) => {
                const cardBusy = jobState(job, rule) === 'running' || jobState(job, rule) === 'waiting';
                const stop = leg.relay ? legActive(leg) : cardBusy && !leg.relay;
                return (
                  <TransferRow
                    key={`${job.id}|${leg.id ?? leg.name}`}
                    job={job}
                    leg={leg}
                    look={leg.relay ? (lookOfLeg(leg) ?? { kind: 'cloud', service: null }) : lookOfJob(job)}
                    path={leg.relay ? pathOfLeg(leg) : undefined}
                    onStop={media && stop ? () => void (leg.relay ? media.stopJob(job.id, leg.id) : media.stopJob(job.id)).then(answer) : undefined}
                    onShow={media && leg.targetDir ? () => void media.show(leg.targetDir!) : undefined}
                    onOpen={() => dispatch({ type: 'go', screen: 'verify' })}
                  />
                );
              }),
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
                path={destination.path}
                selected={destination.selected}
                relay={!!destination.relay}
                onRelay={(relay) => setRelay(destination.id, relay)}
                onToggle={() => dispatch({ type: 'toggleDestination', destination: destination.id })}
                onRemove={media ? () => void media.removeFolder(destination.id) : undefined}
              />
            ))}
            {volumeDestinations.map((volume) => (
              <DestinationTile
                key={volume.id}
                name={volume.name}
                sub={`${KIND_WORD[volumeLook(volume).kind]} · ${volume.role}`}
                free={freeOf(volume)}
                fillPct={volume.fillPct}
                look={volumeLook(volume)}
                path={volume.mountPath}
                selected={volume.included}
                relay={!!volume.relay}
                onRelay={(relay) => setRelay(volume.id, relay)}
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
      {clearing ? <ClearCardDialog job={clearing} onClose={() => setClearing(null)} /> : null}
    </div>
  );
}

/** How a card's tile reads at each stage. */
const STAGE: Record<CardStage, { status: Status; word: (job: TransferJob) => string }> = {
  waiting: { status: 'idle', word: () => 'Waiting to copy' },
  copying: { status: 'working', word: () => 'Copying' },
  eject: { status: 'needs', word: () => "Can come out · don't clear" },
  safe: { status: 'done', word: () => 'Safe to clear' },
  problem: { status: 'problem', word: () => "Problem · don't clear" },
  cleared: { status: 'idle', word: (job) => clearedWord(job) },
};

function TransferRow({
  job,
  leg,
  look,
  path,
  onStop,
  onShow,
  onOpen,
}: {
  job: TransferJob;
  leg: TransferLeg;
  look: MediaLook;
  path?: string;
  onStop?: () => void;
  onShow?: () => void;
  onOpen: () => void;
}) {
  const px = ICON_PX[useStore().state.prefs.iconSize];
  const stateNow = legState(leg);
  const status = stateNow === 'verified' ? 'done' : stateNow === 'failed' ? 'problem' : stateNow === 'waiting' ? 'idle' : 'working';
  // An upload reports its own speed and file; a card's copy reports them on the card.
  const rate = leg.relay ? leg.bytesPerSecond : job.bytesPerSecond;
  const eta = leg.relay ? leg.etaSeconds : job.etaSeconds;
  const file = leg.relay ? leg.currentFile : job.currentFile;
  const right =
    stateNow === 'copying' && rate
      ? `${eta !== null && eta !== undefined ? formatEta(eta) : ''} (${formatRate(rate)})`
      : stateNow === 'failed'
        ? (leg.error ?? 'Failed')
        : legWord(leg);
  const card = job.card ?? job.id;
  return (
    <div className={`offload-row is-${stateNow}${leg.relay ? ' is-upload' : ''}`}>
      <DeviceIcon look={look} size={px.row} path={path} />
      <div className="grow offload-row-body">
        <div className="offload-row-title">
          <span className="strong mono">{card}</span>
          {leg.relay ? (
            <span className="relay-hop mono">
              {' → '}
              {leg.relayFrom ?? 'backup'}
              {' ↑ '}
            </span>
          ) : (
            <span className="faint" aria-hidden="true">
              {' → '}
            </span>
          )}
          <span className="strong mono">{leg.name}</span>
          <span className="faint mono offload-path">{tail(leg.targetDir)}</span>
        </div>
        <ProgressBar pct={legProgress(leg)} color={statusVar(status)} label={`${card} to ${leg.name}`} />
        <div className="offload-row-foot">
          <span className="mono ellipsis">{stateNow === 'copying' ? (file?.split('/').pop() ?? '') : stateNow === 'verified' ? `${job.files} · ${job.size} · ${job.checksum}` : ''}</span>
          <span className="grow" />
          <span className="nowrap" style={{ color: stateNow === 'failed' ? statusVar('problem') : undefined }}>
            {right}
          </span>
        </div>
      </div>
      <div className="offload-row-actions">
        {onStop ? (
          <button
            type="button"
            className="round-btn"
            aria-label={leg.relay ? `Stop upload of ${card} to ${leg.name}` : `Stop ${card}`}
            title={leg.relay ? 'Stop this upload (it can be retried, from the backup)' : 'Stop this card (it can be retried)'}
            onClick={onStop}
          >
            ■
          </button>
        ) : null}
        <button type="button" className="round-btn" aria-label={onShow ? `Show ${card} on ${leg.name}` : `Open ${card} in Verify`} title={onShow ? 'Show the copy' : 'Open in Verify'} onClick={onShow ?? onOpen}>
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
  path,
  selected,
  relay,
  onRelay,
  onToggle,
  onRemove,
  role,
}: {
  name: string;
  sub: string;
  free: string;
  fillPct: number;
  look: MediaLook;
  path?: string;
  selected: boolean;
  relay: boolean;
  onRelay: (relay: boolean) => void;
  onToggle: () => void;
  onRemove?: () => void;
  role?: ReactNode;
}) {
  const px = ICON_PX[useStore().state.prefs.iconSize];
  return (
    <div className={`offload-tile${selected ? ' picked' : ''}`}>
      <label className="offload-tile-main" title={look.service ? `${look.service} folder` : KIND_WORD[look.kind]}>
        <span className="offload-check">
          <Check checked={selected} onChange={onToggle} label={`Write to ${name}`} />
        </span>
        <DeviceIcon look={look} size={px.tile} path={path} />
        {look.service ? <span className="offload-service">{look.service}</span> : null}
        <span className="offload-name mono">{name}</span>
        <span className="offload-sub ellipsis" title={sub}>
          {sub}
        </span>
        <span className="offload-sub faint">{free} free</span>
      </label>
      <ProgressBar pct={fillPct} color="var(--s-working)" label={`${name} capacity used`} />
      <div className="relay-switch" role="group" aria-label={`How ${name} is fed`}>
        <button type="button" aria-pressed={!relay} title="Copied straight from the card, and checked, before the card counts as done" onClick={() => onRelay(false)}>
          From card
        </button>
        <button type="button" aria-pressed={relay} title="Uploaded from the verified backup after the card is done, so the card can come out first" onClick={() => onRelay(true)}>
          Upload from backup
        </button>
      </div>
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
