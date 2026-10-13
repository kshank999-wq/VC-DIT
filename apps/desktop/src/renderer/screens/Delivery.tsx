import { useEffect, useState, type FormEvent } from 'react';
import { formatBytes } from '../../shared/media';
import {
  DELIVERY_PACKAGES,
  deliveryHeadroom,
  deliveryNeed,
  deliveryParts,
  packageBytes,
  type DeliveryPlace,
  type DeliveryRecord,
  type DeliveryState,
  type ProjectResult,
} from '../../shared/project';
import { LAST_MANIFEST } from '../model/demo';
import { formatGb } from '../model/status';
import type { DeliveryDestination } from '../model/types';
import { formatEta, formatRate, projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { Check, ScreenHeader, StartButton, StatusText, statusVar, tone } from '../ui/kit';
import './output.css';

/**
 * Delivery: pick packages and destinations, preflight capacity, then copy and
 * verify every deliverable (spec §4.10). A destination without room for the
 * selection is flagged before anything starts and blocks the button; every
 * copy is checksummed and the day's manifest records files, destinations,
 * times, verification and retries.
 */

interface Preflight {
  destination: DeliveryDestination;
  /** GB left after the delivery; Infinity for cloud. */
  remaining: number;
  short: boolean;
  /** How much of the free space the selection uses, 0–100. */
  usePct: number;
}

export const preflight = (destination: DeliveryDestination, need: number): Preflight => {
  const cloud = !Number.isFinite(destination.freeGb);
  const remaining = destination.freeGb - need;
  return {
    destination,
    remaining,
    short: !cloud && remaining < 0,
    usePct: cloud ? 8 : destination.freeGb > 0 ? Math.min(100, (need / destination.freeGb) * 100) : 100,
  };
};

const capacityText = (check: Preflight): { text: string; color: string } => {
  const { destination } = check;
  const cloud = !Number.isFinite(destination.freeGb);
  if (!destination.selected) return { text: cloud ? 'cloud' : `${formatGb(destination.freeGb)} free`, color: 'var(--label)' };
  if (cloud) return { text: '✓ ready', color: statusVar('done') };
  if (check.short) return { text: `✕ short ${formatGb(-check.remaining)}`, color: statusVar('problem') };
  return { text: `✓ ${formatGb(check.remaining)} left`, color: statusVar('done') };
};

export function Delivery() {
  const { state } = useStore();
  return state.project && state.delivery ? <ProjectDelivery delivery={state.delivery} /> : <DemoDelivery />;
}

function DemoDelivery() {
  const { state, dispatch } = useStore();
  const chosen = state.packages.filter((pkg) => pkg.selected);
  const need = chosen.reduce((sum, pkg) => sum + pkg.gb, 0);
  const checks = state.deliveryDestinations.map((destination) => preflight(destination, need));
  const targets = checks.filter((check) => check.destination.selected);
  const short = targets.filter((check) => check.short);

  const blocker =
    chosen.length === 0
      ? 'Choose at least one package.'
      : targets.length === 0
        ? 'Choose at least one destination.'
        : short.length > 0
          ? `Not enough space on ${short.map((check) => check.destination.name).join(', ')} — deselect a package or choose another destination.`
          : null;

  const deliveredNow = state.delivered.length > 0 && state.delivered.length === chosen.length && chosen.every((pkg) => state.delivered.includes(pkg.id));

  return (
    <div className="screen out">
      <ScreenHeader
        step="output"
        eyebrow="06 · Output · Delivery"
        title="End-of-day delivery"
        description="Choose packages and destinations. Preflight checks capacity; every copy is verified and logged."
        actions={
          <label className="preset">
            <span className="label">Preset</span>
            <select aria-label="Delivery preset" value={state.deliveryPreset} onChange={() => undefined}>
              <option>{state.deliveryPreset}</option>
            </select>
          </label>
        }
      />

      <div className="delivery-cols">
        <section className="stack" aria-labelledby="pkg-head">
          <span className="label" id="pkg-head">
            1 · Packages
          </span>
          {state.packages.map((pkg) => (
            <label key={pkg.id} className={`card pick-card${pkg.selected ? ' on' : ''}`}>
              <Check checked={pkg.selected} onChange={() => dispatch({ type: 'togglePackage', id: pkg.id })} label={pkg.name} />
              <span className="grow stack gap-3">
                <span className="strong">{pkg.name}</span>
                <span className="muted small">{pkg.description}</span>
              </span>
              <span className="mono size">{formatGb(pkg.gb)}</span>
            </label>
          ))}
        </section>

        <section className="stack" aria-labelledby="dest-head">
          <span className="label" id="dest-head">
            2 · Destinations · Preflight
          </span>
          {checks.map((check) => {
            const { destination } = check;
            const capacity = capacityText(check);
            return (
              <label key={destination.id} className={`card pick-card dest${destination.selected ? ' on' : ''}${destination.selected && check.short ? ' short' : ''}`}>
                <span className="row">
                  <Check checked={destination.selected} onChange={() => dispatch({ type: 'toggleDeliveryDestination', id: destination.id })} label={destination.name} />
                  <span className="grow stack gap-3">
                    <span className="mono strong">{destination.name}</span>
                    <span className="muted small">{destination.kind}</span>
                  </span>
                  <span className="mono capacity" style={{ color: capacity.color }}>
                    {capacity.text}
                  </span>
                </span>
                {destination.selected ? (
                  <span className="fill" aria-hidden="true">
                    <span style={{ width: `${check.usePct}%`, background: capacity.color }} />
                  </span>
                ) : null}
              </label>
            );
          })}
        </section>
      </div>

      <section className="card delivery-summary row">
        <div className="grow stack gap-3">
          <span className="mono strong summary-title">
            {formatGb(need)} → {targets.length} destination{targets.length === 1 ? '' : 's'}
          </span>
          {deliveredNow ? (
            <span className="small" style={{ color: statusVar('done') }}>
              Copied and verified · checksum {state.production.checksum} · manifest written
            </span>
          ) : short.length > 0 ? (
            <span className="small" style={{ color: statusVar('problem') }}>
              Preflight failed: not enough space on {short.length} destination{short.length === 1 ? '' : 's'}. Deselect a package or change destination.
            </span>
          ) : blocker ? (
            <span className="small muted">{blocker}</span>
          ) : (
            <span className="small" style={{ color: statusVar('done') }}>
              Preflight passed · checksum {state.production.checksum} · manifest generated on completion
            </span>
          )}
        </div>
        {deliveredNow ? (
          <StatusText status="done" word={`Delivered · ${chosen.length} package${chosen.length === 1 ? '' : 's'} verified`} />
        ) : (
          <StartButton big disabledReason={blocker} onClick={() => dispatch({ type: 'deliver' })}>
            Deliver &amp; verify
          </StartButton>
        )}
      </section>

      <section className="card table-card">
        <div className="card-head">
          <h3>Delivery manifest · Day {String(state.day.number - 1).padStart(3, '0')}</h3>
          <button type="button" className="link small" title="Exports this manifest as a PDF and an ASC MHL">
            Download PDF / MHL
          </button>
        </div>
        <table className="grid mono manifest">
          <thead>
            <tr>
              <th className="label">Package</th>
              <th className="label">Destination</th>
              <th className="label">Files</th>
              <th className="label">Size</th>
              <th className="label">Completed</th>
              <th className="label">Verification</th>
            </tr>
          </thead>
          <tbody>
            {LAST_MANIFEST.map((row) => (
              <tr key={row.pkg}>
                <td className="sans">{row.pkg}</td>
                <td className="muted">{row.destination}</td>
                <td>{row.files}</td>
                <td>{row.size}</td>
                <td className="muted">{row.completed}</td>
                <td style={{ color: statusVar(row.retried ? 'needs' : 'done') }}>
                  {row.retried ? '↻' : '✓'} {row.verification}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ------------------------------------------------ the desktop app: the real drives

/** A destination's preflight: what it still needs of the chosen packages, and whether that fits. */
const placeCheck = (delivery: DeliveryState, place: DeliveryPlace) => {
  const need = deliveryNeed(delivery, delivery.settings.packages, place.id);
  if (place.freeBytes === null) return { need, short: true, text: 'not reachable', usePct: 0 };
  const left = place.freeBytes - need;
  const short = left < deliveryHeadroom(place.totalBytes ?? 0);
  return {
    need,
    short,
    text: short ? `✕ short ${formatBytes(Math.max(0, need + deliveryHeadroom(place.totalBytes ?? 0) - place.freeBytes))}` : `✓ ${formatBytes(left)} left`,
    usePct: place.freeBytes > 0 ? Math.min(100, (need / place.freeBytes) * 100) : 100,
  };
};

const clock = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-GB', { hour12: false });
};

const verification = (record: DeliveryRecord): { text: string; status: 'done' | 'needs' | 'problem' } => {
  const already = record.alreadyThere ? ` · ${record.alreadyThere.toLocaleString('en-US')} already there` : '';
  if (record.failed > 0) return { text: `✕ ${record.failed.toLocaleString('en-US')} not verified${already}`, status: 'problem' };
  if (record.retries > 0) return { text: `↻ ${record.retries} retr${record.retries === 1 ? 'y' : 'ies'} · Verified${already}`, status: 'needs' };
  return { text: `✓ Verified${already}`, status: 'done' };
};

function ProjectDelivery({ delivery }: { delivery: DeliveryState }) {
  const { state, dispatch } = useStore();
  const api = projectApi()!;
  const [notice, setNotice] = useState<string | null>(null);
  const [presetName, setPresetName] = useState<string | null>(null);
  const { settings } = delivery;

  const act = (call: Promise<ProjectResult>) =>
    void call.then((result) => {
      if (result.ok) {
        setNotice(null);
        dispatch({ type: 'projectState', project: result.state });
      } else if (result.reason) setNotice(result.reason);
    });

  // Look through the drives whenever the screen opens.
  useEffect(() => {
    void api.refreshDelivery();
  }, [api]);

  const parts = deliveryParts(settings.packages);
  const found = parts.reduce((sum, id) => sum + (delivery.parts.find((part) => part.id === id)?.bytes ?? 0), 0);
  const targets = delivery.places.filter((place) => settings.destinations.includes(place.id));
  const checks = new Map(delivery.places.map((place) => [place.id, placeCheck(delivery, place)]));
  const offline = targets.filter((place) => place.freeBytes === null);
  const short = targets.filter((place) => place.freeBytes !== null && checks.get(place.id)!.short);
  const need = targets.reduce((sum, place) => sum + checks.get(place.id)!.need, 0);
  const ready = delivery.scannedAt !== null;

  const blocker = delivery.activity
    ? 'A delivery is running.'
    : !ready
      ? 'Looking through the drives…'
      : settings.packages.length === 0
        ? 'Choose at least one package.'
        : found === 0
          ? 'None of the chosen packages has anything on the drives for this day yet.'
          : targets.length === 0
            ? 'Choose at least one destination.'
            : offline.length > 0
              ? `${offline.map((place) => place.name).join(', ')} cannot be reached.`
              : short.length > 0
                ? `Not enough space on ${short.map((place) => place.name).join(', ')} — deselect a package or choose another destination.`
                : null;

  const presetNow = settings.presets.find(
    (preset) =>
      preset.packages.length === settings.packages.length &&
      preset.packages.every((id) => settings.packages.includes(id)) &&
      (preset.destinations.length === 0 || (preset.destinations.length === settings.destinations.length && preset.destinations.every((id) => settings.destinations.includes(id)))),
  );

  const applyPreset = (name: string) => {
    const preset = settings.presets.find((candidate) => candidate.name === name);
    if (!preset) return;
    dispatch({ type: 'setDeliveryChoice', packages: preset.packages, destinations: preset.destinations.length ? preset.destinations : settings.destinations });
  };

  const savePreset = (event: FormEvent) => {
    event.preventDefault();
    const name = presetName?.trim();
    if (!name) return;
    const presets = [...settings.presets.filter((preset) => preset.name !== name), { name, packages: settings.packages, destinations: settings.destinations }];
    act(api.saveDelivery({ presets }));
    setPresetName(null);
  };

  const sourceOf = (id: (typeof DELIVERY_PACKAGES)[number]['id']) => {
    const names = [...new Set(DELIVERY_PACKAGES.find((pkg) => pkg.id === id)!.parts.map((part) => delivery.parts.find((candidate) => candidate.id === part)?.source).filter(Boolean))];
    return names.length ? `from ${names.join(', ')}` : null;
  };

  const records = delivery.records;
  const activity = delivery.activity;
  const progressPct = activity && activity.totalBytes > 0 ? Math.min(100, (activity.doneBytes / activity.totalBytes) * 100) : 0;

  return (
    <div className="screen out">
      <ScreenHeader
        step="output"
        eyebrow="06 · Output · Delivery"
        title="End-of-day delivery"
        description="Choose packages and destinations. Preflight checks capacity; every copy is verified and logged."
        actions={
          <div className="row gap-8">
            {presetName === null ? (
              <>
                <label className="preset">
                  <span className="label">Preset</span>
                  <select aria-label="Delivery preset" value={presetNow?.name ?? ''} onChange={(event) => applyPreset(event.target.value)}>
                    {!presetNow ? <option value="">Custom</option> : null}
                    {settings.presets.map((preset) => (
                      <option key={preset.name} value={preset.name}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>
                {!presetNow ? (
                  <button type="button" className="btn small" onClick={() => setPresetName('')}>
                    Save as preset…
                  </button>
                ) : null}
              </>
            ) : (
              <form className="row gap-8" onSubmit={savePreset}>
                <input className="input" aria-label="Preset name" placeholder="Preset name" autoFocus value={presetName} onChange={(event) => setPresetName(event.target.value)} />
                <button type="submit" className="btn small" disabled={!presetName.trim()}>
                  Save
                </button>
                <button type="button" className="btn ghost small" onClick={() => setPresetName(null)}>
                  Cancel
                </button>
              </form>
            )}
          </div>
        }
      />
      {notice || delivery.error ? (
        <p className="looks-notice" role="alert" style={tone(statusVar('problem'))}>
          {notice ?? delivery.error}
        </p>
      ) : null}

      <div className="delivery-cols">
        <section className="stack" aria-labelledby="pkg-head">
          <span className="label" id="pkg-head">
            1 · Packages
          </span>
          {DELIVERY_PACKAGES.map((pkg) => {
            const selected = settings.packages.includes(pkg.id);
            const size = packageBytes(delivery, pkg.id);
            const source = sourceOf(pkg.id);
            return (
              <label key={pkg.id} className={`card pick-card${selected ? ' on' : ''}`}>
                <Check checked={selected} onChange={() => dispatch({ type: 'togglePackage', id: pkg.id })} label={pkg.name} />
                <span className="grow stack gap-3">
                  <span className="strong">{pkg.name}</span>
                  <span className="muted small">{pkg.description}</span>
                  <span className="muted small">
                    {!ready ? 'Looking…' : size.files === 0 ? (pkg.id === 'edit' ? 'ALE and sync list written on delivery' : 'Nothing for this day yet') : `${size.files.toLocaleString('en-US')} files ${source ?? ''}`}
                  </span>
                </span>
                <span className="mono size">{ready ? formatBytes(size.bytes) : '—'}</span>
              </label>
            );
          })}
        </section>

        <section className="stack" aria-labelledby="dest-head">
          <span className="row">
            <span className="label grow" id="dest-head">
              2 · Destinations · Preflight
            </span>
            <button type="button" className="link small" disabled={delivery.scanning} onClick={() => act(api.refreshDelivery())}>
              {delivery.scanning ? 'Looking…' : 'Look again'}
            </button>
            <button type="button" className="link small" title="A NAS share, a vendor's upload folder, a folder on another drive" onClick={() => act(api.addDeliveryFolder())}>
              Add folder…
            </button>
          </span>
          {ready && delivery.places.length === 0 ? (
            <p className="muted small">No destination drives yet. Give a drive the Shuttle or Archive role on Intake, or add a folder.</p>
          ) : null}
          {delivery.places.map((place) => {
            const selected = settings.destinations.includes(place.id);
            const check = checks.get(place.id)!;
            const sourceFor = delivery.parts.filter((part) => part.sourceId === place.id && parts.includes(part.id));
            const color = !selected ? 'var(--label)' : check.short ? statusVar('problem') : statusVar('done');
            const folder = settings.folders.find((candidate) => candidate.id === place.id);
            return (
              <label key={place.id} className={`card pick-card dest${selected ? ' on' : ''}${selected && check.short ? ' short' : ''}`}>
                <span className="row">
                  <Check checked={selected} onChange={() => dispatch({ type: 'toggleDeliveryDestination', id: place.id })} label={place.name} />
                  <span className="grow stack gap-3">
                    <span className="mono strong">{place.name}</span>
                    <span className="muted small">
                      {place.kind} · {place.root}
                      {sourceFor.length ? ' · source of part of this delivery' : ''}
                    </span>
                  </span>
                  <span className="mono capacity" style={{ color }}>
                    {selected ? check.text : place.freeBytes === null ? 'not reachable' : `${formatBytes(place.freeBytes)} free`}
                  </span>
                  {folder ? (
                    <button type="button" className="btn ghost small" aria-label={`Remove ${place.name}`} onClick={() => act(api.removeDeliveryFolder(folder.id))}>
                      ×
                    </button>
                  ) : null}
                </span>
                {selected && place.freeBytes !== null ? (
                  <span className="fill" aria-hidden="true">
                    <span style={{ width: `${check.usePct}%`, background: color }} />
                  </span>
                ) : null}
              </label>
            );
          })}
        </section>
      </div>

      <section className="card delivery-summary row">
        <div className="grow stack gap-3">
          <span className="mono strong summary-title">
            {formatBytes(need)} → {targets.length} destination{targets.length === 1 ? '' : 's'}
          </span>
          {activity ? (
            <>
              <span className="small">
                {activity.label} · {formatBytes(activity.doneBytes)} of {formatBytes(activity.totalBytes)}
                {activity.bytesPerSecond > 0 ? ` · ${formatRate(activity.bytesPerSecond)} · ${formatEta((activity.totalBytes - activity.doneBytes) / activity.bytesPerSecond)}` : ''}
              </span>
              <span className="fill" role="progressbar" aria-label="Delivery progress" aria-valuenow={Math.round(progressPct)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${progressPct}%`, background: statusVar('working') }} />
              </span>
            </>
          ) : blocker ? (
            <span className="small" style={{ color: short.length || offline.length ? statusVar('problem') : undefined }}>
              {blocker}
            </span>
          ) : (
            <span className="small" style={{ color: statusVar('done') }}>
              Preflight passed · checksum {state.production.checksum} · originals checked against ingest · manifest written on each destination
            </span>
          )}
        </div>
        {activity ? (
          <button type="button" className="btn" onClick={() => act(api.stopDelivery())}>
            Stop
          </button>
        ) : (
          <StartButton big disabledReason={blocker} onClick={() => act(api.startDelivery())}>
            Deliver &amp; verify
          </StartButton>
        )}
      </section>

      <section className="card table-card">
        <div className="card-head">
          <h3>Delivery manifest · Day {String(state.day.number).padStart(3, '0')}</h3>
          <button type="button" className="link small" disabled={records.length === 0} title="Saves this manifest as a CSV" onClick={() => act(api.saveManifest())}>
            Save manifest…
          </button>
        </div>
        {records.length === 0 ? (
          <p className="muted small looks-empty">Nothing delivered today yet.</p>
        ) : (
          <table className="grid mono manifest">
            <thead>
              <tr>
                <th className="label">Package</th>
                <th className="label">Destination</th>
                <th className="label">Files</th>
                <th className="label">Size</th>
                <th className="label">Completed</th>
                <th className="label">Verification</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const result = verification(record);
                return (
                  <tr key={`${record.package}|${record.destinationId}`}>
                    <td className="sans">{record.packageName}</td>
                    <td className="muted">{record.destination}</td>
                    <td>{record.files.toLocaleString('en-US')}</td>
                    <td>{formatBytes(record.bytes)}</td>
                    <td className="muted">{clock(record.finishedAt)}</td>
                    <td style={{ color: statusVar(result.status) }} title={record.problems.map((problem) => `${problem.path}: ${problem.error}`).join('\n') || undefined}>
                      {result.text}
                    </td>
                    <td className="right">
                      {record.failed > 0 ? (
                        <button type="button" className="btn small" disabled={Boolean(activity)} onClick={() => act(api.retryDelivery(record.package, record.destinationId))}>
                          Retry {record.failed === 1 ? 'file' : 'files'}
                        </button>
                      ) : record.mhl ? (
                        <button type="button" className="link small" title={record.mhl} onClick={() => void api.showManifest(record.mhl!)}>
                          MHL
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
