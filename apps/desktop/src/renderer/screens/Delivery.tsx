import { LAST_MANIFEST } from '../model/demo';
import { formatGb } from '../model/status';
import type { DeliveryDestination } from '../model/types';
import { useStore } from '../state/store';
import { Check, ScreenHeader, StartButton, StatusText, statusVar } from '../ui/kit';
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
