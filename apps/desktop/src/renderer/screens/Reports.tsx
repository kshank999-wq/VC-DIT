import { jobState, STEPS } from '../model/status';
import { REPORTS } from '../model/demo';
import type { ReportRow, Status } from '../model/types';
import { useStore, type AppState, type ReportFilter } from '../state/store';
import { ScreenHeader, StatusText, stepVar, tone } from '../ui/kit';
import './ingest.css';

/**
 * Reports: every report the day has written (ASC MHL, script import, sync,
 * VFX, looks, delivery), filterable by step, each one a jump to the screen
 * it came from. Rows whose subject is still live (a card's transfer, the
 * script-log matches, sync) take their status from state, so Reports never
 * says something Verify, Match review or Sync disagrees with (spec §8).
 */

const FILTERS: { value: ReportFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'verify', label: 'Verify' },
  { value: 'organize', label: 'Organize' },
  { value: 'vfx', label: 'VFX' },
  { value: 'sync', label: 'Sync' },
  { value: 'output', label: 'Output' },
];

const STATUS: Record<ReportRow['status'], Status> = { Complete: 'done', 'Needs you': 'needs', Problem: 'problem' };

interface LiveRow extends ReportRow {
  tone: Status;
  word: string;
}

/** The demo's report list, with live status where the subject is still changing. */
const live = (state: AppState): LiveRow[] =>
  REPORTS.map((row) => {
    const base: LiveRow = { ...row, tone: STATUS[row.status], word: row.status };
    const card = /^Ingest verification — (.+)$/.exec(row.name)?.[1];
    const job = card ? state.jobs.find((candidate) => candidate.id === card) : undefined;
    if (job) {
      const now = jobState(job);
      const covers = `ASC MHL · ${job.files} · ${job.legs.length} destinations`;
      if (now === 'safe') return { ...base, status: 'Complete', tone: 'done', word: 'Complete', covers: row.status === 'Complete' ? row.covers : covers };
      if (now === 'running' || now === 'waiting') {
        const redo = job.legs.filter((leg) => leg.copyPct < 100 || leg.verifyPct < 100).map((leg) => leg.name);
        return { ...base, tone: 'working', word: 'In progress', covers: `Copying and checking · ${redo.join(', ')}` };
      }
      return base;
    }
    if (row.screen === 'match') {
      const open = state.matches.filter((match) => match.resolution === null).length;
      return open === 0 ? { ...base, status: 'Complete', tone: 'done', word: 'Complete' } : base;
    }
    if (row.step === 'sync') {
      const open = state.sync.filter((item) => !item.accepted).length;
      return open === 0 ? { ...base, status: 'Complete', tone: 'done', word: 'Complete' } : base;
    }
    return base;
  });

export function Reports() {
  const { state, dispatch } = useStore();
  const rows = live(state).filter((row) => state.reportFilter === 'all' || row.step === state.reportFilter);

  return (
    <div className="screen">
      <ScreenHeader
        eyebrow={`Reports · Day ${String(state.day.number).padStart(3, '0')}`}
        title="Reports & logs"
        description="Every copy, match, sync and delivery is recorded. Export any report for production or post."
        actions={
          <button type="button" className="btn primary" title="Writes every report and the day's ASC MHL files to 08_REPORTS">
            Export day package (PDF + MHL)
          </button>
        }
      />

      <div className="row wrap reports-filters" role="group" aria-label="Filter by step">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className="reports-filter"
            aria-pressed={state.reportFilter === filter.value}
            style={tone(filter.value === 'all' ? 'var(--text)' : stepVar(filter.value))}
            onClick={() => dispatch({ type: 'setReportFilter', filter: filter.value })}
          >
            <span className="reports-swatch" />
            {filter.label}
          </button>
        ))}
      </div>

      <div className="card reports-table">
        <table className="grid">
          <thead>
            <tr>
              <th className="label">Step</th>
              <th className="label">Report</th>
              <th className="label">Covers</th>
              <th className="label">Time</th>
              <th className="label">Status</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const step = STEPS.find((candidate) => candidate.id === row.step)!;
              return (
                <tr key={row.name}>
                  <td>
                    <span className="mono reports-step" style={tone(stepVar(row.step))}>
                      <span className="reports-swatch" />
                      {step.id === 'sync' ? 'Sync' : step.name}
                    </span>
                  </td>
                  <td className="reports-name">{row.name}</td>
                  <td className="muted">{row.covers}</td>
                  <td className="mono muted">{row.time}</td>
                  <td>
                    <StatusText status={row.tone} word={row.word} />
                  </td>
                  <td>
                    <div className="row reports-actions">
                      <button type="button" className="btn small" aria-label={`Open ${row.name}`} onClick={() => dispatch({ type: 'go', screen: row.screen })}>
                        Open
                      </button>
                      <button type="button" className="btn small" aria-label={`Export ${row.name}`} title="Writes PDF + CSV to 08_REPORTS">
                        Export
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No reports for this step yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
